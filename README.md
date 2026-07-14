# Vivian's Desk — live dashboard

A markets / portfolio / research / CRM desk that pulls **live prices** through a
serverless proxy.

- `index.html` — the dashboard (static front-end)
- `api/quotes.js` — serverless proxy that fetches live prices from Yahoo Finance
- `dashboard.html` — the earlier static-snapshot version, kept for reference

## How it works

The browser calls `/api/quotes`; that serverless function fetches from Yahoo
Finance's public endpoint (no API key needed) and returns normalized quotes. It
covers the whole board — US + global equities, indices, FX, commodities, crypto.
The status chip (top-right) shows how many symbols are live, e.g. `Live · 19/19`.
Anything that can't be fetched keeps its baked-in snapshot value, so the page
never shows snapshot data dressed up as live.

Prices are near-real-time; some exchanges are delayed ~15 min, which is normal
for a free data source and fine for a desk view (not a trading terminal).

## Deploy (already done, for reference)

1. Sign in to <https://vercel.com> with GitHub (Hobby / free plan).
2. **Add New → Project**, import **`vivianchan-cyber/Vivian`**.
3. Framework preset **Other**, leave defaults, click **Deploy**.

No environment variables are required. Every push to the deployed branch
redeploys automatically.

## Tuning & maintenance

- **Add/remove a ticker's live feed:** edit `YF_MAP` in `api/quotes.js`
  (map your display ticker → Yahoo Finance ticker, e.g. `'9988.HK': '9988.HK'`).
- **Change refresh speed:** `REFRESH_MS` near the bottom of `index.html` (default 60s).
- **Server cache:** set `QUOTE_CACHE_SECONDS` in Vercel env vars (default 60) to
  control how often the server re-fetches upstream.
- **Macro rates, calendar, research, CRM** are editorial content, not a price
  feed — ask Claude to refresh those.

## Run locally (optional)
```bash
npm i -g vercel
vercel dev
```

*Not investment advice.*
