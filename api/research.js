// api/research.js — serverless endpoint for the Research panel.
// For each theme it queries Yahoo Finance news search and returns recent
// headlines (within 5 days), newest first. No API key needed; cached ~30 min.
//
// Response: { topics: { "<label>": [{ title, publisher, link, time }], ... } }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MAX_AGE = 5 * 24 * 3600; // seconds — themes move slower than single stocks
const CACHE_TTL = 30 * 60 * 1000;

// Theme label -> Yahoo news search query.
const TOPIC_Q = {
  'AI & Semis': 'semiconductor AI chip Nvidia TSMC',
  'China': 'China economy stocks Hang Seng',
  'Japan': 'Japan Nikkei economy Bank of Japan',
  'Energy': 'oil crude Brent energy prices'
};

const cache = {};
async function fetchTopic(label) {
  const c = cache[label];
  if (c && Date.now() - c.at < CACHE_TTL) return c.data;
  const q = TOPIC_Q[label] || label;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' +
      encodeURIComponent(q) + '&newsCount=15&quotesCount=0', { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const now = Date.now() / 1000;
    const items = ((j && j.news) || [])
      .filter(n => n.title && (n.providerPublishTime || 0) > 0 && (now - n.providerPublishTime) <= MAX_AGE)
      .sort((a, b) => (b.providerPublishTime || 0) - (a.providerPublishTime || 0))
      .slice(0, 5)
      .map(n => ({ title: n.title, publisher: n.publisher || null, link: n.link || null, time: n.providerPublishTime || null }));
    cache[label] = { at: Date.now(), data: items };
    return items;
  } catch (e) { return []; }
}

module.exports = async (req, res) => {
  const requested = String((req.query && req.query.topics) || '')
    .split('|').map(s => s.trim()).filter(Boolean).slice(0, 8);
  const labels = requested.length ? requested : Object.keys(TOPIC_Q);
  const topics = {};
  await Promise.all(labels.map(async l => { topics[l] = await fetchTopic(l); }));
  res.setHeader('Cache-Control', 'public, max-age=900');
  return res.status(200).json({ source: 'yahoo', fetchedAt: new Date().toISOString(), topics: topics });
};
