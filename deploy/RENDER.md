# Deploying to Render (for testing)

Render runs a **long-lived Node process**, which is what Elfura needs: the stream
proxy holds a connection open and pipes bytes with backpressure, and `/api/proxy`
serves ranged media. That rules out serverless hosts (Vercel, Netlify Functions,
AWS Lambda) — they buffer responses, cap body size, and kill the process after
seconds. Render's native Node runtime is the cheapest way to get a real URL.

## What you get

| | |
| --- | --- |
| Public URL | `https://<service>.onrender.com` |
| Startup | `npm start` → `node index.js` |
| Port | Render sets `PORT`; Elfura binds `0.0.0.0:$PORT` (falls back to `8787`) |
| Health check | `GET /api/v1/health` → `200` |
| Build | `npm ci && npm run build` (player + lib + backend, ~2 min) |

## Option A — one-click Blueprint (recommended)

1. Push this branch to GitHub (the `render.yaml` at the repo root is the blueprint).
2. Render dashboard → **New +** → **Blueprint** → pick the repo → **Apply**.
3. Render creates the service, generates `ELFURA_SECRET`, and deploys.
4. Add `TMDB_API_KEY` in **Environment** when you want real title metadata.

## Option B — manual, from the dashboard

1. **New +** → **Web Service** → connect the repo.
2. **Runtime:** Node · **Branch:** your branch · **Region:** Singapore (closest to India).
3. **Build command:** `npm ci && npm run build`
4. **Start command:** `npm start`
5. **Health check path:** `/api/v1/health`
6. **Environment** → add:

| Key | Value | Why |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Render's default may be older than the code needs |
| `ELFURA_SECRET` | a long random string (`openssl rand -hex 32`) | signs sessions + the sealed playback envelope |
| `ALLOWED_ORIGINS` | `*` for testing, then `https://yoursite.com` | who may call the API |
| `REQUIRE_PLAYBACK_TOKEN` | `0` for testing | `1` in production |
| `TMDB_API_KEY` | your TMDB key | optional, but titles look empty without it |

7. **Create Web Service.** First deploy takes a couple of minutes.

## Verify it

```bash
BASE=https://<service>.onrender.com

# 1. process is up and all sources mounted
curl -s "$BASE/api/v1/health"

# 2. the player shell loads
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/embed/movie/550"

# 3. resolution answers (needs TMDB or it still returns sources, just no metadata)
curl -s "$BASE/api/v1/playback?type=movie&tmdb=550" | head -c 300; echo

# 4. the proxy streams bytes — a public test HLS master, no provider involved
curl -s "$BASE/api/proxy?u=$(printf %s 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' | base64 -w0 | tr '+/' '-_' | tr -d '=')" | head -5
```

Step 4 is the important one: it must return `#EXTM3U` **and every child line must be
`/api/proxy?u=...`**, never the provider hostname. Then open the embed in a browser
and play something — the network tab should show only `/api/v1/playback` and
`/api/proxy` requests, nothing pointing at a CDN.

## Known limits of the free plan

- **It sleeps after 15 minutes of no traffic.** The next request pays a cold start
  of roughly 30–60 s and can fail once. For continuous testing use **Starter**.
- **512 MB RAM.** `index.js` re-execs itself with `--max-old-space-size=384`, so the
  payload caches stay inside the container. Payload caching is bounded by design.
- **Ephemeral disk.** Elfura writes nothing to disk by design (zero-disk rule), so
  nothing breaks — except `/roxy` analytics, which live in `data/roxy.json` and are
  lost on every redeploy or restart. That is expected on a free tier; it is not a
  bug in the proxy.
- **No sticky sessions needed.** The proxy is stateless and CORS-`*`, so a single
  instance serves every viewer and scaling out needs no shared state.
