// Market data: Yahoo Finance (ETFs, crypto, FX, index history) and marketdata.app
// option quotes. Everything is cached in SQLite; on fetch failure we fall back to
// the last cached value and mark it stale.
import net from 'node:net';
import { db } from './db.js';

// Node's default 250ms per-address connect attempt is too short on slow/IPv6-flaky links.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const UA = { 'User-Agent': 'Mozilla/5.0 (portfolio-tracker)' };
const QUOTE_TTL = 10 * 60 * 1000;
// Option prices only change while US markets are open, so outside those hours there's no
// point spending API credits on them.
function usMarketOpen(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 9 * 60 + 30 && m <= 16 * 60 + 30; // + slack for the 15-min delay
}
const chainTtl = () => (usMarketOpen() ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000);

// ttl: milliseconds, or a function of the cached value returning milliseconds.
async function cached(key, ttl, fetcher) {
  const row = db.prepare('SELECT json, ts FROM price_cache WHERE key = ?').get(key);
  if (row && Date.now() - row.ts < (typeof ttl === 'function' ? ttl(JSON.parse(row.json)) : ttl)) return { ...JSON.parse(row.json), stale: false };
  try {
    const val = await fetcher();
    db.prepare('INSERT OR REPLACE INTO price_cache (key, json, ts) VALUES (?, ?, ?)').run(key, JSON.stringify(val), Date.now());
    return { ...val, stale: false };
  } catch (e) {
    console.warn(`[prices] ${key}: ${e.message}`);
    if (row) return { ...JSON.parse(row.json), stale: true, asOfTs: row.ts };
    return null;
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export function yahooQuote(symbol) {
  return cached(`yq:${symbol}`, QUOTE_TTL, async () => {
    const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
    const m = j?.chart?.result?.[0]?.meta;
    if (!m || m.regularMarketPrice == null) throw new Error('no price in response');
    return { price: m.regularMarketPrice, currency: m.currency, time: m.regularMarketTime * 1000 };
  });
}

// Find the Yahoo symbol for an exchange ticker (e.g. MFEH -> MFEH.DE) that trades in `currency`.
export async function yahooFindSymbol(ticker, currency) {
  let quotes = [];
  try {
    const j = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=15&newsCount=0`);
    quotes = j.quotes || [];
  } catch (e) {
    console.warn(`[prices] symbol search ${ticker}: ${e.message}`);
    return null;
  }
  const pref = ['DE', 'AS', 'PA', 'MI', 'SW', 'L', ''];
  const rank = (sym) => { const i = pref.indexOf(sym.includes('.') ? sym.split('.').pop() : ''); return i < 0 ? 99 : i; };
  const cands = quotes
    .filter((q) => q.symbol && q.symbol.split('.')[0].toUpperCase() === ticker.toUpperCase() && ['ETF', 'EQUITY', 'MUTUALFUND'].includes(q.quoteType))
    .sort((a, b) => rank(a.symbol) - rank(b.symbol));
  for (const c of cands) {
    const q = await yahooQuote(c.symbol);
    if (q && q.currency === currency) return c.symbol;
  }
  return null;
}

// Highest daily high over the past year (for drawdown). Cached 1 hour.
export function yahoo52wHigh(symbol) {
  return cached(`y52:${symbol}`, 60 * 60 * 1000, async () => {
    const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`);
    const res = j?.chart?.result?.[0];
    const highs = (res?.indicators?.quote?.[0]?.high || []).filter((x) => x != null);
    if (!highs.length) throw new Error('no history');
    return { price: Math.max(...highs, res.meta.regularMarketPrice ?? 0) };
  });
}

// Close on the given date, or the last trading day before it. Cached forever.
export async function yahooCloseOn(symbol, date) {
  const r = await cached(`yh:${symbol}:${date}`, Infinity, async () => {
    const end = Math.floor(new Date(date + 'T23:59:59Z').getTime() / 1000);
    const start = end - 10 * 86400;
    const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`);
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp || [];
    const closes = res?.indicators?.quote?.[0]?.close || [];
    for (let i = ts.length - 1; i >= 0; i--) {
      if (closes[i] != null) return { price: closes[i], date: new Date(ts[i] * 1000).toISOString().slice(0, 10) };
    }
    throw new Error('no history');
  });
  return r?.price ?? null;
}

// FX to HUF. HUF itself = 1.
export async function hufRate(ccy) {
  if (ccy === 'HUF') return { price: 1 };
  return yahooQuote(`${ccy}HUF=X`);
}
export async function hufRateOn(ccy, date) {
  if (ccy === 'HUF') return 1;
  return yahooCloseOn(`${ccy}HUF=X`, date);
}

export function occSymbol(o) {
  const d = o.expiry.replace(/-/g, '').slice(2);
  const strike = String(Math.round(o.strike * 1000)).padStart(8, '0');
  return `${o.underlying}${d}${o.right}${strike}`;
}

// ---------- marketdata.app options (CBOE's free delayed feed is blocked since 2026-11-19) ----------
// Token in MARKETDATA_TOKEN. Free/trial plans only ever get the last closed session; paid plans
// get 15-min delayed quotes, and mode=cached prices a whole chain at 1 credit instead of 1/contract.
async function md(path, params = {}) {
  const token = process.env.MARKETDATA_TOKEN;
  if (!token) throw new Error('MARKETDATA_TOKEN not set');
  const res = await fetch(`https://api.marketdata.app/v1${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  if (res.status === 204) return null; // mode=cached miss
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.s !== 'ok') throw new Error(`marketdata ${path}: HTTP ${res.status} ${j?.errmsg || j?.s || ''}`);
  const cols = Object.keys(j).filter((k) => Array.isArray(j[k])); // columnar -> rows
  return j[cols[0]].map((_, i) => Object.fromEntries(cols.map((k) => [k, j[k][i]])));
}

function mdContract(r) {
  const m = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(r.optionSymbol);
  return {
    symbol: r.optionSymbol, expiry: `20${m[1]}-${m[2]}-${m[3]}`, strike: r.strike,
    bid: r.bid, ask: r.ask, last_trade_price: r.last, iv: r.iv, delta: r.delta, open_interest: r.openInterest,
  };
}

// Quotes for the contracts we hold: 1 credit per contract.
export function optionQuotes(underlying, symbols) {
  return cached(`md:${[...symbols].sort().join(',')}`, () => (usMarketOpen() ? QUOTE_TTL : 6 * 3600e3), async () => {
    const contracts = {};
    let S = null, updated = 0;
    for (const s of symbols) {
      const [r] = (await md(`/options/quotes/${s}/`)) || [];
      if (!r) continue;
      contracts[s] = mdContract(r);
      S = r.underlyingPrice; updated = Math.max(updated, r.updated);
    }
    if (!Object.keys(contracts).length) throw new Error('no quotes');
    return { underlying: S, updatedTs: updated * 1000, timestamp: new Date(updated * 1000).toISOString(), contracts };
  });
}

// Long-dated contracts of one type (P/C) with strikes within 40%-110% of spot, for roll analysis.
// That's ~1,300 contracts: 1 credit with mode=cached (paid plans), ~1,300 credits without, so
// without cached mode (free/trial: last-session data anyway) refresh at most every 6 hours.
export function longDatedChain(underlying, right, minExpiry, spot) {
  const ttl = (v) => (v.cachedMode ? chainTtl() : 6 * 3600e3);
  return cached(`md-long:${underlying}:${right}`, ttl, async () => {
    const params = {
      side: right === 'P' ? 'put' : 'call', from: minExpiry, minBid: 0.01,
      strike: `${Math.floor(spot * 0.4)}-${Math.ceil(spot * 1.1)}`,
    };
    let rows = null, cachedMode = true;
    try { rows = await md(`/options/chain/${underlying}/`, { ...params, mode: 'cached' }); } catch { /* 402: plan has no cached mode */ }
    if (!rows) { cachedMode = false; rows = await md(`/options/chain/${underlying}/`, params); }
    const contracts = rows.map(mdContract).filter((c) => c.expiry >= minExpiry && c.bid > 0 && c.ask > 0);
    const updated = Math.max(...rows.map((r) => r.updated));
    return { underlying: rows[0]?.underlyingPrice, updatedTs: updated * 1000, timestamp: new Date(updated * 1000).toISOString(), cachedMode, contracts };
  });
}

// Historical index level, for when the user didn't enter the underlying at purchase.
export async function underlyingOn(underlying, date) {
  const direct = await yahooCloseOn(`^${underlying}`, date);
  if (direct != null) return direct;
  if (underlying === 'XSP') {
    const spx = await yahooCloseOn('^GSPC', date);
    return spx != null ? spx / 10 : null;
  }
  return null;
}
