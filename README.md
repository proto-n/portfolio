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

## Importing IBKR history

IBKR → Performance & Reports → Transaction History → CSV, **from account opening to today**. Then either
Manage → Import IBKR in the UI, or `npm run import-ibkr -- file.csv`.

- ETF/stock fills are merged per day/account/instrument into one lot; the HUF rate is the one IBKR actually used (gross HUF ÷ EUR amount), commissions are converted back to the instrument currency.
- Option buys become option positions (purchase date/price/fees); option sells reduce/close the matching position (for rolls).
- Cash per account = sum of all net amounts (base currency HUF), which is why the export must start at account opening.
- Re-importing is idempotent. Sells of positions whose purchase isn't in the file are skipped and listed.
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
- CBOE delayed quotes (`cdn.cboe.com/.../_XSP.json`): option bid/ask/IV/greeks + underlying.
- HU govt bonds: no feed; value = nominal × clean price % + accrued interest since last coupon (schedule counted back from maturity).

Prices are cached in SQLite (10 min quotes, 15 min option chain); failures fall back to the last cached value with a warning.

## Calculations

- **Yearly (XIRR)**: the fixed annual rate at which the exact cash you put in (on those dates) would grow into today's value. Per lot, per instrument, per account, and across accounts; both in instrument currency and in HUF (each lot converted at its day's FX rate, stored on the lot).
- **Option attribution**: Black-Scholes with IV implied from each observed price (purchase price + index at purchase; nightly snapshots; current CBOE mid). The change is split into time decay / underlying move / IV change with a Shapley average over all orderings, so the parts sum exactly to the price change. r and dividend yield are in Settings.
- **Crypto after tax**: value × `crypto_keep_ratio` (0.85).
