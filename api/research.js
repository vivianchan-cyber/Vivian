// api/research.js — serverless endpoint for the Research panel.
// For each theme we pull Yahoo's per-ticker news (which is tightly scoped to the
// company, unlike free-text keyword search) for a handful of representative names,
// then merge, de-duplicate, keep the recent items (<5 days) and return newest
// first. No API key needed; cached ~30 min. All tickers are US-listed so the
// headlines come back in English and on-topic.
//
// Response: { topics: { "<label>": [{ title, publisher, link, time }], ... } }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MAX_AGE = 5 * 24 * 3600; // seconds
const CACHE_TTL = 30 * 60 * 1000;

// Theme label -> representative tickers whose news defines the theme.
const TOPIC_TICKERS = {
  'AI & Semis': ['NVDA', 'TSM', 'ASML', 'AMD', 'AVGO'],
  'China': ['BABA', 'PDD', 'JD', 'NIO', 'BIDU'],
  'Japan': ['TM', 'SONY', 'MUFG', 'HMC'],       // ADRs — English news
  'Energy': ['XOM', 'CVX', 'SHEL', 'BP', 'COP']
};

// Yahoo's per-ticker feed mixes in generic "related reads" (Fed, Zillow, air
// taxis, IRS tips). Keep only headlines that actually mention the theme.
const TOPIC_RE = {
  'AI & Semis': /\b(AI|artificial intelligence|chips?|semiconductors?|semis|GPUs?|Nvidia|AMD|TSMC|ASML|Broadcom|Intel|foundry|data ?cent(er|re)|accelerators?|Micron|Hynix|Samsung|wafers?|lithography|Arm|Qualcomm|Blackwell)\b/i,
  'China': /\b(China|Chinese|Beijing|Alibaba|Tencent|Baidu|PDD|Pinduoduo|JD\.?com|BYD|Hang Seng|yuan|renminbi|Shanghai|Shenzhen|Hong Kong|NIO|Xpeng|Li Auto|Meituan)\b/i,
  'Japan': /\b(Japan|Japanese|Tokyo|Toyota|Sony|Nintendo|Honda|Nikkei|yen|BOJ|Bank of Japan|SoftBank|Mitsubishi|Hitachi|Nissan|Nomura|Keio)\b/i,
  'Energy': /\b(oil|crude|Brent|WTI|OPEC|natural gas|LNG|energy|Exxon|Chevron|Shell|\bBP\b|ConocoPhillips|refin(er|ing|ery)|barrels?|petroleum|drilling|pipelines?|gasoline)\b/i
};

async function newsFor(ticker) {
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' +
      encodeURIComponent(ticker) + '&newsCount=8&quotesCount=0&enableFuzzyQuery=false',
      { headers: { 'User-Agent': UA } });
    const j = await r.json();
    return (j && j.news) || [];
  } catch (e) { return []; }
}

const cache = {};
async function fetchTopic(label) {
  const c = cache[label];
  if (c && Date.now() - c.at < CACHE_TTL) return c.data;
  const tickers = TOPIC_TICKERS[label] || [];
  const re = TOPIC_RE[label];
  const lists = await Promise.all(tickers.map(newsFor));
  const now = Date.now() / 1000;
  const seen = {};
  const items = [];
  lists.forEach(function (arr) {
    arr.forEach(function (n) {
      if (!n.title || !(n.providerPublishTime > 0)) return;
      if (now - n.providerPublishTime > MAX_AGE) return;
      if (re && !re.test(n.title)) return; // drop off-topic "related reads"
      const key = (n.uuid || n.link || n.title).toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      items.push({ title: n.title, publisher: n.publisher || null, link: n.link || null, time: n.providerPublishTime });
    });
  });
  items.sort(function (a, b) { return b.time - a.time; });
  const out = items.slice(0, 6);
  cache[label] = { at: Date.now(), data: out };
  return out;
}

module.exports = async (req, res) => {
  const requested = String((req.query && req.query.topics) || '')
    .split('|').map(s => s.trim()).filter(Boolean).slice(0, 8);
  const labels = requested.length ? requested : Object.keys(TOPIC_TICKERS);
  const topics = {};
  await Promise.all(labels.map(async l => { topics[l] = await fetchTopic(l); }));
  res.setHeader('Cache-Control', 'public, max-age=900');
  return res.status(200).json({ source: 'yahoo', fetchedAt: new Date().toISOString(), topics: topics });
};
