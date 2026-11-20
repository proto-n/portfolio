# Portfolio

Personal portfolio tracker: IBKR (TBSZ accounts + options), Hungarian govt bonds, crypto.
Node 22 + Express + built-in `node:sqlite`. No build step.

## Run

```sh
nvm use            # Node 22 (.nvmrc)
npm install
PORTFOLIO_PASSWORD=secret npm start     # http://<server>:3000, basic auth user "me"
```

| env | default | |
|---|---|---|
| `PORT` | 3000 | |
| `PORTFOLIO_PASSWORD` | – | without it the server binds to 127.0.0.1 only |
| `PORTFOLIO_USER` | `me` | |
| `PORTFOLIO_DB` | `data/portfolio.db` | back this file up |
| `SNAPSHOT_AT` | `23:30` | nightly snapshot time (server local time) |
| `NO_SCHEDULER` | – | `1` disables the in-process scheduler (use system cron instead) |

Put it behind HTTPS (Caddy / nginx) since basic auth sends the password with every request.

### systemd

```ini
[Service]
WorkingDirectory=/path/to/portfolio
Environment=PORTFOLIO_PASSWORD=secret TZ=Europe/Budapest
ExecStart=/home/you/.nvm/versions/node/v22.23.1/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
```

Or, instead of the built-in scheduler, crontab: `30 23 * * * cd /path/to/portfolio && NO_SCHEDULER=1 npm run snapshot`

## Deployment

Live at https://portfolio.mormota.xyz (Cloudflare → nginx in `csincsi-infra` → `portfolio` container,
Node 22, code at `/root/portfolio` on the `csincsi` host). Credentials live in `/root/portfolio/.env`
on the host, the live database in `/root/portfolio/data/`. `./deploy.sh` rsyncs the code and restarts
the container; it never touches the host's database or `.env`.

After one basic-auth login the app sets a `pf_auth` cookie (HMAC of the credentials, renewed on every
request, 400 days), so the prompt doesn't come back; changing the password logs every browser out.

## Importing IBKR history

IBKR → Performance & Reports → Transaction History → CSV, any period (the 7-day one is fine). Upload in
Manage → Import IBKR, or `npm run import-ibkr -- file.csv`.

- Every transaction is stored once in `ibkr_ledger` (keyed by its content + occurrence number), so
  overlapping or repeated uploads are safe; positions and cash are rebuilt from the ledger.
- Cash needs one full-history export (from account opening) the first time. After that, per-account
  cash = sum of ledger amounts (HUF base), trued up to IBKR's reported ending cash (the difference is
  the "FX Translations P&L" revaluation, which is period-dependent and not stored as a transaction).
- ETF/stock fills are merged per day/account/instrument/side into one lot; the HUF rate is the one IBKR
  actually used; commissions are converted back to the instrument currency.
- New instruments get their Yahoo symbol looked up automatically (same ticker, same currency, Xetra first).
- Option buys become option positions; option sells reduce/close the matching position (rolls).
- The referral-bonus IBKR shares are ignored as a position (`IGNORED_SYMBOLS`); their sale proceeds and
  dividends still count toward cash. Other sells without a recorded purchase are skipped and listed.
- `TBSZ-YYYY` maps to account `tbszYYYY`; the main account maps to `cash`.

## Importing Kincstár (MÁK) bonds

Download the portfolio export (`portfolio.xls`), then Manage → Import IBKR → *Import Kincstár*, or
`npm run import-mak -- portfolio.xls`. Each bond is keyed by name; re-import refreshes nominal and price.
The Kincstár price includes accrued interest (`price_dirty`), so between imports the value is rolled
forward by the coupon rate and reduced on coupon dates. New bonds get a guessed maturity and a 0% coupon;
set the real values in Manage → Bonds (they are kept on re-import). Re-import every few months, and
after a step-up coupon changes.

## Data sources

- Yahoo Finance chart API: ETF prices (`VWCE.DE`, `FOLOW.PA`), crypto (`ETH-USD`…), FX (`EURHUF=X`, `USDHUF=X`), historical FX per lot and index level at option purchase. For individual bonds without a Yahoo symbol, leave the symbol blank and set a manual price.
- marketdata.app (`MARKETDATA_TOKEN` in `.env`): option bid/ask/IV + underlying, and the long-dated chain for the roll analysis. Free/trial plans only serve the last closed session; then the held option is repriced at the live index (Yahoo) with that quote's IV and flagged ESTIMATED. (CBOE's free delayed feed, used before, is blocked since 2026-11-19.)
- HU govt bonds: no feed; value = nominal × clean price % + accrued interest since last coupon (schedule counted back from maturity).

Prices are cached in SQLite (10 min quotes, 15 min option chain); failures fall back to the last cached value with a warning.

## Calculations

- **Yearly (XIRR)**: the fixed annual rate at which the exact cash you put in (on those dates) would grow into today's value. Per lot, per instrument, per account, and across accounts; both in instrument currency and in HUF (each lot converted at its day's FX rate, stored on the lot).
- **Option attribution**: Black-Scholes with IV implied from each observed price (purchase price + index at purchase; nightly snapshots; current market mid). The change is split into time decay / underlying move / IV change with a Shapley average over all orderings, so the parts sum exactly to the price change. r and dividend yield are in Settings.
- **Crypto after tax**: value × `crypto_keep_ratio` (0.85).
