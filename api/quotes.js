// api/quotes.js — serverless price proxy for Vivian's Desk (Vercel Node function)
//
// Why this file exists: an API key must never sit in front-end code (anyone could
// read it and run up your bill). The browser calls THIS endpoint; this endpoint
// adds the secret key and calls the data provider. The key stays on the server.
//
// Provider: Twelve Data (https://twelvedata.com) — one key covers US + global
// exchanges, FX, and crypto. Swap providers by re-implementing fetchFromProvider().
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   TWELVEDATA_API_KEY   your key  (required for live data)
//   QUOTE_CACHE_SECONDS  optional, default 60 — how long the server reuses a
//                        response before hitting the provider again. Higher =
//                        fewer API credits burned. Raise it if you hit limits.

const PROVIDER_URL = 'https://api.twelvedata.com/quote';
const CACHE_SECONDS = parseInt(process.env.QUOTE_CACHE_SECONDS || '60', 10);

// Map our display tickers to the provider's symbol + exchange.
// Twelve Data resolves most US symbols bare; non-US needs an explicit exchange.
// Index / commodity coverage varies by plan — anything the provider can't return
// is reported back as unavailable and the UI falls back to its snapshot value.
const SYMBOL_MAP = {
  // US equities
  NVDA: { symbol: 'NVDA' },
  AAPL: { symbol: 'AAPL' },
  ASML: { symbol: 'ASML' },
  TSM:  { symbol: 'TSM' },
  // Global equities (exchange required)
  'D05.SI':    { symbol: 'D05',    exchange: 'SGX' },
  '000660.KS': { symbol: '000660', exchange: 'KRX' },
  '005930.KS': { symbol: '005930', exchange: 'KRX' },
  '7203.T':    { symbol: '7203',   exchange: 'TSE' },
  'BHP.AX':    { symbol: 'BHP',    exchange: 'ASX' },
  // FX & crypto (widely available even on free tiers)
  'SGD/USD':   { symbol: 'SGD/USD' },
  'AUD/USD':   { symbol: 'AUD/USD' },
  'BTC/USD':   { symbol: 'BTC/USD' },
  // Indices & commodities (often paid-tier only — will gracefully degrade)
  SPX:  { symbol: 'SPX' },
  IXIC: { symbol: 'IXIC' },
  STI:  { symbol: 'STI' },
  N225: { symbol: 'N225' },
  HSI:  { symbol: 'HSI' },
  XJO:  { symbol: 'XJO' },
  KS11: { symbol: 'KS11' },
  'XAU/USD': { symbol: 'XAU/USD' }
};

// Simple in-memory cache. Persists while the serverless instance stays warm,
// which is enough to shield the provider from repeated browser polls.
let cache = { at: 0, key: '', data: null };

async function fetchOne(display, apiKey) {
  const map = SYMBOL_MAP[display];
  if (!map) return { symbol: display, ok: false, reason: 'unmapped' };

  const params = new URLSearchParams({ symbol: map.symbol, apikey: apiKey });
  if (map.exchange) params.set('exchange', map.exchange);

  try {
    const r = await fetch(`${PROVIDER_URL}?${params.toString()}`);
    const j = await r.json();
    // Provider signals errors with { status: 'error', message } or code fields.
    if (j.status === 'error' || j.code) {
      return { symbol: display, ok: false, reason: j.message || 'provider error' };
    }
    const price = parseFloat(j.close);
    const pct = parseFloat(j.percent_change);
    if (!isFinite(price)) return { symbol: display, ok: false, reason: 'no price' };
    return {
      symbol: display,
      ok: true,
      price,
      changePct: isFinite(pct) ? pct : null,
      currency: j.currency || null,
      marketOpen: j.is_market_open === true,
      name: j.name || null
    };
  } catch (e) {
    return { symbol: display, ok: false, reason: 'fetch failed' };
  }
}

module.exports = async (req, res) => {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  const requested = String((req.query && req.query.symbols) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const symbols = requested.length ? requested : Object.keys(SYMBOL_MAP);

  // No key configured yet → tell the UI to stay on its snapshot rather than error.
  if (!apiKey) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      live: false,
      reason: 'no_api_key',
      message: 'Set TWELVEDATA_API_KEY in Vercel to enable live data.',
      quotes: []
    });
  }

  const cacheKey = symbols.join(',');
  const now = Date.now();
  if (cache.data && cache.key === cacheKey && now - cache.at < CACHE_SECONDS * 1000) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    return res.status(200).json(cache.data);
  }

  const results = await Promise.all(symbols.map(s => fetchOne(s, apiKey)));
  const payload = {
    live: true,
    fetchedAt: new Date().toISOString(),
    cacheSeconds: CACHE_SECONDS,
    quotes: results
  };
  cache = { at: now, key: cacheKey, data: payload };

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  return res.status(200).json(payload);
};
