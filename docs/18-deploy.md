# Deploying

The repo splits across two hosts. Vercel serves the viewer as a static build; the
FastAPI server needs a real process (netCDF4, dask, xarray, scipy, long ERDDAP/Copernicus
fetches) and does not fit Vercel's serverless functions.

## Viewer → Vercel

Root `vercel.json` points Vercel at `viewer/` (`npm ci`, `npm run build`, `viewer/dist`),
so the default "New Project" import needs no dashboard configuration.

Set in Vercel → Project → Settings → Environment Variables, for both Production and
Preview:

| Variable | Value | Notes |
|---|---|---|
| `VITE_API_BASE` | `https://<backend-host>` | No trailing slash, no `/api` — `api.ts` appends `/api/...` itself. Must be HTTPS or the browser blocks it as mixed content. Baked in at build time — redeploy after changing it. |
| `VITE_CESIUM_ION_TOKEN` | a Cesium ion access token | Optional. Turns on Cesium World Terrain in Fly and immersive. It ships in the public bundle, as every ion token does: restrict it in the ion dashboard (Access Tokens → the token → *Allowed URLs*) to the Vercel domain and `http://localhost:5173`. Visitors need no account. Unset, the globe stays smooth and nothing calls ion. Baked in at build time — redeploy after changing it. Locally it goes in `viewer/.env.local` (gitignored). |

## Server → Render

Not on Vercel. Root `render.yaml` defines the web service (`pip install -r
server/requirements.txt`, then `uvicorn server.ocean.api:app --host 0.0.0.0 --port
$PORT`). On [render.com](https://render.com) → New → Blueprint, point at this repo and
it reads `render.yaml` directly — no manual service setup.

`sync: false` vars in `render.yaml` (secrets/URLs) are entered once in the Render
dashboard after the blueprint creates the service; they're deliberately not committed:

| Variable | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | for `/api/chat` | Backend-only secret. Never prefix a secret `VITE_`, it ships in the public bundle. |
| `GROQ_TEXT_MODEL` | optional | Defaults to `openai/gpt-oss-120b`. |
| `ALLOWED_ORIGINS` | yes, in production | Comma-separated exact origins, e.g. `https://vvater.vercel.app`. Local dev origins (`localhost`/`127.0.0.1` on 5173/4173) are always allowed. |
| `ALLOWED_ORIGIN_REGEX` | recommended | Vercel preview deploys get a random `*.vercel.app` subdomain per deploy; a regex like `https://vvater-.*\.vercel\.app` covers them since exact-match origins can't. |
| `COPERNICUSMARINE_SERVICE_USERNAME` / `_PASSWORD` | not needed | The Ocean Cube, whole ocean, winds and waves read Copernicus's public ARCO stores anonymously; checked 2026-09-24 with no credentials and no credential file. Only the older `sources.py` subset path used a login. |
| `MALLOC_ARENA_MAX` | set in `render.yaml` | `2`. Keeps glibc from giving each of the 32 zarr reader threads its own memory arena. |

**Memory.** Measured locally over a realistic session (the Bay cube, whole ocean, winds,
fishing zones, PFZ advisories, a second cube in the Gulf Stream, immersive): 126 MB idle,
377 MB at peak. Render's free plan allows 512 MB. It fits, but each new cube adds to the
caches: a long session with many different cubes can be restarted by Render for memory.
The Starter plan has the same 512 MB; the Standard plan's 2 GB removes the concern.

**Cold start.** The free plan sleeps after 15 minutes without a request; the first request
after that takes about a minute, and the disk cache (`data/cache/`) starts empty after
every deploy or restart. Open the site a few minutes before a demo and load the cube once.

`.env` (gitignored, read once at import by `server/ocean/__init__.py`) still works for
local dev; a real deployment sets these in the host's own env config instead.

## Verify a build locally

```
cd viewer
npm ci
VITE_API_BASE=https://example.test npm run build
grep -r 127.0.0.1 dist/assets   # must be empty
grep -o example.test dist/assets/*.js   # must match
```
