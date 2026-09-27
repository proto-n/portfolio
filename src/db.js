import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.PORTFOLIO_DB || path.resolve('data/portfolio.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS crypto_holdings (
  id INTEGER PRIMARY KEY,
  asset TEXT NOT NULL,            -- ETH, DOGE, ZEC
  yahoo_symbol TEXT NOT NULL,     -- ETH-USD
  amount REAL NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bonds (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,             -- e.g. PMÁP 2029/J
  isin TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL CHECK (currency IN ('HUF','EUR')),
  nominal REAL NOT NULL,
  yield_pct REAL NOT NULL,        -- current coupon / yield, % p.a.
  maturity TEXT NOT NULL,         -- YYYY-MM-DD
  purchase_date TEXT,
  price_pct REAL NOT NULL DEFAULT 100,  -- clean price as % of nominal
  coupon_freq INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,      -- tbsz2025, tbsz2026, cash
  kind TEXT NOT NULL DEFAULT 'tbsz',
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS account_cash (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (account_id, currency)
);

CREATE TABLE IF NOT EXISTS instruments (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,    -- VWCE
  name TEXT NOT NULL DEFAULT '',
  yahoo_symbol TEXT,              -- VWCE.DE (null => manual_price)
  currency TEXT NOT NULL,         -- EUR / USD / ...
  manual_price REAL
);

CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  quantity REAL NOT NULL,         -- negative = sell
  price REAL NOT NULL,            -- per unit, instrument currency
  fees REAL NOT NULL DEFAULT 0,   -- instrument currency
  huf_rate REAL,                  -- instrument ccy -> HUF on that date (auto-filled)
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  underlying TEXT NOT NULL DEFAULT 'XSP',
  right TEXT NOT NULL DEFAULT 'P' CHECK (right IN ('P','C')),
  strike REAL NOT NULL,
  expiry TEXT NOT NULL,           -- YYYY-MM-DD
  contracts REAL NOT NULL DEFAULT 1,
  multiplier REAL NOT NULL DEFAULT 100,
  purchase_date TEXT NOT NULL,
  purchase_price REAL NOT NULL,   -- per share (quote), USD
  underlying_at_purchase REAL,    -- auto-filled from history if null
  fees REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

-- nightly trajectory, one row per position per day
CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT NOT NULL,
  kind TEXT NOT NULL,             -- crypto | bond | ibkr | cash | option
  ref TEXT NOT NULL,              -- stable key of the position
  label TEXT NOT NULL,
  value_native REAL,
  currency TEXT,
  value_huf REAL NOT NULL,
  PRIMARY KEY (date, kind, ref)
);

CREATE TABLE IF NOT EXISTS option_snapshots (
  date TEXT NOT NULL,
  option_id INTEGER NOT NULL,
  underlying REAL NOT NULL,
  mid REAL NOT NULL,
  iv REAL,
  PRIMARY KEY (date, option_id)
);

CREATE TABLE IF NOT EXISTS price_cache (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`);

// migrations: identity of rows created by the IBKR importer, so re-imports are idempotent
for (const t of ['lots', 'options']) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'source_key')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN source_key TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_source_key ON ${t}(source_key)`);
  }
}
// bonds: a price quoted by the custodian (MÁK) that already includes accrued interest
const bondCols = db.prepare('PRAGMA table_info(bonds)').all().map((c) => c.name);
if (!bondCols.includes('price_dirty')) db.exec('ALTER TABLE bonds ADD COLUMN price_dirty INTEGER NOT NULL DEFAULT 0');
if (!bondCols.includes('price_date')) db.exec('ALTER TABLE bonds ADD COLUMN price_date TEXT');
if (!bondCols.includes('source_key')) {
  db.exec('ALTER TABLE bonds ADD COLUMN source_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bonds_source_key ON bonds(source_key)');
}
db.exec('CREATE TABLE IF NOT EXISTS imported_keys (key TEXT PRIMARY KEY, at TEXT NOT NULL)');

const DEFAULT_SETTINGS = {
  crypto_keep_ratio: '0.85',   // value after tax
  risk_free_rate: '0.04',      // for Black-Scholes
  dividend_yield: '0.012',     // S&P 500 dividend yield
  // put-sell trigger: any one of these fires it
  trigger_drawdown: '0.25',    // S&P 500 down this much from its 52-week high
  trigger_vix: '40',           // VIX at or above
  trigger_value_multiple: '3', // put worth this many times its cost (at bid)
  vix_calm: '15',              // VIX level that counts as 0 on the gauge
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}

// first-run seed of structure (no holdings)
if (db.prepare('SELECT COUNT(*) c FROM accounts').get().c === 0) {
  const ins = db.prepare('INSERT INTO accounts (name, kind) VALUES (?, ?)');
  ins.run('tbsz2025', 'tbsz');
  ins.run('tbsz2026', 'tbsz');
  ins.run('cash', 'cash');
  const inst = db.prepare('INSERT INTO instruments (ticker, name, yahoo_symbol, currency) VALUES (?, ?, ?, ?)');
  inst.run('VWCE', 'Vanguard FTSE All-World Acc', 'VWCE.DE', 'EUR');
  inst.run('FOLOW', 'BNP Paribas Easy Managed Futures', 'FOLOW.PA', 'EUR');
}

export function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = Number(r.value);
  return out;
}

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
