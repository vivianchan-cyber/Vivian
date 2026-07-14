// api/quotes.js — serverless price proxy for Vivian's Desk (Vercel Node function)
//
// Source: Yahoo Finance public endpoints (no API key). The chart endpoint gives
// price + 3 months of daily volume (for spike detection); the search endpoint
// resolves a human company name for tickers we don't already know.
//
// Response contract per quote:
//   { symbol, ok, price, changePct, currency, exchange, name,
//     volume, avgVol3M, volRatio }
// `symbol` is always the DISPLAY key the front-end sent.

const CACHE_SECONDS = parseInt(process.env.QUOTE_CACHE_SECONDS || '60', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Display key (front-end) → Yahoo ticker. Add a row to make a symbol go live.
const YF_MAP = {
  SPX: '^GSPC', IXIC: '^IXIC', STI: '^STI', N225: '^N225',
  HSI: '^HSI', XJO: '^AXJO', KS11: '^KS11',
  'XAU/USD': 'GC=F', BRENT: 'BZ=F', 'BTC/USD': 'BTC-USD',
  NVDA: 'NVDA', TSM: 'TSM', ASML: 'ASML', AAPL: 'AAPL',
  '000660.KS': '000660.KS', '005930.KS': '005930.KS',
  'D05.SI': 'D05.SI', 'BHP.AX': 'BHP.AX', '7203.T': '7203.T'
};

// Names we already know — seeded so only user-added tickers need a lookup.
// (indices/commodities are seeded too so they never trigger a search call.)
const NAME_SEED = {
  SPX: 'S&P 500', IXIC: 'NASDAQ', STI: 'STI', N225: 'Nikkei 225', HSI: 'Hang Seng',
  XJO: 'ASX 200', KS11: 'KOSPI', 'XAU/USD': 'Gold', BRENT: 'Brent Crude', 'BTC/USD': 'Bitcoin',
  NVDA: 'NVIDIA', TSM: 'TSMC ADR', ASML: 'ASML Holding', AAPL: 'Apple',
  '000660.KS': 'SK Hynix', '005930.KS': 'Samsung Elec', 'D05.SI': 'DBS Group',
  'BHP.AX': 'BHP Group', '7203.T': 'Toyota Motor'
};
const nameCache = Object.assign({}, NAME_SEED);

function parseYahoo(display, json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  const meta = result && result.meta;
  if (!meta) {
    const err = json && json.chart && json.chart.error;
    return { symbol: display, ok: false, reason: (err && err.description) || 'no data' };
  }
  const price = meta.regularMarketPrice;
  const prev = meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
  if (typeof price !== 'number' || !isFinite(price)) {
    return { symbol: display, ok: false, reason: 'no price' };
  }
  const changePct = (typeof prev === 'number' && prev !== 0) ? ((price - prev) / prev) * 100 : null;

  // Volume: today vs average of the prior ~3 months of daily volume.
  let vols = [];
  try { vols = result.indicators.quote[0].volume || []; } catch (e) {}
  const clean = vols.filter(v => typeof v === 'number' && v > 0);
  let today = (typeof meta.regularMarketVolume === 'number' && meta.regularMarketVolume > 0)
    ? meta.regularMarketVolume
    : (clean.length ? clean[clean.length - 1] : null);
  const hist = clean.length > 1 ? clean.slice(0, clean.length - 1) : clean;
  const avgVol3M = hist.length ? Math.round(hist.reduce((a, b) => a + b, 0) / hist.length) : null;
  const volRatio = (avgVol3M && today) ? today / avgVol3M : null;

  return {
    symbol: display, ok: true, price: price, changePct: changePct,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    volume: today, avgVol3M: avgVol3M, volRatio: volRatio
  };
}

async function fetchOne(display) {
  const yf = YF_MAP[display] || display;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yf) + '?range=3mo&interval=1d';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) return { symbol: display, ok: false, reason: 'HTTP ' + r.status };
    return parseYahoo(display, await r.json());
  } catch (e) {
    return { symbol: display, ok: false, reason: 'fetch failed' };
  }
}

// Resolve a display name via Yahoo search. Cached (incl. seeds) so only
// user-added tickers ever hit the network, once each.
async function resolveName(display) {
  if (Object.prototype.hasOwnProperty.call(nameCache, display)) return nameCache[display];
  const yf = YF_MAP[display] || display;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' +
      encodeURIComponent(yf) + '&quotesCount=1&newsCount=0', { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const q = j && j.quotes && j.quotes[0];
    const nm = q ? (q.shortname || q.longname || null) : null;
    nameCache[display] = nm; // cache result (even null) to avoid refetch storms
    return nm;
  } catch (e) { return null; }
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
  await Promise.all(results.map(async q => { if (q.ok) q.name = await resolveName(q.symbol); }));

  const payload = {
    live: true, source: 'yahoo', fetchedAt: new Date().toISOString(),
    cacheSeconds: CACHE_SECONDS, quotes: results
  };
  cache = { at: now, key: cacheKey, data: payload };

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  return res.status(200).json(payload);
};

module.exports.parseYahoo = parseYahoo;
module.exports.YF_MAP = YF_MAP;
