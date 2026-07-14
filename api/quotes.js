// api/quotes.js — serverless price proxy for Vivian's Desk (Vercel Node function)
//
// Source: Yahoo Finance public chart endpoint (v8). No API key required, and it
// covers the whole board — US + global equities, indices, FX, commodities, crypto.
// The browser calls THIS endpoint; the server fetches upstream, so there are no
// CORS issues and no secret to leak.
//
// Response contract (unchanged, so the front-end needs no rewrite):
//   { live, fetchedAt, cacheSeconds, quotes: [{ symbol, ok, price, changePct, currency }] }
// `symbol` is always our DISPLAY key (e.g. 'NVDA', 'SPX', '000660.KS'), not the
// Yahoo ticker — that's what the front-end matches on.
//
// Optional env var:
//   QUOTE_CACHE_SECONDS  seconds the server reuses a response (default 60).

const CACHE_SECONDS = parseInt(process.env.QUOTE_CACHE_SECONDS || '60', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Display key (what the front-end sends) → Yahoo Finance ticker.
// Add a row here to make a new watchlist ticker go live.
const YF_MAP = {
  // Indices (tape)
  SPX: '^GSPC', IXIC: '^IXIC', STI: '^STI', N225: '^N225',
  HSI: '^HSI', XJO: '^AXJO', KS11: '^KS11',
  // Commodities & crypto (tape)
  'XAU/USD': 'GC=F', BRENT: 'BZ=F', 'BTC/USD': 'BTC-USD',
  // Equities (watchlist) — most are already Yahoo-format
  NVDA: 'NVDA', TSM: 'TSM', ASML: 'ASML', AAPL: 'AAPL',
  '000660.KS': '000660.KS', '005930.KS': '005930.KS',
  'D05.SI': 'D05.SI', 'BHP.AX': 'BHP.AX', '7203.T': '7203.T'
};

// Extract our normalized quote from a Yahoo chart payload. Exported for tests.
function parseYahoo(display, json) {
  const meta = json && json.chart && json.chart.result &&
               json.chart.result[0] && json.chart.result[0].meta;
  if (!meta) {
    const err = json && json.chart && json.chart.error;
    return { symbol: display, ok: false, reason: (err && err.description) || 'no data' };
  }
  const price = meta.regularMarketPrice;
  const prev = meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
  if (typeof price !== 'number' || !isFinite(price)) {
    return { symbol: display, ok: false, reason: 'no price' };
  }
  const changePct = (typeof prev === 'number' && prev !== 0)
    ? ((price - prev) / prev) * 100
    : null;
  return {
    symbol: display,
    ok: true,
    price: price,
    changePct: changePct,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    marketOpen: meta.marketState ? meta.marketState === 'REGULAR' : undefined
  };
}

async function fetchOne(display) {
  // Known display keys use their mapped Yahoo ticker; anything the user typed
  // (e.g. "0358.HK") is passed straight through — Yahoo accepts most tickers.
  const yf = YF_MAP[display] || display;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yf);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) return { symbol: display, ok: false, reason: 'HTTP ' + r.status };
    const json = await r.json();
    return parseYahoo(display, json);
  } catch (e) {
    return { symbol: display, ok: false, reason: 'fetch failed' };
  }
}

let cache = { at: 0, key: '', data: null };

module.exports = async (req, res) => {
  const requested = String((req.query && req.query.symbols) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const symbols = requested.length ? requested : Object.keys(YF_MAP);

  const cacheKey = symbols.join(',');
  const now = Date.now();
  if (cache.data && cache.key === cacheKey && now - cache.at < CACHE_SECONDS * 1000) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    return res.status(200).json(cache.data);
  }

  const results = await Promise.all(symbols.map(fetchOne));
  const payload = {
    live: true,
    source: 'yahoo',
    fetchedAt: new Date().toISOString(),
    cacheSeconds: CACHE_SECONDS,
    quotes: results
  };
  cache = { at: now, key: cacheKey, data: payload };

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  return res.status(200).json(payload);
};

module.exports.parseYahoo = parseYahoo;
module.exports.YF_MAP = YF_MAP;
