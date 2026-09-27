// Market data: Yahoo Finance (ETFs, crypto, FX, index history) and CBOE delayed
// option quotes. Everything is cached in SQLite; on fetch failure we fall back to
// the last cached value and mark it stale.
import net from 'node:net';
import { db } from './db.js';

// Node's default 250ms per-address connect attempt is too short on slow/IPv6-flaky links.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const UA = { 'User-Agent': 'Mozilla/5.0 (portfolio-tracker)' };
const QUOTE_TTL = 10 * 60 * 1000;
// The delayed option file only changes while US markets are open, so outside those hours
// there's no point re-downloading its ~7 MB.
function usMarketOpen(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 9 * 60 + 30 && m <= 16 * 60 + 30; // + slack for the 15-min delay
}
const chainTtl = () => (usMarketOpen() ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000);

async function cached(key, ttl, fetcher) {
  const row = db.prepare('SELECT json, ts FROM price_cache WHERE key = ?').get(key);
  if (row && Date.now() - row.ts < ttl) return { ...JSON.parse(row.json), stale: false };
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

// CBOE delayed chain (~7 MB); we only keep the underlying and the contracts we hold.
export function occSymbol(o) {
  const d = o.expiry.replace(/-/g, '').slice(2);
  const strike = String(Math.round(o.strike * 1000)).padStart(8, '0');
  return `${o.underlying}${d}${o.right}${strike}`;
}

// Raw chain download (~7 MB), shared briefly in memory so parallel callers fetch once.
const rawChains = new Map();
function cboeRaw(underlying) {
  const hit = rawChains.get(underlying);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const idx = ['SPX', 'XSP', 'NDX', 'RUT', 'VIX'].includes(underlying) ? `_${underlying}` : underlying;
  const promise = getJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${idx}.json`);
  promise.catch(() => rawChains.delete(underlying));
  rawChains.set(underlying, { at: Date.now(), promise });
  return promise;
}

export async function cboeOptions(underlying, symbols) {
  const key = `cboe:${underlying}:${[...symbols].sort().join(',')}`;
  return cached(key, chainTtl(), async () => {
    const j = await cboeRaw(underlying);
    const want = new Set(symbols);
    const contracts = {};
    for (const o of j.data.options) if (want.has(o.option)) contracts[o.option] = o;
    return { underlying: j.data.current_price, timestamp: j.timestamp, iv30: j.data.iv30, contracts };
  });
}

// Long-dated contracts of one type (P/C) with strikes within 40%-110% of spot, for roll analysis.
export async function cboeLongDated(underlying, right, minExpiry) {
  return cached(`cboe-long:${underlying}:${right}:${minExpiry}`, chainTtl(), async () => {
    const j = await cboeRaw(underlying);
    const S = j.data.current_price;
    const re = new RegExp(`^${underlying}(\\d{2})(\\d{2})(\\d{2})${right}(\\d{8})$`);
    const contracts = [];
    for (const o of j.data.options) {
      const m = re.exec(o.option);
      if (!m) continue;
      const expiry = `20${m[1]}-${m[2]}-${m[3]}`, strike = Number(m[4]) / 1000;
      if (expiry < minExpiry || strike < S * 0.4 || strike > S * 1.1 || !(o.bid > 0 && o.ask > 0)) continue;
      contracts.push({ symbol: o.option, expiry, strike, bid: o.bid, ask: o.ask, open_interest: o.open_interest });
    }
    return { underlying: S, timestamp: j.timestamp, contracts };
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
