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

## Cesium ion (optional: 3D terrain in Fly and immersive)

Visitors never need an account; the token is built into the site.

1. At **ion.cesium.com**, open **Access Tokens** (not *Developer → OAuth applications*: the
   form asking for an app name and a redirect URL is for apps that log users in, and is not
   needed here; cancel it).
2. **Create token.** Name: `vvater-web`. Scopes: leave the defaults (`assets:read`,
   `geocode`). Resources: *All assets*, or just *Cesium World Terrain* (asset 1).
3. **Allowed URLs**: choose *Selected URLs* and add `https://v-vater.vercel.app` and
   `http://localhost:5173` (add preview domains too if they should work). This is what stops
   anyone else spending the quota: the token itself is public in the bundle.
4. Copy the token. Locally, create `viewer/.env.local` (gitignored) with
   `VITE_CESIUM_ION_TOKEN=<token>` and restart `npm run dev`.
5. On Vercel: Project → Settings → Environment Variables → add `VITE_CESIUM_ION_TOKEN` for
   Production and Preview, then **redeploy** (Vite bakes it in at build time).

The free Community plan is for non-commercial use with a monthly cap; enough for a demo and
judging. Without the variable the globe stays smooth and nothing calls ion.

## When the live site cannot reach the API

Check, in order:

1. **Is the backend up?** `curl -i https://vvater-api.onrender.com/api/meta`. A **502**
   from Render means the process is down or restarting (a crash, a failed deploy, or the
   free plan's 512 MB exceeded); read Render → the service → **Logs** and **Events**. An
   `Out of memory` event means the plan (see Memory above). A Python traceback at start
   means a deploy problem: `render.yaml` builds with `pip install -r
   server/requirements.txt` and starts `uvicorn server.ocean.api:app`. A long wait then
   200 is a cold start.
2. **Is the site allowed?** `curl -s -D - -o /dev/null -H "Origin: https://v-vater.vercel.app"
   https://vvater-api.onrender.com/api/meta` must return
   `access-control-allow-origin: https://v-vater.vercel.app`. If not, set `ALLOWED_ORIGINS`
   on Render (and `ALLOWED_ORIGIN_REGEX` for preview domains) and restart.
3. **Is the site pointed at it?** The built bundle must contain the Render URL:
   `curl -s https://v-vater.vercel.app/ | grep -o 'assets/index-[^"]*\.js'`, then grep that
   file for `onrender.com`. If it shows `127.0.0.1`, `VITE_API_BASE` is missing on Vercel.

Checked on 2026-09-24: step 3 passes (bundle points at `vvater-api.onrender.com`); the
backend answered after the v2 deploy and then returned 502 on every route. Environment
variables the v2 backend needs are the ones above; Copernicus credentials are **not**
needed (anonymous ARCO access, checked). `MALLOC_ARENA_MAX=2` is in `render.yaml`; if the
service was not created from the blueprint, add it by hand.

## Verify a build locally

```
cd viewer
npm ci
VITE_API_BASE=https://example.test npm run build
grep -r 127.0.0.1 dist/assets   # must be empty
grep -o example.test dist/assets/*.js   # must match
```
