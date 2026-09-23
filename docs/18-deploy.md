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
| `COPERNICUSMARINE_SERVICE_USERNAME` / `_PASSWORD` | optional | GLORYS12 secondary source, blocked on registration per `05-data-sources.md`. |

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
