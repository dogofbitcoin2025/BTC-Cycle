# Cycle vs Liquidity — Macro Signal Desk

Live BTC regime monitor. Tracks 8 macro signals to score two opposing theses:
- **A · Calendar**: Halving cycle → October 2026 bottom
- **B · Liquidity**: Bond market breaks → stealth YCC → BTC reprices higher

## Architecture

```
┌─────────────────┐      ┌─────────────────────────┐      ┌──────────┐
│  Dashboard PWA  │ ───► │  Vercel Edge Function   │ ───► │   FRED   │
│  (index.html)   │      │   /api/signals          │      │  Yahoo   │
│                 │ ◄─── │   (5min cache)          │ ◄─── │  CoinGecko│
└─────────────────┘      └─────────────────────────┘      │  Farside │
                                                          └──────────┘
```

The Vercel proxy is required because Yahoo Finance and Farside block CORS, and FRED needs an API key you don't want exposed in client code.

## Files

- `index.html` — the dashboard PWA (deploy as static site)
- `api/signals.js` — Vercel Edge Function (the proxy)

## Deployment

### 1. Get a FRED API key (free, 30 seconds)

Go to https://fred.stlouisfed.org/docs/api/api_key.html, create an account, request a key. You'll get a 32-character key instantly.

### 2. Push to Vercel

```bash
mkdir cycle-vs-liquidity && cd cycle-vs-liquidity
mkdir api
# place index.html in root
# place signals.js in api/
git init
git add . && git commit -m "init"
vercel
```

Or use the Vercel web dashboard: import from GitHub or drag-and-drop the folder.

### 3. Set environment variable

In your Vercel project → Settings → Environment Variables:

```
FRED_API_KEY = your_32_char_key_here
```

Redeploy.

### 4. Connect the dashboard

Open your deployed site. In the top bar, enter:

```
https://your-project.vercel.app/api/signals
```

Click **Connect**. The dot turns green and all signals populate. URL persists in localStorage — next visit it auto-fetches.

## Data sources

| Signal       | Source       | Update freq    | Notes |
|--------------|--------------|----------------|-------|
| MOVE         | Yahoo `^MOVE`| Daily (close)  | Bond vol index |
| 10Y Real     | FRED `DFII10`| Daily          | TIPS yield |
| ETF flows    | Farside HTML | Daily (evening US) | 5-day rolling, scraped |
| TGA          | FRED `WTREGEN`| Weekly        | Treasury cash balance |
| SOFR–FedFunds| FRED `SOFR`,`DFF` | Daily      | Funding stress spread (bps) |
| DXY          | Yahoo `DX-Y.NYB`| Daily (close)| Dollar index |
| BTC          | CoinGecko    | Real-time      | No key needed |
| Halving days | Computed     | n/a            | Days since 2024-04-19 |

## Manual override

Any signal can be overridden — type a value into the dashed field under the price. Override persists in localStorage and shows an amber "⚙ override" badge. Useful for testing scenarios ("what does the scorecard look like if MOVE hits 150?") or filling gaps when a source is down. Click **Clear overrides** in the footer to revert to live data.

## Scoring logic (open source, edit to taste)

Thesis A points (sum to ~100):
- Halving day window 850–1000 = +25
- ETF outflows < −250m = +25  (kills B confirmation)
- BTC < 85% of Q1 high = +20
- May–Oct calendar position = +15
- Orderly macro tape (MOVE<130, SOFR<10) = +15

Thesis B points:
- MOVE > 140 = +25
- Real yield < 0% = +25
- Funding stress > 15bps = +20
- TGA drawdown < 500bn = +15
- DXY < 96 = +15

The score gap drives the lean: <8 = SPLIT TAPE; 8–25 = directional lean; >25 + score >70 = STRONG.

## Rate limits

- FRED: 120 req/min per key — we make 5 per fetch, cache 5min on Vercel edge. Fine for hundreds of users.
- Yahoo: no documented limit, but uses User-Agent. Cached 5min.
- CoinGecko free: 30/min. Cached 60s.
- Farside: scrape, cached 30min (data only updates evenings).

## Extending

Want more signals? Add to `signals.js`:
- DXY / EUR-USD detail: Yahoo `EURUSD=X`
- Gold: Yahoo `GC=F`
- BTC dominance: CoinGecko `/global`
- Stablecoin supply: DefiLlama free API
- Open interest: Coinglass API (needs key, paid tier for history)

Then add a matching panel in `index.html` and a scoring rule in the `compute()` function.

## Troubleshooting

- **"Error · HTTP 500"** → FRED_API_KEY not set in Vercel env
- **Some signals show "—"** → that source failed (Yahoo can rate-limit aggressive scraping; Farside table layout occasionally changes). Other signals keep working.
- **Farside ETF flows missing** → they update around 22:00–02:00 UTC; before that the latest row may not exist yet
- **Status stays "Fetching…"** → check browser console; likely CORS (you forgot to deploy the proxy and are calling some other URL)

## License

MIT. Use it, fork it, ship it.
