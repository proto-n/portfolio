import { db, run } from './db.js';
import { buildReport } from './report.js';

// Record today's value of every position. Idempotent: re-running replaces today's rows.
export async function recordSnapshot() {
  const r = await buildReport();
  const rows = [];
  for (const c of r.crypto.rows) rows.push(['crypto', `crypto:${c.id}`, `${c.asset} @ ${c.location}`, c.value_usd, 'USD', c.value_huf]);
  for (const b of r.bonds.rows) rows.push(['bond', `bond:${b.id}`, b.name, b.value_native, b.currency, b.value_huf]);
  for (const a of r.ibkr.accounts) {
    for (const p of a.positions) rows.push(['ibkr', `pos:${a.id}:${p.instrument.id}`, `${a.name} ${p.instrument.ticker}`, p.value, p.instrument.currency, p.value_huf ?? 0]);
    for (const c of a.cash) rows.push(['cash', `cash:${a.id}:${c.currency}`, `${a.name} ${c.currency}`, c.amount, c.currency, c.value_huf]);
    for (const o of a.options) {
      if (o.value_usd == null) continue;
      rows.push(['option', `opt:${o.id}`, o.symbol, o.value_usd, 'USD', o.value_huf ?? 0]);
      run('INSERT OR REPLACE INTO option_snapshots (date, option_id, underlying, mid, iv) VALUES (?, ?, ?, ?, ?)',
        r.asOf, o.id, o.underlying_price, o.quote.mid, o.iv);
    }
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM snapshots WHERE date = ?', r.asOf);
    const ins = db.prepare('INSERT INTO snapshots (date, kind, ref, label, value_native, currency, value_huf) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) ins.run(r.asOf, ...row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { date: r.asOf, rows: rows.length, total_huf: r.totals.total_huf, warnings: r.warnings };
}

// Run once per day at HH:MM local time (SNAPSHOT_AT, default 23:30).
export function scheduleNightly(at = process.env.SNAPSHOT_AT || '23:30') {
  const [h, m] = at.split(':').map(Number);
  const next = () => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d - new Date();
  };
  const loop = () => setTimeout(async () => {
    try { console.log('[snapshot]', await recordSnapshot()); } catch (e) { console.error('[snapshot] failed', e); }
    loop();
  }, next());
  loop();
  console.log(`[snapshot] nightly at ${at} (server local time)`);
}

// CLI: `npm run snapshot` (usable from system crontab instead of the in-process scheduler)
if (import.meta.url === `file://${process.argv[1]}`) {
  recordSnapshot().then((r) => { console.log(r); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
