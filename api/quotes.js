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
  SPX: '^GSPC', IXIC: '^IXIC', DJI: '^DJI', STI: '^STI', N225: '^N225',
  HSI: '^HSI', XJO: '^AXJO', KS11: '^KS11',
  'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F', COPPER: 'HG=F', BRENT: 'BZ=F', 'BTC/USD': 'BTC-USD',
  'SGD/USD': 'SGDUSD=X', 'SGD/AUD': 'SGDAUD=X', 'AUD/USD': 'AUDUSD=X',
  UST2Y: '2YY=F', UST5Y: '^FVX', UST10Y: '^TNX', UST30Y: '^TYX', // yields, quoted in %
  NVDA: 'NVDA', TSM: 'TSM', ASML: 'ASML', AAPL: 'AAPL',
  '000660.KS': '000660.KS', '005930.KS': '005930.KS',
  'D05.SI': 'D05.SI', 'BHP.AX': 'BHP.AX', '7203.T': '7203.T'
};

// Names we already know — seeded so only user-added tickers need a lookup.
// (indices/commodities are seeded too so they never trigger a search call.)
const NAME_SEED = {
  SPX: 'S&P 500', IXIC: 'NASDAQ', DJI: 'Dow Jones', STI: 'STI', N225: 'Nikkei 225', HSI: 'Hang Seng',
  XJO: 'ASX 200', KS11: 'KOSPI', 'XAU/USD': 'Gold', 'XAG/USD': 'Silver', COPPER: 'Copper',
  BRENT: 'Brent Crude', 'BTC/USD': 'Bitcoin',
  'SGD/USD': 'SGD/USD', 'SGD/AUD': 'SGD/AUD', 'AUD/USD': 'AUD/USD',
  UST2Y: 'US 2Y', UST5Y: 'US 5Y', UST10Y: 'US 10Y', UST30Y: 'US 30Y',
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
  if (typeof price !== 'number' || !isFinite(price)) {
    return { symbol: display, ok: false, reason: 'no price' };
  }

  // DAILY change: compare to the most recent PRIOR trading-day close taken from
  // the daily closes array. (meta.chartPreviousClose is the start of the 3-month
  // range — using it would report a 3-month return, not the day's move.)
  let closes = [];
  try { closes = result.indicators.quote[0].close || []; } catch (e) {}
  const lastTwo = [];
  for (let i = closes.length - 1; i >= 0 && lastTwo.length < 2; i--) {
    if (typeof closes[i] === 'number' && closes[i] > 0) lastTwo.push(closes[i]);
  }
  let prev = lastTwo.length >= 2 ? lastTwo[1]
    : (typeof meta.previousClose === 'number' ? meta.previousClose : null);
  const changePct = (typeof prev === 'number' && prev !== 0) ? ((price - prev) / prev) * 100 : null;

  // Volume: today vs the trailing ~3 months (≈63 sessions) of daily volume.
  let vols = [];
  try { vols = result.indicators.quote[0].volume || []; } catch (e) {}
  const cleanV = vols.filter(v => typeof v === 'number' && v > 0);
  const today = (typeof meta.regularMarketVolume === 'number' && meta.regularMarketVolume > 0)
    ? meta.regularMarketVolume
    : (cleanV.length ? cleanV[cleanV.length - 1] : null);
  const histAll = cleanV.length > 1 ? cleanV.slice(0, cleanV.length - 1) : cleanV;
  const hist = histAll.slice(-63);
  const avgVol3M = hist.length ? Math.round(hist.reduce((a, b) => a + b, 0) / hist.length) : null;
  const volRatio = (avgVol3M && today) ? today / avgVol3M : null;

  // YTD change: first close of the current calendar year vs current price.
  let ytdPct = null;
  const ts = result.timestamp || [];
  const yearNow = new Date().getUTCFullYear();
  for (let i = 0; i < closes.length; i++) {
    if (typeof closes[i] === 'number' && closes[i] > 0 && ts[i] &&
        new Date(ts[i] * 1000).getUTCFullYear() === yearNow) {
      ytdPct = ((price - closes[i]) / closes[i]) * 100;
      break;
    }
  }

  return {
    symbol: display, ok: true, price: price, changePct: changePct, ytdPct: ytdPct,
    prevClose: (typeof prev === 'number' ? prev : null),
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    volume: today, avgVol3M: avgVol3M, volRatio: volRatio
  };
}

async function fetchOne(display) {
  const yf = YF_MAP[display] || display;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yf) + '?range=1y&interval=1d';
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

// Top news headline per symbol — fetched only for movers, cached ~10 min.
const NEWS_TTL = 10 * 60 * 1000;
const MOVER_PCT = 5;
const SPIKE_RATIO = 1.5; // mirror the front-end volume threshold
const NEWS_MAX_AGE = 36 * 3600; // seconds — only "on the day" news counts

// Pick the best headline for a mover: it must be RECENT (within NEWS_MAX_AGE) and,
// where Yahoo tags related tickers, actually about this stock. If nothing recent
// qualifies, return null so the UI shows "no same-day news" rather than a stale
// or off-topic article. Pure function, unit-tested.
function selectHeadline(items, yf, display, name, nowSec) {
  const up = String(yf).toUpperCase(), dp = String(display).toUpperCase();
  const nm = name ? String(name).toLowerCase() : null;
  const fresh = (items || []).filter(n =>
    (n.providerPublishTime || 0) > 0 && (nowSec - n.providerPublishTime) <= NEWS_MAX_AGE);
  // Relevant = Yahoo tags this stock's ticker, OR the company name is in the title.
  // No generic-news fallback: an unrelated headline is worse than none.
  const relevant = fresh.filter(n => {
    const tickers = (n.relatedTickers || []).map(s => String(s).toUpperCase());
    if (tickers.some(s => s === up || s === dp)) return true;
    return nm && n.title && n.title.toLowerCase().indexOf(nm) !== -1;
  });
  relevant.sort((a, b) => (b.providerPublishTime || 0) - (a.providerPublishTime || 0));
  const n = relevant[0];
  if (!n) return null;
  return {
    title: n.title, publisher: n.publisher || null, link: n.link || null,
    time: n.providerPublishTime || null
  };
}

const newsCache = {};
async function resolveNews(display) {
  const c = newsCache[display];
  if (c && Date.now() - c.at < NEWS_TTL) return c.data;
  const yf = YF_MAP[display] || display;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' +
      encodeURIComponent(yf) + '&quotesCount=0&newsCount=10', { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const data = selectHeadline((j && j.news) || [], yf, display, nameCache[display], Date.now() / 1000);
    newsCache[display] = { at: Date.now(), data: data };
    return data;
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
  // Attach a live news headline to price movers and volume spikers only,
  // to keep request volume low.
  await Promise.all(results.map(async q => {
    var isMover = q.ok && q.changePct != null && Math.abs(q.changePct) >= MOVER_PCT;
    var isSpike = q.ok && q.volRatio != null && q.volRatio >= SPIKE_RATIO;
    if (isMover || isSpike) q.headline = await resolveNews(q.symbol);
  }));

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
module.exports.selectHeadline = selectHeadline;
