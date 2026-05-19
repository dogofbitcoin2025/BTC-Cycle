// api/signals.js
// Vercel Edge Function — fetches all macro signals server-side
// Deploy to Vercel, set env vars: FRED_API_KEY
// URL: https://your-project.vercel.app/api/signals

export const config = { runtime: 'edge' };

const FRED = (id, key) =>
  `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=2`;

// ── Helpers ──────────────────────────────────────────────
async function fetchFred(seriesId, key) {
  try {
    const r = await fetch(FRED(seriesId, key), { cf: { cacheTtl: 300 } });
    if (!r.ok) return null;
    const j = await r.json();
    const obs = (j.observations || []).filter(o => o.value !== '.');
    if (!obs.length) return null;
    const latest = parseFloat(obs[0].value);
    const prev = obs[1] ? parseFloat(obs[1].value) : null;
    return { value: latest, prev, date: obs[0].date };
  } catch (e) { return null; }
}

async function fetchYahoo(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cf: { cacheTtl: 300 }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators.quote[0].close.filter(v => v !== null);
    if (!closes.length) return null;
    return {
      value: closes[closes.length - 1],
      prev: closes.length > 1 ? closes[closes.length - 2] : null,
      date: new Date(result.timestamp[result.timestamp.length - 1] * 1000).toISOString().slice(0, 10)
    };
  } catch (e) { return null; }
}

async function fetchBTC() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
      { cf: { cacheTtl: 60 } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.bitcoin) return null;
    return {
      value: j.bitcoin.usd,
      change24h: j.bitcoin.usd_24h_change,
      date: new Date().toISOString().slice(0, 10)
    };
  } catch (e) { return null; }
}

async function fetchFarside() {
  // Scrape the Farside HTML table — 5-day rolling sum
  try {
    const r = await fetch('https://farside.co.uk/btc/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cf: { cacheTtl: 1800 }
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Parse rows: <tr><td>DD MMM YYYY</td>...<td class="...">TOTAL</td></tr>
    // The total column is the last numeric td in each data row
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gs;
    const numRegex = /<td[^>]*>(-?[\d,]+\.?\d*)<\/td>/g;
    const dateRegex = /<td[^>]*>(\d{1,2}\s+\w{3}\s+\d{4})<\/td>/;

    const recentTotals = [];
    let m;
    while ((m = rowRegex.exec(html)) !== null && recentTotals.length < 5) {
      const row = m[1];
      const dateMatch = row.match(dateRegex);
      if (!dateMatch) continue;
      // Find last numeric td (total)
      const nums = [...row.matchAll(numRegex)].map(x => parseFloat(x[1].replace(/,/g, '')));
      if (nums.length < 1) continue;
      const total = nums[nums.length - 1];
      if (!isNaN(total)) recentTotals.push({ date: dateMatch[1], total });
    }
    if (!recentTotals.length) return null;
    const sum5d = recentTotals.reduce((a, b) => a + b.total, 0);
    return {
      value: Math.round(sum5d),       // 5-day rolling net flow (USD m)
      latest: recentTotals[0].total,  // most recent day
      date: recentTotals[0].date
    };
  } catch (e) { return null; }
}

// ── Handler ──────────────────────────────────────────────
export default async function handler(req) {
  const url = new URL(req.url);
  const key = process.env.FRED_API_KEY;

  if (!key) {
    return new Response(JSON.stringify({ error: 'FRED_API_KEY not set' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  const [
    dgs10, dfii10, sofr, fedfunds, tga, btc, move, dxy, etf
  ] = await Promise.all([
    fetchFred('DGS10', key),       // 10Y nominal
    fetchFred('DFII10', key),      // 10Y TIPS real yield
    fetchFred('SOFR', key),        // overnight SOFR
    fetchFred('DFF', key),         // Fed funds effective
    fetchFred('WTREGEN', key),     // Treasury General Account
    fetchBTC(),
    fetchYahoo('%5EMOVE'),         // ICE BofA MOVE Index
    fetchYahoo('DX-Y.NYB'),        // Dollar Index
    fetchFarside()
  ]);

  // Compute SOFR – Fed Funds spread (bps)
  let sofrSpread = null;
  if (sofr?.value !== undefined && fedfunds?.value !== undefined) {
    sofrSpread = Math.round((sofr.value - fedfunds.value) * 100); // bps
  }

  // Days post-halving (2024-04-19)
  const halv = new Date('2024-04-19');
  const daysPostHalving = Math.floor((Date.now() - halv.getTime()) / 86400000);

  const body = {
    updated: new Date().toISOString(),
    signals: {
      move:     move     ? { value: move.value,     prev: move.prev,     date: move.date } : null,
      realrate: dfii10   ? { value: dfii10.value,   prev: dfii10.prev,   date: dfii10.date } : null,
      etf:      etf      ? { value: etf.value,      latest: etf.latest,  date: etf.date } : null,
      tga:      tga      ? { value: tga.value,      prev: tga.prev,      date: tga.date } : null,
      sofr:     sofrSpread !== null ? { value: sofrSpread, sofr: sofr.value, fedfunds: fedfunds.value, date: sofr.date } : null,
      dxy:      dxy      ? { value: dxy.value,      prev: dxy.prev,      date: dxy.date } : null,
      btc:      btc      ? { value: btc.value,      change24h: btc.change24h, date: btc.date } : null,
      halving:  { value: daysPostHalving, date: new Date().toISOString().slice(0, 10) },
      // bonus context
      dgs10:    dgs10    ? { value: dgs10.value,    prev: dgs10.prev,    date: dgs10.date } : null
    }
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=60'
    }
  });
}
