# Vivian's Desk — live dashboard

A markets / portfolio / research / CRM desk that pulls **live prices** through a
secure serverless proxy, so your API key never touches the browser.

- `index.html` — the dashboard (static front-end, no secrets)
- `api/quotes.js` — serverless proxy that holds the API key and fetches prices
- `dashboard.html` — the earlier static-snapshot version, kept for reference

Until it's deployed with a key, the page runs on a **baked-in snapshot** from
13–14 Jul 2026 and the status chip (top-right) says so. Deploy the two steps
below and the same page starts updating itself.

---

## What "live" realistically means here

Data providers meter you by **credits** (one per symbol per fetch). On a typical
**free tier (~800 credits/day)**, this ~20-symbol board can do about **40 full
refreshes a day — roughly one update every 20–30 minutes**, and non-US names may
be end-of-day rather than intraday. That's *auto-updating*, not a tick-by-tick
trading screen.

For **real-time**, including Singapore / Korea / Japan / Australia intraday, you
need a **paid plan (~$30–80/mo)**. Nothing in the code changes — you just paste a
different key. The status chip always shows how many symbols are genuinely live
(e.g. `Live · 12/20`), so the page never pretends snapshot data is current.

---

## Deploy in two steps (~5 minutes)

### 1. Get a data API key (free)
1. Sign up at <https://twelvedata.com/pricing> → **Basic (Free)**.
2. Copy your **API key** from the dashboard.

### 2. Deploy to Vercel (free)
1. Go to <https://vercel.com> and sign in with GitHub.
2. **Add New → Project**, import **`vivianchan-cyber/Vivian`**.
3. Framework preset: **Other** (no build step needed). Leave defaults.
4. Open **Environment Variables** and add:
   - `TWELVEDATA_API_KEY` = *(the key from step 1)*
   - `QUOTE_CACHE_SECONDS` = `60` *(optional; raise to `300` to save credits)*
5. Click **Deploy**.

Vercel gives you a URL like `https://vivian.vercel.app`. Open it — the chip turns
green (`● Live · N/M · HH:MM SGT`) once quotes arrive. That URL is your live desk;
bookmark it.

Every push to this branch redeploys automatically.

---

## Tuning & maintenance

- **Hitting rate limits?** Raise `QUOTE_CACHE_SECONDS` (e.g. `300`) in Vercel env
  vars, or reduce symbols. The server caches so multiple opens don't multiply calls.
- **Add/remove a ticker's live feed:** edit `SYMBOL_MAP` in `api/quotes.js`
  (map your display ticker → provider symbol + exchange).
- **Change refresh speed:** `REFRESH_MS` near the bottom of `index.html`.
- **Switch providers** (Finnhub, Polygon, …): re-implement `fetchOne()` in
  `api/quotes.js`; the front-end contract (`{symbol, ok, price, changePct}`) stays.
- **Macro rates, calendar, research, CRM** are editorial content, not a price
  feed — ask Claude to refresh those.

---

## Run locally (optional)
```bash
npm i -g vercel
vercel dev            # serves index.html + /api/quotes with your local .env
```
Create a `.env` (copy `.env.example`) with your key first. `.env` is gitignored.

*Not investment advice.*
