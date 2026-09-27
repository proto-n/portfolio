// Pure math: dates, XIRR, Black-Scholes, bond accrual.

export const DAY = 86400000;
export const today = () => new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
export const parseDate = (s) => new Date(s + 'T00:00:00Z');
export const daysBetween = (a, b) => (parseDate(b) - parseDate(a)) / DAY;

// flows: [{date: 'YYYY-MM-DD', amount}] (negative = money in, positive = money out)
// Returns the annual rate r such that NPV = 0, i.e. the fixed yearly yield of a
// single hypothetical instrument bought with exactly these amounts on these dates.
export function xirr(flows) {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const t0 = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0].date);
  const ts = flows.map((f) => ({ t: daysBetween(t0, f.date) / 365, a: f.amount }));
  if (Math.max(...ts.map((x) => x.t)) < 1 / 365) return null;
  const npv = (r) => ts.reduce((s, x) => s + x.a / Math.pow(1 + r, x.t), 0);
  // bisection on (-0.9999, 100) — robust and plenty precise here
  let lo = -0.9999, hi = 100;
  let flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-9) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// ---------- Black-Scholes (with continuous dividend yield) ----------
function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
const normPdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

export function bs({ S, K, T, sigma, r, q, right }) {
  if (T <= 0 || sigma <= 0) {
    const intrinsic = right === 'P' ? Math.max(K - S, 0) : Math.max(S - K, 0);
    return { price: intrinsic, delta: right === 'P' ? (S < K ? -1 : 0) : (S > K ? 1 : 0), gamma: 0, vega: 0, theta: 0 };
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T);
  let price, delta, theta;
  if (right === 'P') {
    price = K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
    delta = -dfq * normCdf(-d1);
    theta = -S * dfq * normPdf(d1) * sigma / (2 * sq) + r * K * dfr * normCdf(-d2) - q * S * dfq * normCdf(-d1);
  } else {
    price = S * dfq * normCdf(d1) - K * dfr * normCdf(d2);
    delta = dfq * normCdf(d1);
    theta = -S * dfq * normPdf(d1) * sigma / (2 * sq) - r * K * dfr * normCdf(d2) + q * S * dfq * normCdf(d1);
  }
  return {
    price, delta,
    gamma: dfq * normPdf(d1) / (S * sigma * sq),
    vega: S * dfq * normPdf(d1) * sq / 100,   // per 1 vol point
    theta: theta / 365,                        // per calendar day
  };
}

export function impliedVol(price, p) {
  let lo = 0.001, hi = 5;
  if (bs({ ...p, sigma: hi }).price < price) return null;
  if (bs({ ...p, sigma: lo }).price > price) return lo;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bs({ ...p, sigma: mid }).price > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Decompose option value change between two states into time / spot / vol.
// Shapley attribution: average marginal effect over all 6 orderings, so the
// three parts sum exactly to the model change and don't depend on order.
export function attribute(a, b, base) {
  // a, b: {S, T, sigma}; base: {K, r, q, right}
  const val = (useS, useT, useV) =>
    bs({ ...base, S: useS ? b.S : a.S, T: useT ? b.T : a.T, sigma: useV ? b.sigma : a.sigma }).price;
  const perms = [['S','T','V'],['S','V','T'],['T','S','V'],['T','V','S'],['V','S','T'],['V','T','S']];
  const contrib = { S: 0, T: 0, V: 0 };
  for (const p of perms) {
    const done = { S: false, T: false, V: false };
    for (const f of p) {
      const before = val(done.S, done.T, done.V);
      done[f] = true;
      contrib[f] += (val(done.S, done.T, done.V) - before) / perms.length;
    }
  }
  return { spot: contrib.S, time: contrib.T, vol: contrib.V, total: val(true, true, true) - val(false, false, false) };
}

// ---------- bonds ----------
function addMonths(d, m) {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
}

// Coupon schedule is assumed to run backwards from maturity at 12/freq month steps.
export function lastCouponDate(maturity, freq, asOf) {
  const step = 12 / (freq || 1);
  let d = parseDate(maturity);
  const now = parseDate(asOf);
  while (d > now) d = addMonths(d, -step);
  return d.toISOString().slice(0, 10);
}

export function bondValue(b, asOf = today()) {
  const matured = asOf >= b.maturity;
  const quoted = b.nominal * (b.price_pct ?? 100) / 100;
  if (matured) return { clean: quoted, accrued: 0, total: quoted, lastCoupon: null };
  const lc = lastCouponDate(b.maturity, b.coupon_freq, asOf);
  const y = (b.yield_pct || 0) / 100;
  if (b.price_dirty && b.price_date) {
    // Price already includes accrued interest as of price_date: roll it forward by the
    // interest accrued since, minus any coupon paid out in between.
    const couponsPaid = lc > b.price_date ? countCoupons(b, b.price_date, asOf) : 0;
    const total = quoted + b.nominal * y * daysBetween(b.price_date, asOf) / 365 - couponsPaid * b.nominal * y / (b.coupon_freq || 1);
    const accrued = b.nominal * y * daysBetween(lc, asOf) / 365;
    return { clean: total - accrued, accrued, total, lastCoupon: lc };
  }
  // accrued runs from the last coupon date regardless of purchase date (accrued is paid on purchase)
  const accrued = b.nominal * y * daysBetween(lc, asOf) / 365;
  return { clean: quoted, accrued, total: quoted + accrued, lastCoupon: lc };
}

// coupon dates in (from, to]
function countCoupons(b, from, to) {
  let n = 0;
  let d = lastCouponDate(b.maturity, b.coupon_freq, to);
  while (d > from) { n++; d = lastCouponDate(b.maturity, b.coupon_freq, new Date(parseDate(d) - DAY).toISOString().slice(0, 10)); }
  return n;
}
