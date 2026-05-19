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
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cf: { cacheTtl: 300 }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators.quote[0].close;
    const volumes = result.indicators.quote[0].volume;
    const cleanCloses = closes.filter(v => v !== null);
    if (!cleanCloses.length) return null;
    return {
      value: cleanCloses[cleanCloses.length - 1],
      prev: cleanCloses.length > 1 ? cleanCloses[cleanCloses.length - 2] : null,
      closes,
      volumes,
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

// IBIT flow proxy: 5-day rolling dollar-volume change as a proxy for net flows
// IBIT is ~50% of the ETF market; daily volume * price strongly correlates
// with actual net flows (creation/redemption activity)
async function fetchIBITFlowProxy() {
  try {
    const ibit = await fetchYahoo('IBIT');
    if (!ibit || !ibit.closes || !ibit.volumes) return null;

    // Last 5 trading days dollar volume in millions
    const pairs = [];
    for (let i = ibit.closes.length - 1; i >= 0 && pairs.length < 5; i--) {
      if (ibit.closes[i] !== null && ibit.volumes[i] !== null) {
        pairs.push(ibit.closes[i] * ibit.volumes[i]);
      }
    }
    if (!pairs.length) return null;

    // Avg daily dollar volume of IBIT (millions). This represents activity level.
    // We center around historical median (~$1.5B/day) to approximate net flow polarity:
    // Above median = strong inflow regime, below = outflow regime
    const avgDailyDollarVol = pairs.reduce((a, b) => a + b, 0) / pairs.length;
    const avgMillions = avgDailyDollarVol / 1_000_000;

    // Convert IBIT activity → market-wide flow estimate
    // IBIT ~= 50% of market, so 5d net ≈ (avg - median) * 5 * 2
    const HISTORICAL_DAILY_MEDIAN_M = 1500; // ~$1.5B median daily IBIT volume
    const fiveDayNetEstimate = Math.round((avgMillions - HISTORICAL_DAILY_MEDIAN_M) * 5 * 2);

    return {
      value: fiveDayNetEstimate,
      ibit_avg_volume_m: Math.round(avgMillions),
      ibit_price: ibit.value,
      date: ibit.date,
      note: 'IBIT-based proxy; correlated with but not equal to Farside net flows'
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
    fetchFred('DGS10', key),
    fetchFred('DFII10', key),
    fetchFred('SOFR', key),
    fetchFred('DFF', key),
    fetchFred('WTREGEN', key),
    fetchBTC(),
    fetchYahoo('%5EMOVE'),
    fetchYahoo('DX-Y.NYB'),
    fetchIBITFlowProxy()
  ]);

  // SOFR – Fed Funds spread (bps)
  let sofrSpread = null;
  if (sofr?.value !== undefined && fedfunds?.value !== undefined) {
    sofrSpread = Math.round((sofr.value - fedfunds.value) * 100);
  }

  const halv = new Date('2024-04-19');
  const daysPostHalving = Math.floor((Date.now() - halv.getTime()) / 86400000);

  const body = {
    updated: new Date().toISOString(),
    signals: {
      move:     move     ? { value: move.value,     prev: move.prev,     date: move.date } : null,
      realrate: dfii10   ? { value: dfii10.value,   prev: dfii10.prev,   date: dfii10.date } : null,
      etf:      etf      ? { value: etf.value, ibit_avg_volume_m: etf.ibit_avg_volume_m, ibit_price: etf.ibit_price, date: etf.date, note: etf.note } : null,
      tga:      tga      ? { value: tga.value,      prev: tga.prev,      date: tga.date } : null,
      sofr:     sofrSpread !== null ? { value: sofrSpread, sofr: sofr.value, fedfunds: fedfunds.value, date: sofr.date } : null,
      dxy:      dxy      ? { value: dxy.value,      prev: dxy.prev,      date: dxy.date } : null,
      btc:      btc      ? { value: btc.value,      change24h: btc.change24h, date: btc.date } : null,
      halving:  { value: daysPostHalving, date: new Date().toISOString().slice(0, 10) },
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
