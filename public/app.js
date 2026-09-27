const $app = document.getElementById('app');

// ---------- helpers ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ok = (n) => n != null && Number.isFinite(n);
const nf = (d) => new Intl.NumberFormat('hu-HU', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n, d = 2) => (ok(n) ? nf(d).format(n) : '–');
const huf = (n) => (ok(n) ? nf(0).format(n) + ' Ft' : '–');
const money = (n, ccy, d = 2) => (ok(n) ? `${nf(d).format(n)} ${ccy === 'USD' ? '$' : ccy === 'EUR' ? '€' : ccy}` : '–');
const pct = (n, d = 2) => (ok(n) ? `${(n * 100).toFixed(d)}%` : '–');
const cls = (n) => (!ok(n) ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const signed = (s, n) => `<span class="${cls(n)}">${ok(n) && n > 0 ? '+' : ''}${s}</span>`;
const amt = (n) => (ok(n) ? (Math.abs(n) >= 100 ? num(n, 2) : Math.abs(n) >= 1 ? num(n, 4) : num(n, 8).replace(/0+$/, '').replace(/,$/, '')) : '–');
const fmtDate = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');

let reportCache = null;
async function getReport(force) {
  if (!reportCache || force) reportCache = await api('GET', '/api/report');
  return reportCache;
}
document.getElementById('refresh').onclick = () => { reportCache = null; route(); };

// ---------- router ----------
async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  $app.innerHTML = '<div class="loading"><div class="spinner"></div><p class="muted small">Fetching prices…</p></div>';
  try {
    if (page === 'account') await renderAccount(Number(arg));
    else if (page === 'manage') await renderManage(arg || 'crypto');
    else await renderReport();
  } catch (e) {
    $app.innerHTML = `<div class="warn">Error: ${esc(e.message)}</div>`;
    console.error(e);
  }
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', location.hash.startsWith(a.getAttribute('href'))));
}
window.addEventListener('hashchange', route);
route();

// ---------- report ----------
function warnings(r) {
  return r.warnings.length ? `<div class="warn">${r.warnings.map(esc).join('<br>')}</div>` : '';
}

async function renderReport() {
  const [r, hist] = await Promise.all([getReport(), api('GET', '/api/history')]);
  const t = r.totals;
  const parts = [
    ['IBKR', t.ibkr_huf, 'var(--c1)'],
    ['HU bonds', t.bonds_huf, 'var(--c2)'],
    ['Crypto', t.crypto_huf, 'var(--c3)'],
  ];
  const hot = r.ibkr.accounts.flatMap((a) => a.options).filter((o) => o.trigger && o.trigger.gauge >= 70);
  $app.innerHTML = `
    ${warnings(r)}
    ${hot.map((o) => `<div class="warn"><b>${optionTitle(o)}: put-sell gauge ${o.trigger.gauge}/100 (${o.trigger.state})</b>${o.trigger.fired ? ` — sell for ≈ ${huf(o.trigger.sale_huf)}` : ''}</div>`).join('')}
    <div class="kpis">
      <div class="kpi big"><div class="label">Total</div><div class="value">${huf(t.total_huf)}</div>
        <div class="sub">${huf(t.total_after_crypto_tax_huf)} with crypto after tax · ${fmtDate(r.asOf)}</div></div>
      <div class="kpi"><div class="label">IBKR</div><div class="value">${huf(t.ibkr_huf)}</div></div>
      <div class="kpi"><div class="label">HU govt bonds</div><div class="value">${huf(t.bonds_huf)}</div></div>
      <div class="kpi"><div class="label">Crypto</div><div class="value">${huf(t.crypto_huf)}</div><div class="sub">${huf(t.crypto_after_tax_huf)} after tax</div></div>
    </div>
    <div class="card">
      <div class="bar">${parts.map(([, v, c]) => `<div style="width:${t.total_huf ? (v / t.total_huf) * 100 : 0}%;background:${c}"></div>`).join('')}</div>
      <div class="legend">${parts.map(([n, v, c]) => `<span><i style="background:${c}"></i>${n} ${pct(t.total_huf ? v / t.total_huf : null, 1)}</span>`).join('')}</div>
    </div>
    <div class="card"><h2>Trajectory <span class="muted small">nightly snapshots, HUF</span></h2>${chart(hist)}</div>
    ${ibkrCard(r)}
    ${r.ibkr.accounts.flatMap((a) => a.options.map((o) => optionCompact(o, a))).join('')}
    ${bondsCard(r)}
    ${cryptoCard(r)}
    <p class="muted small">EUR/HUF ${num(r.fx.EUR)} · USD/HUF ${num(r.fx.USD)} · generated ${new Date(r.generatedAt).toLocaleString('en-GB')}
      · <a href="#" id="snapnow">record snapshot now</a></p>`;
  document.getElementById('snapnow').onclick = async (e) => {
    e.preventDefault();
    await api('POST', '/api/snapshot');
    route();
  };
}

function ibkrCard(r) {
  const accs = r.ibkr.accounts;
  return `<div class="card"><h2>IBKR <span>${huf(r.ibkr.total_huf)}</span></h2>
    <div class="scroll"><table>
      <thead><tr><th>Account</th><th>Positions</th><th>Cash</th><th>Options</th><th>Total HUF</th><th>Gain HUF</th><th>Return</th><th>Yearly (XIRR)</th></tr></thead>
      <tbody>${accs.map((a) => `<tr>
        <td><a href="#/account/${a.id}">${esc(a.name)}</a></td>
        <td>${huf(a.positions_huf)}</td><td>${huf(a.cash_huf)}</td><td>${huf(a.options_huf)}</td>
        <td><b>${huf(a.value_huf)}</b></td>
        <td>${signed(huf(a.stats_huf.gain_huf), a.stats_huf.gain_huf)}</td>
        <td>${signed(pct(a.stats_huf.return_pct_huf), a.stats_huf.return_pct_huf)}</td>
        <td>${signed(pct(a.stats_huf.xirr_huf), a.stats_huf.xirr_huf)}</td></tr>`).join('')}</tbody>
    </table></div>
    ${r.ibkr.instruments.length ? `<h3>By instrument (all accounts)</h3>
    <div class="scroll"><table>
      <thead><tr><th>Instrument</th><th>Qty</th><th>Price</th><th>Value</th><th>Gain</th><th>Return</th><th>XIRR</th><th>Value HUF</th><th>XIRR HUF</th></tr></thead>
      <tbody>${r.ibkr.instruments.map((p) => {
        const c = p.instrument.currency;
        return `<tr><td>${esc(p.instrument.ticker)}</td><td>${amt(p.quantity)}</td><td>${money(p.price, c)}</td><td>${money(p.value, c)}</td>
          <td>${signed(money(p.gain, c), p.gain)}</td><td>${signed(pct(p.return_pct), p.return_pct)}</td><td>${signed(pct(p.xirr), p.xirr)}</td>
          <td>${huf(p.value_huf)}</td><td>${signed(pct(p.xirr_huf), p.xirr_huf)}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
  </div>`;
}

function bondsCard(r) {
  const b = r.bonds;
  return `<div class="card"><h2>Hungarian govt bonds <span>${huf(b.total_huf)}</span></h2>
    ${b.rows.length ? `<div class="scroll"><table>
      <thead><tr><th>Bond</th><th>Nominal</th><th>Yield</th><th>Maturity</th><th>Price</th><th>Accrued</th><th>Market value</th><th>HUF</th></tr></thead>
      <tbody>${b.rows.map((x) => `<tr>
        <td>${esc(x.name)}${x.isin ? `<div class="muted small">${esc(x.isin)}</div>` : ''}</td>
        <td>${money(x.nominal, x.currency, x.currency === 'HUF' ? 0 : 2)}</td>
        <td>${pct(x.yield_pct / 100)}</td>
        <td>${fmtDate(x.maturity)}<div class="muted small">${x.days_to_maturity > 0 ? `${(x.days_to_maturity / 365).toFixed(1)} y` : 'matured'}</div></td>
        <td>${num(x.price_pct, x.price_dirty ? 4 : 2)}%${x.price_dirty ? `<div class="muted small">incl. accrued, ${fmtDate(x.price_date)}</div>` : ''}</td>
        <td>${money(x.accrued, x.currency, x.currency === 'HUF' ? 0 : 2)}</td>
        <td>${money(x.value_native, x.currency, x.currency === 'HUF' ? 0 : 2)}</td>
        <td>${huf(x.value_huf)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td colspan="5"></td>
        <td>${Object.entries(b.byCurrency).map(([c, v]) => money(v, c, c === 'HUF' ? 0 : 2)).join('<br>')}</td>
        <td>${huf(b.total_huf)}</td></tr></tfoot>
    </table></div>` : `<p class="muted">No bonds yet — <a href="#/manage/bonds">add one</a>.</p>`}
  </div>`;
}

function cryptoCard(r) {
  const c = r.crypto;
  const keep = r.settings.crypto_keep_ratio;
  return `<div class="card"><h2>Crypto <span>${huf(c.total_huf)}</span></h2>
    ${c.rows.length ? `<div class="scroll"><table>
      <thead><tr><th>Asset</th><th class="l">Where</th><th>Amount</th><th>Price</th><th>Value USD</th><th>Value HUF</th><th>After tax (${pct(keep, 0)})</th></tr></thead>
      <tbody>${c.rows.map((x) => `<tr><td>${esc(x.asset)}</td><td class="l">${esc(x.location)}</td><td>${amt(x.amount)}</td>
        <td>${money(x.price_usd, 'USD', x.price_usd < 1 ? 5 : 2)}</td><td>${money(x.value_usd, 'USD')}</td><td>${huf(x.value_huf)}</td><td>${huf(x.after_tax_huf)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td colspan="3"></td><td>${money(c.total_usd, 'USD')}</td><td>${huf(c.total_huf)}</td><td>${huf(c.total_after_tax_huf)}</td></tr></tfoot>
    </table></div>
    ${c.byAsset.length < c.rows.length ? `<h3>By asset</h3><div class="scroll"><table>
      <thead><tr><th>Asset</th><th>Amount</th><th>Value USD</th><th>Value HUF</th><th>After tax</th></tr></thead>
      <tbody>${c.byAsset.map((x) => `<tr><td>${esc(x.asset)}</td><td>${amt(x.amount)}</td><td>${money(x.value_usd, 'USD')}</td><td>${huf(x.value_huf)}</td><td>${huf(x.after_tax_huf)}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}` : `<p class="muted">No crypto yet — <a href="#/manage/crypto">add holdings</a>.</p>`}
  </div>`;
}

// ---------- chart ----------
function chart(hist) {
  if (!hist.length) return '<p class="muted">No snapshots yet. They are recorded nightly; use “record snapshot now” below to start.</p>';
  const series = [
    { name: 'Total', color: 'var(--fg)', get: (d) => (d.ibkr || 0) + (d.cash || 0) + (d.option || 0) + (d.bond || 0) + (d.crypto || 0) },
    { name: 'IBKR', color: 'var(--c1)', get: (d) => (d.ibkr || 0) + (d.cash || 0) + (d.option || 0) },
    { name: 'Bonds', color: 'var(--c2)', get: (d) => d.bond || 0 },
    { name: 'Crypto', color: 'var(--c3)', get: (d) => d.crypto || 0 },
  ];
  const W = 720, H = 240, L = 58, R = 12, T = 10, B = 24;
  const xs = hist.map((d) => new Date(d.date).getTime());
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const max = Math.max(...hist.map(series[0].get)) * 1.05 || 1;
  const X = (t) => L + (x1 === x0 ? (W - L - R) / 2 : ((t - x0) / (x1 - x0)) * (W - L - R));
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0));
  const lines = series.map((s) => {
    const pts = hist.map((d, i) => `${X(xs[i]).toFixed(1)},${Y(s.get(d)).toFixed(1)}`).join(' ');
    return hist.length === 1
      ? `<circle cx="${X(xs[0])}" cy="${Y(s.get(hist[0]))}" r="3.5" fill="${s.color}"/>`
      : `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.name === 'Total' ? 2.2 : 1.6}" stroke-linejoin="round"/>`;
  }).join('');
  const last = hist[hist.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value over time">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${short(v)}</text>`).join('')}
      <text x="${L}" y="${H - 6}">${fmtDate(hist[0].date)}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtDate(last.date)}</text>
      ${lines}
    </svg>
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name} ${huf(s.get(last))}</span>`).join('')}</div>`;
}


// ---------- put-sell gauge ----------
function gaugeSvg(v) {
  // semicircle, 0 at left, 100 at right; colour bands calm → sell
  const R = 80, cx = 100, cy = 95;
  const pt = (f, r = R) => [cx - r * Math.cos(Math.PI * f), cy - r * Math.sin(Math.PI * f)];
  const arc = (a, b, color) => {
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    return `<path d="M${x1} ${y1} A${R} ${R} 0 0 1 ${x2} ${y2}" stroke="${color}" stroke-width="14" fill="none"/>`;
  };
  const [nx, ny] = pt(Math.min(v, 100) / 100, R - 18);
  return `<svg viewBox="0 0 200 110" class="gauge" role="img" aria-label="Put-sell gauge ${v} of 100">
    ${arc(0, 0.4, 'var(--c3)')}${arc(0.4, 0.7, 'var(--c2)')}${arc(0.7, 0.995, 'var(--neg)')}
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--fg)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="5" fill="var(--fg)"/>
  </svg>`;
}

function triggerCard(o, compact) {
  const t = o.trigger;
  if (!t) return '';
  const fmtVal = (x) => (x.key === 'drawdown' ? pct(x.value, 1) : x.key === 'vix' ? num(x.value, 1) : `${num(x.value, 2)}×`);
  const fmtThr = (x) => (x.key === 'drawdown' ? pct(x.threshold, 0) : x.key === 'vix' ? num(x.threshold, 0) : `${num(x.threshold, 1)}×`);
  const cls2 = t.gauge >= 100 ? 'neg' : t.gauge >= 70 ? 'neg' : t.gauge >= 40 ? 'warnc' : 'pos';
  return `<div class="trigger${t.fired ? ' fired' : ''}">
    <div class="gauge-wrap">${gaugeSvg(t.gauge)}<div class="gauge-num ${cls2}">${t.gauge}</div><div class="gauge-state ${cls2}">${t.state}</div></div>
    <div class="trigger-parts">
      ${t.fired ? `<p><b class="neg">Trigger hit — consider selling the put now</b> (≈ ${huf(t.sale_huf)} at the bid) and parking it in HUF cash.</p>` : ''}
      ${t.components.map((x) => `<div class="tp"><div class="tp-head"><span>${esc(x.label)}</span><span><b>${x.value == null ? '–' : fmtVal(x)}</b> / ${fmtThr(x)}</span></div>
        <div class="tp-bar"><div style="width:${(x.score ?? 0) * 100}%"></div></div></div>`).join('')}
      ${compact ? '' : `<p class="muted small">Any one reaching its threshold fires the trigger; the gauge shows the closest one.
        S&P 500 ${num(t.spx, 0)}, 52-week high ${num(t.spx_high, 0)}. Selling now would bring ${money(t.sale_usd, 'USD', 0)} (${huf(t.sale_huf)}).
        Thresholds are in Manage → Settings.</p>`}
    </div></div>`;
}

// ---------- options ----------
function optionTitle(o) {
  return `${esc(o.underlying)} ${num(o.strike, 0)}${o.right} · ${fmtDate(o.expiry)} · ×${num(o.contracts, 0)}`;
}

function optionCompact(o, acc) {
  if (!o.quote) return `<div class="card"><h2>${optionTitle(o)}</h2><p class="muted">No quote available.</p></div>`;
  const a = o.attribution.since_purchase;
  return `<div class="card"><h2><a href="#/account/${acc.id}">${optionTitle(o)}</a><span>${money(o.value_usd, 'USD')}</span></h2>
    ${triggerCard(o, true)}
    <div class="stat-list">
      <div><span>${esc(o.underlying)}</span><b>${num(o.underlying_price)}</b></div>
      <div><span>% OTM</span><b>${pct(o.otm_pct)}</b></div>
      <div><span>DTE</span><b>${o.dte}</b></div>
      <div><span>IV now / at buy</span><b>${pct(o.iv, 1)} / ${pct(o.iv_at_purchase, 1)}</b></div>
      <div><span>Value</span><b>${huf(o.value_huf)}</b></div>
      <div><span>Value vs. paid</span><b>${pct(o.value_pct_of_cost, 1)}</b></div>
      ${o.insurance ? `<div><span>Remaining insurance</span><b>${num(o.insurance.index, 1)}</b></div>` : ''}
      <div><span>P&amp;L</span><b>${signed(money(o.pnl_usd, 'USD'), o.pnl_usd)}</b></div>
      ${a ? `<div><span>Time + ${esc(o.underlying)} effect</span><b>${signed(money(a.time + a.spot, 'USD', 0), a.time + a.spot)}</b></div>
      <div><span>IV effect</span><b>${signed(money(a.vol, 'USD', 0), a.vol)}</b></div>` : ''}
    </div></div>`;
}

function optionFull(o) {
  if (!o.quote) return `<div class="card"><h2>${optionTitle(o)}</h2><p class="muted">No quote available for ${esc(o.symbol)}.</p></div>`;
  const g = o.greeks;
  const rows = [['since_purchase', 'Since purchase'], ['30d', 'Last 30 days'], ['7d', 'Last 7 days'], ['1d', 'Since last snapshot']]
    .filter(([k]) => o.attribution[k]);
  const share = (part, a) => {
    const denom = Math.abs(a.time) + Math.abs(a.spot) + Math.abs(a.vol);
    return denom ? `<div class="muted small">${pct(Math.abs(part) / denom, 0)}</div>` : '';
  };
  const ins = o.insurance;
  return `<div class="card"><h2>${optionTitle(o)} <span class="muted small">${esc(o.symbol)}</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="label">Value</div><div class="value">${huf(o.value_huf)}</div><div class="sub">${money(o.value_usd, 'USD')}</div></div>
      <div class="kpi"><div class="label">Value vs. paid</div><div class="value">${pct(o.value_pct_of_cost, 1)}</div>
        <div class="sub">in USD${ok(o.value_pct_of_cost_huf) ? ` · ${pct(o.value_pct_of_cost_huf, 1)} in HUF (paid ${huf(o.cost_huf)})` : ''}</div></div>
      ${ins ? `<div class="kpi"><div class="label">Remaining insurance</div><div class="value">${num(ins.index, 1)}</div>
        <div class="sub">100 at purchase, IV held fixed · time alone ${num(ins.time_only, 1)} · ${esc(o.underlying)} alone ${num(ins.spot_only, 1)}</div></div>` : ''}
    </div>
    <h3>Put-sell trigger</h3>
    ${triggerCard(o, false)}
    <div class="stat-list" style="margin-top:14px">
      <div><span>${esc(o.underlying)} now</span><b>${num(o.underlying_price)}</b></div>
      <div><span>% OTM</span><b>${pct(o.otm_pct)}</b></div>
      <div><span>${esc(o.underlying)} move to strike</span><b>${pct(-o.otm_pct)}</b></div>
      <div><span>Days to expiry</span><b>${o.dte}</b></div>
      <div><span>Bid / Ask</span><b>${num(o.quote.bid)} / ${num(o.quote.ask)}</b></div>
      <div><span>Mid (per share)</span><b>${num(o.quote.mid)}</b></div>
      <div><span>Value</span><b>${money(o.value_usd, 'USD')}</b><span>${huf(o.value_huf)}</span></div>
      <div><span>Paid</span><b>${money(o.cost_usd, 'USD')}</b><span>${num(o.purchase_price)} on ${fmtDate(o.purchase_date)}</span></div>
      <div><span>P&amp;L</span><b>${signed(money(o.pnl_usd, 'USD'), o.pnl_usd)}</b><span>${signed(pct(o.pnl_usd / o.cost_usd), o.pnl_usd)}</span></div>
      <div><span>${esc(o.underlying)} at purchase</span><b>${num(o.underlying_at_purchase)}</b></div>
      <div><span>IV now (model)</span><b>${pct(o.iv, 2)}</b><span>CBOE ${pct(o.quote.cboe_iv, 2)}</span></div>
      <div><span>IV at purchase</span><b>${pct(o.iv_at_purchase, 2)}</b></div>
      <div><span>Delta</span><b>${num(g.delta, 4)}</b><span>${money(g.delta_usd_per_1pct, 'USD')} per +1% ${esc(o.underlying)}</span></div>
      <div><span>Theta / day</span><b>${money(g.theta_day_usd, 'USD')}</b></div>
      <div><span>Vega / vol pt</span><b>${money(g.vega_usd, 'USD')}</b></div>
      <div><span>Protected notional</span><b>${money(o.protected_notional_usd, 'USD', 0)}</b></div>
    </div>
    <h3>What moved the price</h3>
    ${rows.length ? `<div class="scroll"><table>
      <thead><tr><th>Period</th><th>Time decay</th><th>${esc(o.underlying)} move</th><th>Time + ${esc(o.underlying)}</th><th>IV change</th><th>Total</th></tr></thead>
      <tbody>${rows.map(([k, label]) => {
        const a = o.attribution[k];
        return `<tr><td>${label}<div class="muted small">from ${fmtDate(a.from)}</div></td>
          <td>${signed(money(a.time, 'USD'), a.time)}${share(a.time, a)}</td>
          <td>${signed(money(a.spot, 'USD'), a.spot)}${share(a.spot, a)}</td>
          <td><b>${signed(money(a.time + a.spot, 'USD'), a.time + a.spot)}</b></td>
          <td><b>${signed(money(a.vol, 'USD'), a.vol)}</b>${share(a.vol, a)}</td>
          <td>${signed(money(a.total, 'USD'), a.total)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted small">Black-Scholes repricing (r=${pct(reportCache.settings.risk_free_rate, 1)}, q=${pct(reportCache.settings.dividend_yield, 1)}), IV implied from each price; Shapley split so the three parts add up exactly to the total.</p>`
      : '<p class="muted">Needs the index level at purchase (auto-fetched) or nightly snapshots.</p>'}
    <h3>Top up to 100 (roll)</h3>
    <div id="roll-${o.id}"><p class="muted small">Loading option chain…</p></div>
    <h3>Instant ${esc(o.underlying)} drop scenarios</h3>
    <div class="scroll"><table>
      <thead><tr><th>${esc(o.underlying)} move</th><th>Level</th><th>Value @ current IV</th><th>Value @ IV +10pt</th><th>At expiry</th></tr></thead>
      <tbody>${o.scenarios.map((s) => `<tr><td>${pct(s.move, 0)}</td><td>${num(o.underlying_price * (1 + s.move))}</td>
        <td>${money(s.at_current_iv, 'USD', 0)}</td><td>${money(s.iv_plus_10, 'USD', 0)}</td><td>${money(s.at_expiry, 'USD', 0)}</td></tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

// ---------- account details ----------
async function renderAccount(id) {
  const [r, instruments] = await Promise.all([getReport(), api('GET', '/api/instruments')]);
  const a = r.ibkr.accounts.find((x) => x.id === id);
  if (!a) { $app.innerHTML = '<p>Account not found.</p>'; return; }
  const s = a.stats_huf, n = a.stats_native;
  $app.innerHTML = `
    ${warnings(r)}
    <h1>${esc(a.name)} <span class="pill">${esc(a.kind)}</span></h1>
    <div class="kpis">
      <div class="kpi"><div class="label">Value</div><div class="value">${huf(a.value_huf)}</div></div>
      ${a.positions.length ? `
      <div class="kpi"><div class="label">Invested</div><div class="value">${huf(s.cost_huf)}</div>${n ? `<div class="sub">${money(n.cost, n.currency)}</div>` : ''}</div>
      <div class="kpi"><div class="label">Gain</div><div class="value">${signed(huf(s.gain_huf), s.gain_huf)}</div>${n ? `<div class="sub">${money(n.gain, n.currency)}</div>` : ''}</div>
      <div class="kpi"><div class="label">Total return</div><div class="value">${signed(pct(s.return_pct_huf), s.return_pct_huf)}</div>${n ? `<div class="sub">${pct(n.return_pct)} in ${n.currency}</div>` : ''}</div>
      <div class="kpi"><div class="label">Yearly (XIRR)</div><div class="value">${signed(pct(s.xirr_huf), s.xirr_huf)}</div>${n ? `<div class="sub">${pct(n.xirr)} in ${n.currency}</div>` : ''}</div>` : ''}
    </div>
    ${a.options.map(optionFull).join('')}
    ${a.positions.map(positionCard).join('')}
    <div class="card"><h2>Add purchase / sale</h2><div id="lot-editor"></div></div>
    <div class="card"><h2>Cash</h2><div id="cash-editor"></div></div>
    <div class="card"><h2>Options on this account</h2><div id="opt-editor"></div></div>
    <p class="muted small">Yearly (XIRR): the fixed annual rate at which the exact amounts you invested, on the dates you invested them, would have grown into today's value. HUF figures convert each purchase at that day's FX rate.</p>`;

  for (const o of a.options) if (o.quote) loadRoll(o);
  const lots = await api('GET', '/api/lots');
  mountEditor(document.getElementById('lot-editor'), {
    endpoint: '/api/lots',
    rows: lots.filter((l) => l.account_id === id),
    hideTable: true,
    fields: [
      { key: 'instrument_id', label: 'Instrument', type: 'select', options: instruments.map((i) => [i.id, i.ticker]) },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'quantity', label: 'Quantity (neg = sell)', type: 'number' },
      { key: 'price', label: 'Price / unit', type: 'number' },
      { key: 'fees', label: 'Fees', type: 'number' },
      { key: 'note', label: 'Note' },
    ],
    defaults: { account_id: id, instrument_id: instruments[0]?.id, date: new Date().toLocaleDateString('sv-SE'), fees: 0 },
    onChange: () => { reportCache = null; route(); },
  });
  // edit/delete buttons in lot tables reuse the editor above
  $app.querySelectorAll('[data-lot]').forEach((b) => b.addEventListener('click', () => {
    const lot = lots.find((l) => l.id === Number(b.dataset.lot));
    document.getElementById('lot-editor').__edit(lot);
  }));

  const cashRows = (await api('GET', '/api/cash')).filter((c) => c.account_id === id);
  const ce = document.getElementById('cash-editor');
  ce.innerHTML = `${cashRows.length ? `<table><tbody>${a.cash.map((c) => `<tr><td>${esc(c.currency)}</td><td>${money(c.amount, c.currency)}</td><td>${huf(c.value_huf)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No cash recorded.</p>'}
    <form class="editor"><label>Currency<input name="currency" value="EUR" required></label>
    <label>Balance<input name="amount" type="number" step="any" required></label>
    <div class="actions"><button class="primary">Set balance</button><span class="muted small">0 removes it</span></div></form>`;
  ce.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('PUT', '/api/cash', { account_id: id, currency: f.get('currency'), amount: Number(f.get('amount')) });
    reportCache = null; route();
  };

  const opts = await api('GET', '/api/options');
  mountEditor(document.getElementById('opt-editor'), {
    endpoint: '/api/options',
    rows: opts.filter((o) => o.account_id === id),
    columns: ['underlying', 'right', 'strike', 'expiry', 'contracts', 'purchase_date', 'purchase_price'],
    fields: OPTION_FIELDS,
    defaults: { account_id: id, underlying: 'XSP', right: 'P', multiplier: 100, contracts: 1, fees: 0 },
    onChange: () => { reportCache = null; route(); },
  });
}

async function loadRoll(o) {
  const el = document.getElementById(`roll-${o.id}`);
  try {
    const r = await api('GET', `/api/options/${o.id}/roll`);
    const row = (x, isCur) => `<tr>
      <td>${isCur ? '<b>Keep current</b>' : 'Roll to'}<div class="muted small">${num(x.strike, 0)}${o.right} ${fmtDate(x.expiry)}</div></td>
      <td><b>${num(x.index, 1)}</b></td>
      <td>${pct(x.otm_pct, 1)}<div class="muted small">${x.dte} days</div></td>
      <td>${isCur ? '–' : `${huf(x.roll_debit_huf)}<div class="muted small">${money(x.roll_debit_usd, 'USD', 0)}</div>`}</td>
      <td class="neg">${huf(-x.bleed_month_huf)}<div class="muted small">−${num(x.index_bleed_month, 1)} pts</div></td>
      <td>${huf(-x.bleed_month_huf * 12)}</td>
      <td>${money(x.at_minus20_usd, 'USD', 0)}<div class="muted small">${money(x.at_minus30_usd, 'USD', 0)} at −30%</div></td>
      <td class="muted">${num(x.bid)} / ${num(x.ask)}<div class="small">IV ${pct(x.iv, 1)}</div></td></tr>`;
    el.innerHTML = `<div class="scroll"><table>
      <thead><tr><th>Position</th><th>Insurance</th><th>OTM · DTE</th><th>Roll cost</th><th>Monthly decay</th><th>Per year</th><th>Worth at −20%</th><th>Bid / Ask</th></tr></thead>
      <tbody>${row(r.current, true)}${r.candidates.map((x) => row(x, false)).join('')}</tbody></table></div>
      <p class="muted small">For each listed expiry, the strikes just below/above insurance 100. Roll cost: sell current at bid, buy new at ask, plus commissions.
      Monthly decay: value lost over 30 days if ${esc(o.underlying)} and IV stay where they are (time decay only; a rising index costs extra, a falling one pays).
      Insurance of a new contract uses its market IV shifted by the vol change since your purchase (${pct(r.vol_shift, 2)}), so today's vol level doesn't count.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="muted small">Roll analysis unavailable: ${esc(e.message)}</p>`;
  }
}

function positionCard(p) {
  const c = p.instrument.currency;
  return `<div class="card"><h2>${esc(p.instrument.ticker)} <span class="muted small">${esc(p.instrument.name)}</span></h2>
    <div class="stat-list">
      <div><span>Quantity</span><b>${amt(p.quantity)}</b></div>
      <div><span>Avg cost</span><b>${money(p.avg_cost, c)}</b></div>
      <div><span>Price</span><b>${money(p.price, c)}</b></div>
      <div><span>Value</span><b>${money(p.value, c)}</b><span>${huf(p.value_huf)}</span></div>
      <div><span>Invested</span><b>${money(p.cost, c)}</b><span>${huf(p.cost_huf)}</span></div>
      <div><span>Gain</span><b>${signed(money(p.gain, c), p.gain)}</b><span>${signed(huf(p.gain_huf), p.gain_huf)}</span></div>
      <div><span>Total return</span><b>${signed(pct(p.return_pct), p.return_pct)}</b><span>${pct(p.return_pct_huf)} in HUF</span></div>
      <div><span>Yearly (XIRR)</span><b>${signed(pct(p.xirr), p.xirr)}</b><span>${pct(p.xirr_huf)} in HUF</span></div>
    </div>
    <h3>Lots</h3>
    <div class="scroll"><table>
      <thead><tr><th>Date</th><th>Qty</th><th>Price</th><th>Fees</th><th>Cost</th><th>Value now</th><th>Gain</th><th>Return</th><th>XIRR</th><th>XIRR HUF</th><th>FX</th><th></th></tr></thead>
      <tbody>${p.lots.map((l) => `<tr>
        <td>${fmtDate(l.date)}</td><td>${amt(l.quantity)}</td><td>${money(l.price, c)}</td><td>${money(l.fees, c)}</td>
        <td>${money(l.cost, c)}</td><td>${money(l.value, c)}</td>
        <td>${signed(money(l.gain, c), l.gain)}</td><td>${signed(pct(l.return_pct), l.return_pct)}</td>
        <td>${signed(pct(l.xirr), l.xirr)}</td><td>${signed(pct(l.xirr_huf), l.xirr_huf)}</td>
        <td class="muted">${num(l.huf_rate)}</td>
        <td><button class="small" data-lot="${l.id}">edit</button></td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

// ---------- manage ----------
const OPTION_FIELDS = [
  { key: 'underlying', label: 'Underlying' },
  { key: 'right', label: 'Put / Call', type: 'select', options: [['P', 'Put'], ['C', 'Call']] },
  { key: 'strike', label: 'Strike', type: 'number' },
  { key: 'expiry', label: 'Expiry', type: 'date' },
  { key: 'contracts', label: 'Contracts', type: 'number' },
  { key: 'multiplier', label: 'Multiplier', type: 'number' },
  { key: 'purchase_date', label: 'Bought on', type: 'date' },
  { key: 'purchase_price', label: 'Price paid / share', type: 'number' },
  { key: 'fees', label: 'Fees (USD)', type: 'number' },
  { key: 'underlying_at_purchase', label: 'Index at purchase (blank = auto)', type: 'number' },
  { key: 'note', label: 'Note' },
];

async function renderManage(tab) {
  const tabs = [['crypto', 'Crypto'], ['bonds', 'Bonds'], ['accounts', 'IBKR accounts'], ['instruments', 'Instruments'], ['options', 'Options'], ['import', 'Import IBKR'], ['settings', 'Settings']];
  $app.innerHTML = `<div class="tabs">${tabs.map(([k, n]) => `<a href="#/manage/${k}" class="${k === tab ? 'active' : ''}">${n}</a>`).join('')}</div>
    <div class="card" id="mgr"></div>`;
  const el = document.getElementById('mgr');
  const done = () => { reportCache = null; route(); };

  if (tab === 'import') {
    el.innerHTML = `<h2>Import IBKR transaction history</h2>
      <p class="muted small">IBKR → Performance &amp; Reports → Transaction History → CSV. Export from account opening each time:
      re-importing is safe (purchases are updated, not duplicated) and cash balances are recomputed from the full history.</p>
      <form class="editor"><label>CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
      <div class="actions"><button class="primary">Import</button></div></form>
      <h2 style="margin-top:24px">Import Kincstár (MÁK) portfolio</h2>
      <p class="muted small">Kincstár → portfolio export (portfolio.xls). Updates nominal and price (incl. accrued interest) of each bond; your maturity/coupon edits are kept.</p>
      <form class="editor" id="mak-form"><label>XLS file<input type="file" name="file" accept=".xls,.xlsx" required></label>
      <div class="actions"><button class="primary">Import</button></div></form>
      <pre id="imp-out" class="small"></pre>`;
    document.getElementById('mak-form').onsubmit = async (e) => {
      e.preventDefault();
      const out = document.getElementById('imp-out');
      try {
        const res = await fetch('/api/import/mak', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: e.target.elements.file.files[0] });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        reportCache = null;
        out.textContent = JSON.stringify(j, null, 2);
      } catch (err) {
        out.innerHTML = `<span class="neg">${esc(err.message)}</span>`;
      }
    };
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const out = document.getElementById('imp-out');
      try {
        const text = await e.target.elements.file.files[0].text();
        const res = await fetch('/api/import/ibkr', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        reportCache = null;
        out.textContent = JSON.stringify(j, null, 2);
      } catch (err) {
        out.innerHTML = `<span class="neg">${esc(err.message)}</span>`;
      }
    };
    return;
  }

  if (tab === 'settings') {
    const s = await api('GET', '/api/settings');
    const labels = { crypto_keep_ratio: 'Crypto value kept after tax (0.85 = 85%)', risk_free_rate: 'Risk-free rate for option model (0.04 = 4%)', dividend_yield: 'S&P 500 dividend yield (0.012 = 1.2%)',
      trigger_drawdown: 'Put-sell trigger: S&P 500 drawdown from 52w high (0.25 = 25%)', trigger_vix: 'Put-sell trigger: VIX at or above',
      trigger_value_multiple: 'Put-sell trigger: put worth × its cost', vix_calm: 'VIX level that counts as calm (gauge 0)' };
    el.innerHTML = `<h2>Settings</h2><form class="editor">${s.map((x) => `<label>${esc(labels[x.key] || x.key)}<input name="${esc(x.key)}" value="${esc(x.value)}" type="number" step="any"></label>`).join('')}
      <div class="actions"><button class="primary">Save</button></div></form>`;
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
      done();
    };
    return;
  }

  const accounts = await api('GET', '/api/accounts');
  const cfg = {
    crypto: {
      title: 'Crypto holdings',
      columns: ['asset', 'amount', 'location', 'yahoo_symbol'],
      fields: [
        { key: 'asset', label: 'Asset (ETH, DOGE, ZEC…)' },
        { key: 'yahoo_symbol', label: 'Price symbol (blank = ASSET-USD)' },
        { key: 'amount', label: 'Amount', type: 'number' },
        { key: 'location', label: 'Stored at' },
        { key: 'note', label: 'Note' },
      ],
      beforeSave: (v) => ({ ...v, asset: v.asset.toUpperCase(), yahoo_symbol: v.yahoo_symbol || `${v.asset.toUpperCase()}-USD` }),
    },
    bonds: {
      title: 'Hungarian govt bonds',
      columns: ['name', 'currency', 'nominal', 'yield_pct', 'maturity', 'price_pct'],
      fields: [
        { key: 'name', label: 'Name (e.g. PMÁP 2029/J)' },
        { key: 'isin', label: 'ISIN' },
        { key: 'currency', label: 'Currency', type: 'select', options: [['HUF', 'HUF'], ['EUR', 'EUR']] },
        { key: 'nominal', label: 'Nominal amount', type: 'number' },
        { key: 'yield_pct', label: 'Current yield / coupon %', type: 'number' },
        { key: 'maturity', label: 'Maturity', type: 'date' },
        { key: 'purchase_date', label: 'Purchase date', type: 'date' },
        { key: 'price_pct', label: 'Price % (100 = par)', type: 'number' },
        { key: 'price_dirty', label: 'Price includes accrued?', type: 'select', options: [[0, 'No (clean)'], [1, 'Yes (Kincstár quote)']] },
        { key: 'price_date', label: 'Price as of', type: 'date' },
        { key: 'coupon_freq', label: 'Coupons / year', type: 'number' },
        { key: 'note', label: 'Note' },
      ],
      defaults: { currency: 'HUF', price_pct: 100, price_dirty: 0, coupon_freq: 1 },
    },
    accounts: {
      title: 'IBKR accounts',
      columns: ['name', 'kind'],
      fields: [
        { key: 'name', label: 'Name (tbsz2027…)' },
        { key: 'kind', label: 'Kind', type: 'select', options: [['tbsz', 'TBSZ'], ['cash', 'Cash']] },
        { key: 'note', label: 'Note' },
      ],
      defaults: { kind: 'tbsz' },
      extra: (r) => `<a href="#/account/${r.id}">open</a>`,
    },
    instruments: {
      title: 'Instruments',
      columns: ['ticker', 'name', 'yahoo_symbol', 'currency', 'manual_price'],
      fields: [
        { key: 'ticker', label: 'Ticker' },
        { key: 'name', label: 'Name' },
        { key: 'yahoo_symbol', label: 'Yahoo symbol (VWCE.DE)' },
        { key: 'currency', label: 'Currency' },
        { key: 'manual_price', label: 'Manual price (if no symbol)', type: 'number' },
      ],
      defaults: { currency: 'EUR' },
    },
    options: {
      title: 'Options',
      columns: ['account_id', 'underlying', 'right', 'strike', 'expiry', 'purchase_price'],
      fields: [{ key: 'account_id', label: 'Account', type: 'select', options: accounts.map((a) => [a.id, a.name]) }, ...OPTION_FIELDS],
      defaults: { underlying: 'XSP', right: 'P', multiplier: 100, contracts: 1, fees: 0, account_id: accounts.find((a) => a.kind === 'cash')?.id },
      display: { account_id: (v) => accounts.find((a) => a.id === v)?.name },
    },
  }[tab];
  el.innerHTML = `<h2>${cfg.title}</h2><div></div>`;
  mountEditor(el.lastElementChild, { ...cfg, endpoint: `/api/${tab}`, rows: await api('GET', `/api/${tab}`), onChange: done });
}

// Generic list + add/edit form. `el.__edit(row)` opens a row for editing.
function mountEditor(el, { endpoint, rows, fields, columns, defaults = {}, display = {}, extra, hideTable, beforeSave, onChange }) {
  const cols = columns || fields.map((f) => f.key);
  const label = (k) => fields.find((f) => f.key === k)?.label.replace(/\s*\(.*\)$/, '') || k;
  const input = (f) => {
    if (f.type === 'select') {
      return `<select name="${f.key}">${f.options.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select>`;
    }
    return `<input name="${f.key}" type="${f.type === 'number' ? 'number' : f.type || 'text'}" ${f.type === 'number' ? 'step="any"' : ''}>`;
  };
  el.innerHTML = `
    ${hideTable ? '' : rows.length ? `<div class="scroll"><table>
      <thead><tr>${cols.map((c) => `<th class="l">${esc(label(c))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="l">${esc(display[c] ? display[c](r[c]) : r[c])}</td>`).join('')}
        <td>${extra ? extra(r) + ' ' : ''}<button class="small" data-edit="${r.id}">edit</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">Nothing here yet.</p>'}
    <form class="editor">
      ${fields.map((f) => `<label>${esc(f.label)}${input(f)}</label>`).join('')}
      <div class="actions">
        <button class="primary" type="submit">Add</button>
        <button type="button" data-act="cancel" hidden>Cancel</button>
        <button type="button" class="danger" data-act="delete" hidden>Delete</button>
      </div>
    </form>`;
  const form = el.querySelector('form');
  const submit = form.querySelector('[type=submit]');
  const cancel = form.querySelector('[data-act=cancel]');
  const del = form.querySelector('[data-act=delete]');
  let editing = null;

  const fill = (row) => {
    for (const f of fields) form.elements[f.key].value = row[f.key] ?? '';
  };
  const reset = () => {
    editing = null;
    form.reset();
    fill(defaults);
    submit.textContent = 'Add';
    cancel.hidden = del.hidden = true;
  };
  el.__edit = (row) => {
    editing = row;
    fill(row);
    submit.textContent = 'Save';
    cancel.hidden = del.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  reset();

  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => el.__edit(rows.find((r) => r.id === Number(b.dataset.edit)))));
  cancel.onclick = reset;
  let armed = false;
  del.onclick = async () => {
    if (!armed) { armed = true; del.textContent = 'Really delete?'; return; }
    await api('DELETE', `${endpoint}/${editing.id}`);
    onChange();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    let v = { ...defaults };
    for (const f of fields) {
      const raw = form.elements[f.key].value;
      v[f.key] = raw === '' ? '' : f.type === 'number' || (f.type === 'select' && typeof f.options[0][0] === 'number') ? Number(raw) : raw;
    }
    if (beforeSave) v = beforeSave(v);
    try {
      await api(editing ? 'PUT' : 'POST', editing ? `${endpoint}/${editing.id}` : endpoint, v);
      onChange();
    } catch (err) {
      submit.insertAdjacentHTML('afterend', `<span class="neg small">${esc(err.message)}</span>`);
    }
  };
}
