import { all, get, run, getSettings } from './db.js';
import { today, daysBetween, xirr, bs, impliedVol, attribute, bondValue } from './calc.js';
import { yahooQuote, yahoo52wHigh, hufRate, hufRateOn, cboeOptions, cboeLongDated, occSymbol, underlyingOn } from './prices.js';

export async function buildReport() {
  const settings = getSettings();
  const warnings = [];
  const asOf = today();

  const fx = {};
  for (const c of ['USD', 'EUR']) {
    const q = await hufRate(c);
    if (!q) warnings.push(`No ${c}/HUF rate available`);
    else if (q.stale) warnings.push(`${c}/HUF rate is stale (cached)`);
    fx[c] = q?.price ?? null;
  }
  fx.HUF = 1;
  const toHuf = async (amount, ccy) => {
    if (fx[ccy] === undefined) fx[ccy] = (await hufRate(ccy))?.price ?? null;
    return fx[ccy] == null ? null : amount * fx[ccy];
  };

  const crypto = await buildCrypto(settings, toHuf, warnings);
  const bonds = await buildBonds(asOf, toHuf);
  const ibkr = await buildIbkr(asOf, settings, fx, toHuf, warnings);

  const totals = {
    crypto_huf: crypto.total_huf,
    crypto_after_tax_huf: crypto.total_after_tax_huf,
    bonds_huf: bonds.total_huf,
    ibkr_huf: ibkr.total_huf,
  };
  totals.total_huf = totals.crypto_huf + totals.bonds_huf + totals.ibkr_huf;
  totals.total_after_crypto_tax_huf = totals.crypto_after_tax_huf + totals.bonds_huf + totals.ibkr_huf;

  return { asOf, generatedAt: new Date().toISOString(), fx, settings, totals, crypto, bonds, ibkr, warnings };
}

async function buildCrypto(settings, toHuf, warnings) {
  const rows = [];
  for (const h of all('SELECT * FROM crypto_holdings ORDER BY asset, location')) {
    const q = await yahooQuote(h.yahoo_symbol);
    if (!q) warnings.push(`No price for ${h.yahoo_symbol}`);
    else if (q.stale) warnings.push(`${h.yahoo_symbol} price is stale`);
    const price = q?.price ?? 0;
    const value_usd = h.amount * price;
    const value_huf = (await toHuf(value_usd, 'USD')) ?? 0;
    rows.push({ ...h, price_usd: price, value_usd, value_huf, after_tax_huf: value_huf * settings.crypto_keep_ratio });
  }
  // per-asset subtotals (same coin in multiple places)
  const byAsset = {};
  for (const r of rows) {
    const a = (byAsset[r.asset] ??= { asset: r.asset, amount: 0, value_usd: 0, value_huf: 0, after_tax_huf: 0, price_usd: r.price_usd });
    a.amount += r.amount; a.value_usd += r.value_usd; a.value_huf += r.value_huf; a.after_tax_huf += r.after_tax_huf;
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return {
    rows, byAsset: Object.values(byAsset),
    total_usd: sum('value_usd'), total_huf: sum('value_huf'), total_after_tax_huf: sum('after_tax_huf'),
  };
}

async function buildBonds(asOf, toHuf) {
  const rows = [];
  for (const b of all('SELECT * FROM bonds ORDER BY maturity')) {
    const v = bondValue(b, asOf);
    rows.push({
      ...b, clean: v.clean, accrued: v.accrued, last_coupon: v.lastCoupon,
      value_native: v.total, value_huf: (await toHuf(v.total, b.currency)) ?? 0,
      days_to_maturity: Math.round(daysBetween(asOf, b.maturity)),
    });
  }
  const byCcy = {};
  for (const r of rows) byCcy[r.currency] = (byCcy[r.currency] || 0) + r.value_native;
  return { rows, byCurrency: byCcy, total_huf: rows.reduce((s, r) => s + r.value_huf, 0) };
}

// ---------- IBKR ----------
async function instrumentPrice(inst, warnings) {
  if (inst.yahoo_symbol) {
    const q = await yahooQuote(inst.yahoo_symbol);
    if (q) {
      if (q.stale) warnings.push(`${inst.ticker} price is stale`);
      return q.price;
    }
  }
  if (inst.manual_price != null) return inst.manual_price;
  warnings.push(`No price for ${inst.ticker}`);
  return null;
}

async function ensureLotRate(lot, ccy) {
  if (lot.huf_rate != null) return lot.huf_rate;
  const r = await hufRateOn(ccy, lot.date);
  if (r != null) run('UPDATE lots SET huf_rate = ? WHERE id = ?', r, lot.id);
  return r;
}

// Money-weighted stats for a set of lots (all same instrument or mixed if hufOnly).
function lotStats(lots, asOf, { valueNative, valueHuf }) {
  const flowsN = [], flowsH = [];
  let cost = 0, costHuf = 0, netN = 0, netH = 0, hufOk = true;
  for (const l of lots) {
    const amt = l.quantity > 0 ? -(l.quantity * l.price + l.fees) : (-l.quantity * l.price - l.fees);
    flowsN.push({ date: l.date, amount: amt });
    netN += amt;
    if (l.quantity > 0) cost += -amt;
    if (l.huf_rate == null) hufOk = false;
    else {
      flowsH.push({ date: l.date, amount: amt * l.huf_rate });
      netH += amt * l.huf_rate;
      if (l.quantity > 0) costHuf += -amt * l.huf_rate;
    }
  }
  const out = { cost, cost_huf: hufOk ? costHuf : null };
  if (valueNative != null) {
    out.value = valueNative;
    out.gain = valueNative + netN;
    out.return_pct = cost ? out.gain / cost : null;
    out.xirr = xirr([...flowsN, { date: asOf, amount: valueNative }]);
  }
  if (valueHuf != null && hufOk) {
    out.value_huf = valueHuf;
    out.gain_huf = valueHuf + netH;
    out.return_pct_huf = costHuf ? out.gain_huf / costHuf : null;
    out.xirr_huf = xirr([...flowsH, { date: asOf, amount: valueHuf }]);
  }
  return out;
}

async function buildIbkr(asOf, settings, fx, toHuf, warnings) {
  const accounts = all('SELECT * FROM accounts ORDER BY kind DESC, name');
  const instruments = Object.fromEntries(all('SELECT * FROM instruments').map((i) => [i.id, i]));
  const prices = {};
  for (const i of Object.values(instruments)) prices[i.id] = await instrumentPrice(i, warnings);

  const allLots = all('SELECT * FROM lots ORDER BY date, id');
  for (const l of allLots) l.huf_rate = await ensureLotRate(l, instruments[l.instrument_id].currency);

  const out = [];
  const byInstrument = {};
  for (const acc of accounts) {
    const lots = allLots.filter((l) => l.account_id === acc.id);
    const positions = [];
    for (const instId of [...new Set(lots.map((l) => l.instrument_id))]) {
      const inst = instruments[instId];
      const il = lots.filter((l) => l.instrument_id === instId);
      const qty = il.reduce((s, l) => s + l.quantity, 0);
      const price = prices[instId];
      const value = price == null ? null : qty * price;
      const value_huf = value == null ? null : await toHuf(value, inst.currency);
      const st = lotStats(il, asOf, { valueNative: value, valueHuf: value_huf });
      const lotRows = [];
      for (const l of il) {
        if (l.quantity <= 0 || price == null) { lotRows.push({ ...l }); continue; }
        const lv = l.quantity * price;
        lotRows.push({ ...l, ...lotStats([l], asOf, { valueNative: lv, valueHuf: await toHuf(lv, inst.currency) }) });
      }
      positions.push({ instrument: inst, quantity: qty, price, avg_cost: st.cost / il.filter((l) => l.quantity > 0).reduce((s, l) => s + l.quantity, 0), ...st, lots: lotRows });
      (byInstrument[instId] ??= { instrument: inst, lots: [], price }).lots.push(...il);
    }

    const cash = [];
    for (const c of all('SELECT * FROM account_cash WHERE account_id = ?', acc.id)) {
      cash.push({ ...c, value_huf: (await toHuf(c.amount, c.currency)) ?? 0 });
    }

    const options = [];
    for (const o of all('SELECT * FROM options WHERE account_id = ?', acc.id)) {
      options.push(await analyzeOption(o, asOf, settings, toHuf, warnings));
    }

    const posHuf = positions.reduce((s, p) => s + (p.value_huf ?? 0), 0);
    const cashHuf = cash.reduce((s, c) => s + c.value_huf, 0);
    const optHuf = options.reduce((s, o) => s + (o.value_huf ?? 0), 0);
    // account-level yield (in HUF, since instruments may be in different currencies)
    const accStats = lots.length ? lotStats(lots, asOf, { valueNative: null, valueHuf: posHuf }) : {};
    // if all instruments share a currency, also give native-currency account yield
    const ccys = [...new Set(lots.map((l) => instruments[l.instrument_id].currency))];
    let native = null;
    if (ccys.length === 1 && positions.every((p) => p.value != null)) {
      native = { currency: ccys[0], ...lotStats(lots, asOf, { valueNative: positions.reduce((s, p) => s + p.value, 0) }) };
    }
    out.push({
      ...acc, positions, cash, options,
      positions_huf: posHuf, cash_huf: cashHuf, options_huf: optHuf,
      value_huf: posHuf + cashHuf + optHuf,
      stats_huf: accStats, stats_native: native,
    });
  }

  // cross-account per-instrument
  const instrumentsSummary = [];
  for (const b of Object.values(byInstrument)) {
    const qty = b.lots.reduce((s, l) => s + l.quantity, 0);
    const value = b.price == null ? null : qty * b.price;
    instrumentsSummary.push({
      instrument: b.instrument, quantity: qty, price: b.price,
      ...lotStats(b.lots, asOf, { valueNative: value, valueHuf: value == null ? null : await toHuf(value, b.instrument.currency) }),
    });
  }

  return { accounts: out, instruments: instrumentsSummary, total_huf: out.reduce((s, a) => s + a.value_huf, 0) };
}

// ---------- options ----------
async function analyzeOption(o, asOf, settings, toHuf, warnings) {
  const sym = occSymbol(o);
  const base = { K: o.strike, r: settings.risk_free_rate, q: settings.dividend_yield, right: o.right };
  const n = o.multiplier * o.contracts;
  const res = { ...o, symbol: sym };

  if (o.underlying_at_purchase == null) {
    const s0 = await underlyingOn(o.underlying, o.purchase_date);
    if (s0 != null) { run('UPDATE options SET underlying_at_purchase = ? WHERE id = ?', s0, o.id); o.underlying_at_purchase = s0; res.underlying_at_purchase = s0; }
    else warnings.push(`Could not look up ${o.underlying} on ${o.purchase_date}; enter it manually`);
  }

  const chain = await cboeOptions(o.underlying, [sym]);
  const c = chain?.contracts?.[sym];
  if (!c) { warnings.push(`No quote for ${sym}`); return res; }
  if (chain.stale) warnings.push(`${sym} quote is stale`);

  const S = chain.underlying;
  const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : (c.theo || c.last_trade_price);
  const T = Math.max(daysBetween(asOf, o.expiry), 0) / 365;
  const sigma = impliedVol(mid, { ...base, S, T }) ?? c.iv;
  const g = bs({ ...base, S, T, sigma });

  Object.assign(res, {
    quote: { bid: c.bid, ask: c.ask, mid, last: c.last_trade_price, cboe_iv: c.iv, cboe_delta: c.delta, timestamp: chain.timestamp },
    underlying_price: S,
    otm_pct: o.right === 'P' ? (S - o.strike) / S : (o.strike - S) / S,
    dte: Math.round(T * 365),
    iv: sigma,
    iv30_index: chain.iv30,
    greeks: { delta: g.delta, gamma: g.gamma, theta_day_usd: g.theta * n, vega_usd: g.vega * n, delta_usd_per_1pct: g.delta * S * 0.01 * n },
    cost_usd: o.purchase_price * n + o.fees,
    value_usd: mid * n,
    protected_notional_usd: o.strike * n,
  });
  res.pnl_usd = res.value_usd - res.cost_usd;
  res.value_huf = await toHuf(res.value_usd, 'USD');
  // value relative to what was paid, in USD and in HUF (HUF cost at the purchase-day rate)
  res.value_pct_of_cost = res.value_usd / res.cost_usd;
  const buyRate = await hufRateOn('USD', o.purchase_date);
  if (buyRate != null && res.value_huf != null) {
    res.cost_huf = res.cost_usd * buyRate;
    res.value_pct_of_cost_huf = res.value_huf / res.cost_huf;
  }

  // what-if: instant index moves, at current IV and with a vol spike
  res.trigger = await sellTrigger(o, res, c, settings, toHuf, warnings);

  res.scenarios = [-0.1, -0.2, -0.3, -0.4].map((m) => {
    const S2 = S * (1 + m);
    return {
      move: m,
      at_current_iv: bs({ ...base, S: S2, T, sigma }).price * n,
      iv_plus_10: bs({ ...base, S: S2, T, sigma: sigma + 0.10 }).price * n,
      at_expiry: Math.max(o.right === 'P' ? o.strike - S2 : S2 - o.strike, 0) * n,
    };
  });

  const now = { S, T, sigma };
  const scale = (a) => a && ({ spot: a.spot * n, time: a.time * n, vol: a.vol * n, total: a.total * n });
  res.attribution = {};

  if (o.underlying_at_purchase != null) {
    const T0 = daysBetween(o.purchase_date, o.expiry) / 365;
    const sigma0 = impliedVol(o.purchase_price, { ...base, S: o.underlying_at_purchase, T: T0 });
    res.iv_at_purchase = sigma0;
    if (sigma0 != null) {
      res.attribution.since_purchase = { from: o.purchase_date, ...scale(attribute({ S: o.underlying_at_purchase, T: T0, sigma: sigma0 }, now, base)) };
      // "Remaining insurance": the put repriced at today's index level and time left, but with the
      // IV it was bought at, as % of the purchase price. 100 on purchase day; volatility can't move it.
      const S0 = o.underlying_at_purchase, P0 = o.purchase_price;
      res.insurance = {
        index: bs({ ...base, S, T, sigma: sigma0 }).price / P0 * 100,
        time_only: bs({ ...base, S: S0, T, sigma: sigma0 }).price / P0 * 100,
        spot_only: bs({ ...base, S, T: T0, sigma: sigma0 }).price / P0 * 100,
      };
    }
  }

  // vs. recorded nightly snapshots
  const snaps = all('SELECT * FROM option_snapshots WHERE option_id = ? AND date < ? ORDER BY date DESC', o.id, asOf);
  const pick = (days) => snaps.find((s) => daysBetween(s.date, asOf) >= days);
  for (const [label, days] of [['1d', 1], ['7d', 7], ['30d', 30]]) {
    const s = pick(days);
    if (!s || s.iv == null) continue;
    const Ts = daysBetween(s.date, o.expiry) / 365;
    res.attribution[label] = { from: s.date, ...scale(attribute({ S: s.underlying, T: Ts, sigma: s.iv }, now, base)) };
  }
  return res;
}

// Put-sell trigger: sell into the panic, before a quick rebound takes the gain back.
// Each component is 0 (calm) .. 1 (its threshold reached); the gauge is the closest one.
async function sellTrigger(o, res, c, settings, toHuf, warnings) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const [spx, high, vix] = await Promise.all([yahooQuote('^GSPC'), yahoo52wHigh('^GSPC'), yahooQuote('^VIX')]);
  if (!spx || !high) warnings.push('S&P 500 history unavailable for the sell trigger');
  if (!vix) warnings.push('VIX unavailable for the sell trigger');
  const drawdown = spx && high ? 1 - spx.price / high.price : null;
  const n = o.multiplier * o.contracts;
  const saleUsd = c.bid * n - o.fees;                 // what selling now would bring
  const multiple = saleUsd / res.cost_usd;
  const components = [
    { key: 'drawdown', label: 'S&P 500 drawdown from 52w high', value: drawdown, threshold: settings.trigger_drawdown,
      score: drawdown == null ? null : clamp(drawdown / settings.trigger_drawdown) },
    { key: 'vix', label: 'VIX', value: vix?.price ?? null, threshold: settings.trigger_vix,
      score: vix ? clamp((vix.price - settings.vix_calm) / (settings.trigger_vix - settings.vix_calm)) : null },
    { key: 'multiple', label: 'Put value vs. cost (at bid)', value: multiple, threshold: settings.trigger_value_multiple,
      score: clamp((multiple - 1) / (settings.trigger_value_multiple - 1)) },
  ];
  const scores = components.map((x) => x.score).filter((x) => x != null);
  const gauge = Math.round(100 * Math.max(0, ...scores));
  return {
    gauge, fired: gauge >= 100,
    state: gauge >= 100 ? 'SELL ZONE' : gauge >= 70 ? 'Close' : gauge >= 40 ? 'Stress' : 'Calm',
    components, spx: spx?.price, spx_high: high?.price,
    sale_usd: saleUsd, sale_huf: await toHuf(saleUsd, 'USD'),
  };
}

// ---------- roll analysis: "top the insurance back up to 100" ----------
// The insurance index prices a put with volatility held at the purchase-time regime. For a new
// contract we take its market IV today and shift it by how much the vol level moved since
// purchase (old contract's IV now vs. at purchase), so vol changes don't count as insurance.
export async function rollAnalysis(optionId) {
  const o = get('SELECT * FROM options WHERE id = ?', optionId);
  if (!o) throw new Error('option not found');
  if (o.underlying_at_purchase == null) throw new Error('index level at purchase unknown; open the report first');
  const settings = getSettings();
  const asOf = today();
  const base = { r: settings.risk_free_rate, q: settings.dividend_yield, right: o.right };
  const n = o.multiplier * o.contracts;
  const fx = (await hufRate('USD'))?.price;
  if (!fx) throw new Error('no USD/HUF rate');

  const sym = occSymbol(o);
  const cur = (await cboeOptions(o.underlying, [sym]))?.contracts?.[sym];
  const minExpiry = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  const chain = await cboeLongDated(o.underlying, o.right, minExpiry);
  if (!cur || !chain) throw new Error('option chain unavailable');
  const S = chain.underlying;
  const P0 = o.purchase_price;
  const T0 = daysBetween(o.purchase_date, o.expiry) / 365;
  const sigma0 = impliedVol(P0, { ...base, K: o.strike, S: o.underlying_at_purchase, T: T0 });
  const T = Math.max(daysBetween(asOf, o.expiry), 0) / 365;
  const curMid = (cur.bid + cur.ask) / 2;
  const sigmaNow = impliedVol(curMid, { ...base, K: o.strike, S, T });
  const shift = sigma0 - sigmaNow;
  const commission = o.contracts ? (o.fees || 0.75 * o.contracts) / o.contracts : 0.75;
  const month = 30 / 365;

  // stats for any contract we might hold from today
  const describe = (c, isCurrent) => {
    const Tc = daysBetween(asOf, c.expiry) / 365;
    const mid = (c.bid + c.ask) / 2;
    const iv = impliedVol(mid, { ...base, K: c.strike, S, T: Tc });
    if (iv == null) return null;
    const p = (s, t, sig) => bs({ ...base, K: c.strike, S: s, T: Math.max(t, 0), sigma: sig }).price;
    const index = p(S, Tc, iv + shift) / P0 * 100;
    const bleedUsd = (p(S, Tc, iv) - p(S, Tc - month, iv)) * n;
    const row = {
      symbol: c.symbol, expiry: c.expiry, strike: c.strike, dte: Math.round(Tc * 365), otm_pct: (S - c.strike) / S,
      bid: c.bid, ask: c.ask, mid, iv, index,
      index_bleed_month: (p(S, Tc, iv + shift) - p(S, Tc - month, iv + shift)) / P0 * 100,
      bleed_month_usd: bleedUsd, bleed_month_huf: bleedUsd * fx,
      value_huf: mid * n * fx,
      at_minus20_usd: p(S * 0.8, Tc, iv) * n, at_minus30_usd: p(S * 0.7, Tc, iv) * n,
      open_interest: c.open_interest,
    };
    if (!isCurrent) {
      // sell current at bid, buy new at ask, plus commission on both legs
      row.roll_debit_usd = (c.ask - cur.bid) * n + 2 * commission * o.contracts;
      row.roll_debit_huf = row.roll_debit_usd * fx;
      row.spread_cost_usd = ((c.ask - c.bid) / 2 + (cur.ask - cur.bid) / 2) * n;
    }
    return row;
  };

  const current = describe({ symbol: sym, expiry: o.expiry, strike: o.strike, bid: cur.bid, ask: cur.ask, open_interest: cur.open_interest }, true);
  const rows = chain.contracts.map((c) => (c.symbol === sym ? null : describe(c, false))).filter(Boolean);
  // per expiry: the listed strikes just below and just above index 100
  const candidates = [];
  for (const expiry of [...new Set(rows.map((r) => r.expiry))].sort()) {
    if (expiry < o.expiry) continue; // rolling to a shorter expiry isn't topping up
    const byStrike = rows.filter((r) => r.expiry === expiry).sort((a, b) => a.index - b.index);
    const above = byStrike.find((r) => r.index >= 100);
    const below = [...byStrike].reverse().find((r) => r.index < 100);
    for (const r of [below, above]) if (r) candidates.push(r);
  }
  return {
    asOf, underlying: S, usdhuf: fx, timestamp: chain.timestamp,
    sigma0, sigma_now: sigmaNow, vol_shift: shift,
    current, candidates,
  };
}
