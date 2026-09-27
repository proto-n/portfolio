import express from 'express';
import crypto from 'node:crypto';
import { db, all, get, run } from './src/db.js';
import { buildReport, rollAnalysis } from './src/report.js';
import { recordSnapshot, scheduleNightly } from './src/snapshot.js';
import { importIbkrCsv } from './src/import-ibkr.js';
import { importMakXls } from './src/import-mak.js';

const PORT = Number(process.env.PORT || 3000);
const USER = process.env.PORTFOLIO_USER || 'me';
const PASS = process.env.PORTFOLIO_PASSWORD;
// Without a password we only listen on localhost.
const HOST = process.env.HOST || (PASS ? '0.0.0.0' : '127.0.0.1');

const app = express();
app.use(express.json());

if (PASS) {
  const expected = Buffer.from(`${USER}:${PASS}`);
  app.use((req, res, next) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    const got = m ? Buffer.from(Buffer.from(m[1], 'base64').toString()) : Buffer.alloc(0);
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="portfolio"').status(401).send('Auth required');
  });
}

app.use(express.static('public'));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(400).json({ error: e.message });
});

// ---- pre-built report, refreshed in the background so page loads are instant ----
const REFRESH_MS = Number(process.env.REFRESH_MINUTES || 10) * 60 * 1000;
let latest = null;          // last built report
let rolls = {};             // option id -> roll analysis
let generation = 0;         // bumped on every data change; stale builds are discarded
let building = null;

function refresh() {
  if (building) return building;
  const gen = generation;
  building = (async () => {
    try {
      const report = await buildReport();
      const r = {};
      for (const a of report.ibkr.accounts) for (const o of a.options) {
        try { r[o.id] = await rollAnalysis(o.id); } catch { /* shown as unavailable */ }
      }
      if (gen === generation) { latest = report; rolls = r; }
    } catch (e) {
      console.error('[refresh]', e.message);
    } finally {
      building = null;
    }
  })();
  return building;
}

// any write through the API invalidates the pre-built report
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') { generation++; latest = null; rolls = {}; }
  next();
});

app.get('/api/report', wrap(async (req, res) => {
  while (!latest) { await refresh(); if (!latest) await buildReport().then((r) => { latest = r; }); }
  res.json(latest);
}));

app.get('/api/options/:id/roll', wrap(async (req, res) => {
  const id = Number(req.params.id);
  res.json(rolls[id] ?? (rolls[id] = await rollAnalysis(id)));
}));

app.get('/api/history', wrap(async (req, res) => {
  const rows = all(`SELECT date, kind, SUM(value_huf) v FROM snapshots GROUP BY date, kind ORDER BY date`);
  const byDate = {};
  for (const r of rows) (byDate[r.date] ??= { date: r.date })[r.kind] = r.v;
  res.json(Object.values(byDate));
}));

app.get('/api/history/:ref', wrap(async (req, res) => {
  res.json(all('SELECT date, value_native, value_huf FROM snapshots WHERE ref = ? ORDER BY date', req.params.ref));
}));

app.post('/api/import/ibkr', express.text({ type: '*/*', limit: '20mb' }), wrap(async (req, res) => res.json(importIbkrCsv(req.body))));

app.post('/api/import/mak', express.raw({ type: '*/*', limit: '20mb' }), wrap(async (req, res) => res.json(importMakXls(req.body))));

app.post('/api/snapshot', wrap(async (req, res) => res.json(await recordSnapshot())));

// ---- generic CRUD over whitelisted tables/columns ----
const TABLES = {
  crypto: { table: 'crypto_holdings', cols: ['asset', 'yahoo_symbol', 'amount', 'location', 'note'] },
  bonds: { table: 'bonds', cols: ['name', 'isin', 'currency', 'nominal', 'yield_pct', 'maturity', 'purchase_date', 'price_pct', 'price_dirty', 'price_date', 'coupon_freq', 'note'] },
  accounts: { table: 'accounts', cols: ['name', 'kind', 'note'] },
  instruments: { table: 'instruments', cols: ['ticker', 'name', 'yahoo_symbol', 'currency', 'manual_price'] },
  lots: { table: 'lots', cols: ['account_id', 'instrument_id', 'date', 'quantity', 'price', 'fees', 'huf_rate', 'note'] },
  options: { table: 'options', cols: ['account_id', 'underlying', 'right', 'strike', 'expiry', 'contracts', 'multiplier', 'purchase_date', 'purchase_price', 'underlying_at_purchase', 'fees', 'note'] },
};

const clean = (cols, body) => {
  const out = {};
  for (const c of cols) if (c in body) out[c] = body[c] === '' ? null : body[c];
  return out;
};

for (const [name, { table, cols }] of Object.entries(TABLES)) {
  app.get(`/api/${name}`, wrap((req, res) => res.json(all(`SELECT * FROM ${table} ORDER BY id`))));
  app.post(`/api/${name}`, wrap((req, res) => {
    const v = clean(cols, req.body);
    const keys = Object.keys(v);
    const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => v[k]));
    res.json(get(`SELECT * FROM ${table} WHERE id = ?`, r.lastInsertRowid));
  }));
  app.put(`/api/${name}/:id`, wrap((req, res) => {
    const v = clean(cols, req.body);
    // changing a lot's date/instrument invalidates its stored FX rate
    if (name === 'lots' && !('huf_rate' in req.body) && ('date' in v || 'instrument_id' in v)) v.huf_rate = null;
    if (name === 'options' && !('underlying_at_purchase' in req.body) && 'purchase_date' in v) v.underlying_at_purchase = null;
    const keys = Object.keys(v);
    if (keys.length) run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map((k) => v[k]), req.params.id);
    res.json(get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id));
  }));
  app.delete(`/api/${name}/:id`, wrap((req, res) => {
    run(`DELETE FROM ${table} WHERE id = ?`, req.params.id);
    res.json({ ok: true });
  }));
}

// cash balances: upsert per (account, currency); amount 0 deletes
app.get('/api/cash', wrap((req, res) => res.json(all('SELECT * FROM account_cash'))));
app.put('/api/cash', wrap((req, res) => {
  const { account_id, currency, amount } = req.body;
  if (!Number(amount)) run('DELETE FROM account_cash WHERE account_id = ? AND currency = ?', account_id, currency);
  else run('INSERT OR REPLACE INTO account_cash (account_id, currency, amount) VALUES (?, ?, ?)', account_id, currency.toUpperCase(), Number(amount));
  res.json({ ok: true });
}));

app.get('/api/settings', wrap((req, res) => res.json(all('SELECT * FROM settings'))));
app.put('/api/settings', wrap((req, res) => {
  for (const [k, v] of Object.entries(req.body)) run('UPDATE settings SET value = ? WHERE key = ?', String(v), k);
  res.json({ ok: true });
}));

app.listen(PORT, HOST, () => {
  console.log(`portfolio on http://${HOST}:${PORT}${PASS ? '' : ' (no PORTFOLIO_PASSWORD set: localhost only)'}`);
  if (process.env.NO_SCHEDULER !== '1') scheduleNightly();
  refresh();
  setInterval(refresh, REFRESH_MS);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
