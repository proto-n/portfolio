// Import an IBKR "Transaction History" CSV (Performance & Reports > Transaction History).
// Any period works (e.g. the last 7 days); re-importing overlapping periods is safe. Cash needs
// one full-history export (from account opening) first, so the ledger has every past movement.
import fs from 'node:fs';
import { db, get, all, run, getMeta, setMeta } from './db.js';
import { yahooFindSymbol } from './prices.js';

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

const FX_TRANSLATION = 'FX Translations P&L'; // period-dependent revaluation, not a transaction
// Referral-bonus IBKR shares, auto-sold to cover account fees: not a position we track.
// Their cash effects (sale proceeds, dividends) still count toward cash.
const IGNORED_SYMBOLS = new Set(['IBKR']);

// "September 22, 2026 - September 28, 2026" -> 2026-09-28
function periodEnd(period) {
  const d = new Date(String(period || '').split(' - ').pop());
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('sv-SE');
}

// Any Transaction History export works — full history or the last 7 days, overlapping or not.
// Every row is stored once in ibkr_ledger (keyed by its content + occurrence number, so two
// identical fills on the same day stay two rows); positions and cash are rebuilt from the ledger.
export async function importIbkrCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const section = (name) => Object.fromEntries(lines.filter((l) => l[0] === name && l[1] === 'Data').map((l) => [l[2], l[3]]));
  const summary = section('Summary');
  const statement = section('Statement');
  if ((summary['Base Currency'] || 'HUF') !== 'HUF') throw new Error(`Base currency is ${summary['Base Currency']}, expected HUF`);
  const header = lines.find((l) => l[0] === 'Transaction History' && l[1] === 'Header');
  if (!header) throw new Error('No "Transaction History" section found — is this an IBKR Transaction History CSV?');
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const rows = lines.filter((l) => l[0] === 'Transaction History' && l[1] === 'Data').map((l) => ({
    date: l[col.Date], account: l[col.Account], desc: l[col.Description], type: l[col['Transaction Type']],
    symbol: l[col.Symbol], qty: num(l[col.Quantity]), price: num(l[col.Price]), ccy: l[col['Price Currency']],
    gross: num(l[col['Gross Amount']]) ?? 0, commission: num(l[col.Commission]) ?? 0, net: num(l[col['Net Amount']]) ?? 0,
  }));
  const end = periodEnd(statement.Period) ?? rows.map((r) => r.date).sort().pop();
  const fullHistory = Number(summary['Starting Cash'] || 0) === 0;

  const report = { period: statement.Period, new_transactions: 0, already_imported: 0, lots: [], options: [], cash: {}, created: [], skipped: [] };

  // unknown instruments: look up their Yahoo symbol before opening the transaction (network)
  const isTrade = (r) => (r.type === 'Buy' || r.type === 'Sell') && r.qty && !IGNORED_SYMBOLS.has(r.symbol);
  // (only tickers actually bought: sells of positions acquired outside IBKR's history are skipped)
  const newTickers = [...new Set(rows.filter((r) => isTrade(r) && r.type === 'Buy' && !parseOcc(r.symbol)).map((r) => r.symbol))]
    .filter((t) => !get('SELECT 1 FROM instruments WHERE ticker = ?', t));
  const found = {};
  for (const t of newTickers) {
    const r = rows.find((x) => x.symbol === t && x.type === 'Buy');
    found[t] = { name: r.desc, ccy: r.ccy, yahoo: await yahooFindSymbol(t, r.ccy) };
  }

  db.exec('BEGIN');
  try {
    // ---- 1. ledger ----
    const seen = {};
    const fresh = [];
    const ins = db.prepare(`INSERT OR IGNORE INTO ibkr_ledger (key, date, account, type, description, symbol, qty, price, ccy, gross, commission, net, imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    for (const r of rows) {
      if (r.desc === FX_TRANSLATION) continue;
      const base = [r.date, r.account, r.type, r.desc, r.symbol, r.qty, r.price, r.net.toFixed(2)].join('|');
      seen[base] = (seen[base] || 0) + 1;
      const key = `${base}#${seen[base]}`;
      const res = ins.run(key, r.date, r.account, r.type, r.desc, r.symbol, r.qty, r.price, r.ccy, r.gross, r.commission, r.net, now);
      if (res.changes) { fresh.push(r); report.new_transactions++; } else report.already_imported++;
    }

    for (const [t, f] of Object.entries(found)) {
      run('INSERT INTO instruments (ticker, name, yahoo_symbol, currency) VALUES (?, ?, ?, ?)', t, f.name, f.yahoo, f.ccy);
      report.created.push(f.yahoo ? `instrument ${t} (prices from Yahoo ${f.yahoo})` : `instrument ${t}: no Yahoo symbol found, set one in Manage → Instruments`);
    }

    // ---- 2. options: apply newly seen trades ----
    for (const r of fresh.filter((t) => isTrade(t) && parseOcc(t.symbol))) {
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
        report.options.push(`${r.date} bought ${r.qty} ${r.symbol.replace(/\s+/g, ' ')} @ ${r.price}`);
      } else {
        // closing / rolling: reduce the matching open position
        const open = get('SELECT * FROM options WHERE underlying=? AND right=? AND strike=? AND expiry=? AND account_id=? ORDER BY purchase_date LIMIT 1',
          o.underlying, o.right, o.strike, o.expiry, acc.id);
        if (!open) { report.skipped.push(`${r.date} sell ${r.symbol}: no open position`); continue; }
        const left = open.contracts + r.qty;
        if (left <= 0) run('DELETE FROM options WHERE id = ?', open.id);
        else run('UPDATE options SET contracts = ? WHERE id = ?', left, open.id);
        report.options.push(`${r.date} sold ${-r.qty} ${r.symbol.replace(/\s+/g, ' ')} @ ${r.price}`);
      }
    }

    // ---- 3. stock/ETF lots: one per (date, account, symbol, side), rebuilt from the ledger ----
    const touched = new Set(fresh.filter((t) => isTrade(t) && !parseOcc(t.symbol)).map((t) => [t.date, t.account, t.symbol, t.type].join('\u0000')));
    for (const g of touched) {
      const [date, account, symbol, type] = g.split('\u0000');
      const fills = all(`SELECT * FROM ibkr_ledger WHERE date=? AND account=? AND symbol=? AND type=? AND qty IS NOT NULL`, date, account, symbol, type);
      const key = `ibkr:${date}:${account}:${symbol}:${type}`;
      const qty = fills.reduce((s, f) => s + f.qty, 0);
      const cost = fills.reduce((s, f) => s + f.qty * f.price, 0);
      const gross = fills.reduce((s, f) => s + f.gross, 0);
      const commission = fills.reduce((s, f) => s + f.commission, 0);
      if (type === 'Sell' && !get("SELECT 1 FROM ibkr_ledger WHERE symbol = ? AND type = 'Buy'", symbol)
          && !get('SELECT 1 FROM lots l JOIN instruments i ON i.id = l.instrument_id WHERE i.ticker = ? AND l.quantity > 0', symbol)) {
        report.skipped.push(`${date} sell ${-qty} ${symbol} (${account}): no purchase on record`);
        continue;
      }
      let inst = get('SELECT * FROM instruments WHERE ticker = ?', symbol);
      if (!inst) { // only if the pre-lookup missed it
        run('INSERT INTO instruments (ticker, name, currency) VALUES (?, ?, ?)', symbol, fills[0].description, fills[0].ccy);
        inst = get('SELECT * FROM instruments WHERE ticker = ?', symbol);
      }
      const acc = resolveAccount(account, report.created);
      const price = cost / qty;                         // weighted average, instrument currency
      const rate = Math.abs(gross) / Math.abs(cost);    // instrument ccy -> HUF actually used
      const fees = Math.abs(commission) / rate;
      const note = fills.length > 1 ? `IBKR import (${fills.length} fills)` : 'IBKR import';
      const v = [acc.id, inst.id, date, qty, price, fees, rate, note, key];
      if (get('SELECT id FROM lots WHERE source_key = ?', key)) {
        run('UPDATE lots SET account_id=?, instrument_id=?, date=?, quantity=?, price=?, fees=?, huf_rate=?, note=? WHERE source_key=?', ...v);
      } else {
        run('INSERT INTO lots (account_id, instrument_id, date, quantity, price, fees, huf_rate, note, source_key) VALUES (?,?,?,?,?,?,?,?,?)', ...v);
      }
      report.lots.push(`${date} ${acc.name}: ${type === 'Buy' ? 'bought' : 'sold'} ${+Math.abs(qty).toFixed(6)} ${symbol} @ ${price.toFixed(4)} ${inst.currency}`);
    }

    // ---- 4. cash (HUF base) = ledger sums per account + FX translation true-up ----
    if (fullHistory) setMeta('ibkr_ledger_complete', '1');
    if (getMeta('ibkr_ledger_complete') !== '1') {
      report.skipped.push('Cash not updated yet: upload a full-history export (from account opening) once, after that any 7-day export works');
    } else {
      // IBKR's ending cash is authoritative; the gap to our ledger is FX translation of non-HUF
      // balances (held on the main account). Only a statement at least as recent may reset it.
      const ending = num(summary['Ending Cash']);
      const asOf = getMeta('ibkr_cash_asof');
      if (ending != null && end && (!asOf || end >= asOf)) {
        const ledgerTotal = get('SELECT COALESCE(SUM(net), 0) s FROM ibkr_ledger WHERE date <= ?', end).s;
        setMeta('ibkr_fx_adjust', ending - ledgerTotal);
        setMeta('ibkr_cash_asof', end);
      }
      const adjust = Number(getMeta('ibkr_fx_adjust') || 0);
      const main = resolveAccount('main', report.created);
      for (const { account, s } of all('SELECT account, SUM(net) s FROM ibkr_ledger GROUP BY account')) {
        const acc = resolveAccount(account, report.created);
        const amount = s + (acc.id === main.id ? adjust : 0);
        run('INSERT OR REPLACE INTO account_cash (account_id, currency, amount) VALUES (?, ?, ?)', acc.id, 'HUF', Math.round(amount * 100) / 100);
        report.cash[acc.name] = Math.round(amount);
      }
      report.cash_as_of = getMeta('ibkr_cash_asof');
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
  importIbkrCsv(fs.readFileSync(f, 'utf8')).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
}
