// Import a Magyar Államkincstár (MÁK / Kincstár) portfolio export (portfolio.xls).
// Rows with a nominal value become bonds, keyed by instrument name. Re-importing refreshes
// nominal and price; maturity / yield / notes you edited are kept.
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { db, get, run } from './db.js';
import { today } from './calc.js';

const n = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s|%/g, '');
  // "1,234,567.89" or Hungarian "1234567,89" (single comma not followed by exactly 3 digits)
  if (/^-?\d+,\d+$/.test(s) && !/,\d{3}$/.test(s)) return Number(s.replace(',', '.'));
  return Number(s.replace(/,/g, ''));
};
const huDate = (s) => {
  const m = /(\d{4})\.\s*(\d{2})\.\s*(\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export function importMakXls(buf, { priceDate = today() } = {}) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: '' });
  if (!rows.length || !('Instrumentum' in rows[0])) throw new Error('Not a MÁK portfolio export (no "Instrumentum" column)');

  const report = { bonds: [], created: [], ignored: [], needs_attention: [] };
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const name = String(r.Instrumentum).trim();
      const nominal = n(r['Névérték']);
      const ccy = String(r.Devizanem || '').trim().toUpperCase();
      if (!nominal || !['HUF', 'EUR'].includes(ccy)) {
        report.ignored.push(`${name} ${r['Összeg'] || ''}`.trim());
        continue;
      }
      const pricePct = n(r['Árfolyam']);
      const key = `mak:${name}`;
      const existing = get('SELECT * FROM bonds WHERE source_key = ?', key);
      if (existing) {
        run('UPDATE bonds SET nominal = ?, currency = ?, price_pct = ?, price_dirty = 1, price_date = ? WHERE id = ?', nominal, ccy, pricePct, priceDate, existing.id);
      } else {
        // maturity guess: year from the name ("… 2030/M10") + day/month of the next payment date
        const next = huDate(r['Következő esedékességfizetés időpontja']);
        const year = /(\d{4})\//.exec(name)?.[1];
        const maturity = year && next ? `${year}${next.slice(4)}` : next || `${year || '2099'}-12-31`;
        run(`INSERT INTO bonds (name, currency, nominal, yield_pct, maturity, price_pct, price_dirty, price_date, coupon_freq, note, source_key)
             VALUES (?, ?, ?, 0, ?, ?, 1, ?, 1, 'MÁK import', ?)`, name, ccy, nominal, maturity, pricePct, priceDate, key);
        report.created.push(name);
        report.needs_attention.push(`${name}: check maturity (${maturity}, guessed) and set the current coupon in Manage → Bonds`);
      }
      report.bonds.push({ name, currency: ccy, nominal, price_pct: pricePct, market_value_in_file: n(r['Piaci érték']) });
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
  if (!f) { console.error('usage: npm run import-mak -- portfolio.xls [YYYY-MM-DD price date]'); process.exit(1); }
  console.log(JSON.stringify(importMakXls(fs.readFileSync(f), { priceDate: process.argv[3] || today() }), null, 2));
}
