// Import an IBKR "Transaction History" CSV (Reports > Statements > Transaction History).
// Export from account inception each time: purchases are merged per day/account/instrument
// and upserted by key, and cash balances are recomputed from the full history.
import fs from 'node:fs';
import { db, get, run } from './db.js';

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s) => (s == null || s === '-' || s === '' ? null : Number(s));

// "TBSZ-2025" -> tbsz2025 account; the main account (masked "U***…") -> the cash account
function resolveAccount(ibkrName, created) {
  const m = /^TBSZ-(\d{4})$/i.exec(ibkrName);
  const name = m ? `tbsz${m[1]}` : null;
  let acc = name ? get('SELECT * FROM accounts WHERE name = ?', name) : get("SELECT * FROM accounts WHERE kind = 'cash' ORDER BY id LIMIT 1");
  if (!acc) {
    run('INSERT INTO accounts (name, kind) VALUES (?, ?)', name || 'cash', name ? 'tbsz' : 'cash');
    acc = get('SELECT * FROM accounts WHERE name = ?', name || 'cash');
    created.push(`account ${acc.name}`);
  }
  return acc;
}

// "XSP   271217P00600000" -> OCC option parts
function parseOcc(sym) {
  const m = /^([A-Z]+)\s+(\d{2})(\d{2})(\d{2})([PC])(\d{8})$/.exec(sym.trim());
  if (!m) return null;
  return { underlying: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5], strike: Number(m[6]) / 1000 };
}

export function importIbkrCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const summary = Object.fromEntries(lines.filter((l) => l[0] === 'Summary' && l[1] === 'Data').map((l) => [l[2], l[3]]));
  if ((summary['Base Currency'] || 'HUF') !== 'HUF') throw new Error(`Base currency is ${summary['Base Currency']}, expected HUF`);
  const header = lines.find((l) => l[0] === 'Transaction History' && l[1] === 'Header');
  if (!header) throw new Error('No "Transaction History" section found');
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const rows = lines.filter((l) => l[0] === 'Transaction History' && l[1] === 'Data').map((l) => ({
    date: l[col.Date], account: l[col.Account], desc: l[col.Description], type: l[col['Transaction Type']],
    symbol: l[col.Symbol], qty: num(l[col.Quantity]), price: num(l[col.Price]), ccy: l[col['Price Currency']],
    gross: num(l[col['Gross Amount']]) ?? 0, commission: num(l[col.Commission]) ?? 0, net: num(l[col['Net Amount']]) ?? 0,
  }));

  const report = { lots: 0, options: 0, cash: {}, created: [], skipped: [] };
  const trades = rows.filter((r) => (r.type === 'Buy' || r.type === 'Sell') && r.qty);

  db.exec('BEGIN');
  try {
    // ---- options ----
    for (const r of trades.filter((t) => parseOcc(t.symbol))) {
      const o = parseOcc(r.symbol);
      const acc = resolveAccount(r.account, report.created);
      const mult = 100;
      const rate = Math.abs(r.gross) / (Math.abs(r.qty) * r.price * mult); // USD->HUF on the day
      const key = `ibkr:${r.date}:${r.account}:${r.symbol.replace(/\s+/g, ' ')}:${r.qty}:${r.price}`;
      if (r.type === 'Buy') {
        const v = [acc.id, o.underlying, o.right, o.strike, o.expiry, r.qty, mult, r.date, r.price, Math.abs(r.commission) / rate, key];
        if (get('SELECT id FROM options WHERE source_key = ?', key)) {
          run(`UPDATE options SET account_id=?, underlying=?, right=?, strike=?, expiry=?, contracts=?, multiplier=?, purchase_date=?, purchase_price=?, fees=? WHERE source_key=?`, ...v);
        } else {
          run(`INSERT INTO options (account_id, underlying, right, strike, expiry, contracts, multiplier, purchase_date, purchase_price, fees, source_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ...v);
        }
        report.options++;
      } else if (!get('SELECT key FROM imported_keys WHERE key = ?', key)) {
        // closing / rolling: reduce the matching open position
        const open = get('SELECT * FROM options WHERE underlying=? AND right=? AND strike=? AND expiry=? AND account_id=? ORDER BY purchase_date LIMIT 1',
          o.underlying, o.right, o.strike, o.expiry, acc.id);
        if (!open) { report.skipped.push(`${r.date} sell ${r.symbol}: no open position`); continue; }
        const left = open.contracts + r.qty;
        if (left <= 0) run('DELETE FROM options WHERE id = ?', open.id);
        else run('UPDATE options SET contracts = ? WHERE id = ?', left, open.id);
        run('INSERT INTO imported_keys (key, at) VALUES (?, ?)', key, new Date().toISOString());
        report.options++;
      }
    }

    // ---- stock/ETF trades, merged per (date, account, symbol, side) ----
    const groups = new Map();
    for (const r of trades.filter((t) => !parseOcc(t.symbol))) {
      const k = `ibkr:${r.date}:${r.account}:${r.symbol}:${r.type}`;
      const g = groups.get(k) ?? { ...r, qty: 0, cost: 0, gross: 0, commission: 0, n: 0 };
      g.qty += r.qty; g.cost += r.qty * r.price; g.gross += r.gross; g.commission += r.commission; g.n++;
      groups.set(k, g);
    }
    // quantities held per symbol (in this file) — sells of positions acquired outside it are skipped
    const bought = {};
    for (const g of groups.values()) if (g.type === 'Buy') bought[g.symbol] = true;

    for (const [key, g] of groups) {
      if (g.type === 'Sell' && !bought[g.symbol] && !get('SELECT 1 FROM lots l JOIN instruments i ON i.id = l.instrument_id WHERE i.ticker = ? AND l.quantity > 0', g.symbol)) {
        report.skipped.push(`${g.date} sell ${-g.qty} ${g.symbol} (${g.account}): no purchase on record`);
        continue;
      }
      let inst = get('SELECT * FROM instruments WHERE ticker = ?', g.symbol);
      if (!inst) {
        run('INSERT INTO instruments (ticker, name, currency) VALUES (?, ?, ?)', g.symbol, g.desc, g.ccy);
        inst = get('SELECT * FROM instruments WHERE ticker = ?', g.symbol);
        report.created.push(`instrument ${g.symbol} (set its Yahoo symbol in Manage → Instruments)`);
      }
      const acc = resolveAccount(g.account, report.created);
      const price = g.cost / g.qty;                     // weighted average, instrument currency
      const rate = Math.abs(g.gross) / Math.abs(g.cost); // instrument ccy -> HUF actually used
      const fees = Math.abs(g.commission) / rate;
      const note = g.n > 1 ? `IBKR import (${g.n} fills)` : 'IBKR import';
      const v = [acc.id, inst.id, g.date, g.qty, price, fees, rate, note, key];
      if (get('SELECT id FROM lots WHERE source_key = ?', key)) {
        run('UPDATE lots SET account_id=?, instrument_id=?, date=?, quantity=?, price=?, fees=?, huf_rate=?, note=? WHERE source_key=?', ...v);
      } else {
        run('INSERT INTO lots (account_id, instrument_id, date, quantity, price, fees, huf_rate, note, source_key) VALUES (?,?,?,?,?,?,?,?,?)', ...v);
      }
      report.lots++;
    }

    // ---- cash: full-history sum of net amounts per account (base currency HUF) ----
    if (Number(summary['Starting Cash'] || 0) === 0) {
      const byAcc = {};
      for (const r of rows) byAcc[r.account] = (byAcc[r.account] || 0) + r.net;
      for (const [name, amount] of Object.entries(byAcc)) {
        const acc = resolveAccount(name, report.created);
        run('INSERT OR REPLACE INTO account_cash (account_id, currency, amount) VALUES (?, ?, ?)', acc.id, 'HUF', Math.round(amount * 100) / 100);
        report.cash[acc.name] = Math.round(amount);
      }
    } else {
      report.skipped.push('Cash balances not updated: statement does not start from account inception (Starting Cash ≠ 0)');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.argv[2];
  if (!f) { console.error('usage: npm run import-ibkr -- <file.csv>'); process.exit(1); }
  console.log(JSON.stringify(importIbkrCsv(fs.readFileSync(f, 'utf8')), null, 2));
}
