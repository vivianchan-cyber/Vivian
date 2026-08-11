// api/earnings.js — serverless endpoint for next earnings & ex-dividend dates.
//
// These change slowly, so this is deliberately separate from the 60s price poll:
// the browser calls it on load and every few hours, and results are cached 6h.
//
// Source: Yahoo Finance quoteSummary `calendarEvents`. That endpoint requires a
// cookie + "crumb" token, so we establish a short-lived session first. If the
// session or a lookup fails, the symbol returns ok:false and the UI shows "—"
// (never a stale/guessed date).
//
// Response: { results: [{ symbol, ok, earningsDate, estimate, exDivDate }] }
// dates are ISO 'YYYY-MM-DD' or null.

const { YF_MAP } = require('./quotes.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const EARN_TTL = 6 * 3600 * 1000;   // per-symbol cache
const SESSION_TTL = 60 * 60 * 1000; // cookie+crumb reuse

function setCookies(r) {
  const list = r.headers.getSetCookie ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  return list.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

let session = { cookie: null, crumb: null, at: 0 };
async function getSession(force) {
  if (!force && session.crumb && Date.now() - session.at < SESSION_TTL) return session;
  let cookie = null;
  for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      cookie = setCookies(r);
      if (cookie) break;
    } catch (e) {}
  }
  let crumb = null;
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb',
      { headers: { 'User-Agent': UA, 'Cookie': cookie || '' } });
    const t = (await r.text()).trim();
    // A valid crumb is a short token; anything HTML-ish or long is an error page.
    if (t && t.length <= 24 && t.indexOf('<') === -1) crumb = t;
  } catch (e) {}
  session = { cookie, crumb, at: Date.now() };
  return session;
}

const isoDay = sec => (typeof sec === 'number' ? new Date(sec * 1000).toISOString().slice(0, 10) : null);

const earnCache = {};
async function fetchEarnings(display, allowRetry) {
  const c = earnCache[display];
  if (c && Date.now() - c.at < EARN_TTL) return c.data;

  const yf = YF_MAP[display] || display;
  const s = await getSession(false);
  if (!s.crumb) return { symbol: display, ok: false, reason: 'no session' };

  const url = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' +
    encodeURIComponent(yf) + '?modules=calendarEvents&crumb=' + encodeURIComponent(s.crumb);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': s.cookie || '' } });
    if (r.status === 401 && allowRetry) { await getSession(true); return fetchEarnings(display, false); }
    if (!r.ok) return { symbol: display, ok: false, reason: 'HTTP ' + r.status };
    const j = await r.json();
    const ce = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0] &&
      j.quoteSummary.result[0].calendarEvents;
    const earn = ce && ce.earnings;
    let earningsDate = null, estimate = false;
    if (earn && Array.isArray(earn.earningsDate) && earn.earningsDate.length) {
      earningsDate = isoDay(earn.earningsDate[0].raw);
      estimate = !!earn.isEarningsDateEstimate;
    }
    const exDivDate = ce && ce.exDividendDate ? isoDay(ce.exDividendDate.raw) : null;
    const data = { symbol: display, ok: true, earningsDate: earningsDate, estimate: estimate, exDivDate: exDivDate };
    earnCache[display] = { at: Date.now(), data: data };
    return data;
  } catch (e) {
    return { symbol: display, ok: false, reason: 'fetch failed' };
  }
}

module.exports = async (req, res) => {
  const symbols = String((req.query && req.query.symbols) || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  if (!symbols.length) return res.status(200).json({ results: [] });

  const results = await Promise.all(symbols.map((s, i) => fetchEarnings(s, i === 0)));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ source: 'yahoo', fetchedAt: new Date().toISOString(), results: results });
};
