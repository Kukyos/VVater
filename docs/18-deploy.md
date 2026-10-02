# Deploying

The repo splits across two hosts. Vercel serves the viewer as a static build; the
FastAPI server needs a real process (netCDF4, dask, xarray, scipy, long ERDDAP/Copernicus
fetches) and does not fit Vercel's serverless functions.

## Current setup: a hosted server behind Vercel's proxy

Since 2026-10-02 the API runs on a team member's server as the Docker container
`vvater-api` (persistent `data/cache` volume, restarts on its own), on plain HTTP at
`51.79.178.49:8004`. A browser on the HTTPS site cannot call an HTTP address (mixed
content), so `vercel.json` rewrites `/api/*` on the Vercel domain to that server: the
browser only ever talks HTTPS to Vercel, and Vercel fetches from the server.

- `VITE_API_BASE` on Vercel is `https://v-vater.vercel.app`, the site's own domain.
- The container runs with `ALLOWED_ORIGINS`, `ALLOWED_ORIGIN_REGEX` and `AI_ROUTER_KEY`
  (table under "Server → Render"); `deploy/server/HOSTING.md` has the `docker run` line.
- The hop from Vercel to the server is unencrypted. Nothing secret crosses it: the
  AIRouter key lives on the server, not in requests.
- To move the backend, change the destination in `vercel.json` and push.
- An HTTPS hostname on the server (Caddy, or a Cloudflare Tunnel) would allow pointing
  `VITE_API_BASE` straight at it and dropping the rewrite.

Checked on 2026-10-02, in Chrome on the live site after the redeploy: all 14 requests of
the default page (health, meta, catalog, the Bay cube and the next day's, surface
temperature, currents, casts) returned 200 through the rewrite, and the cube rendered.
`/api/catalog` from an empty cache took 34 s through it and was not cut off.

### Updating the server

The server holds a copy of the code, not a clone: it does not follow `main`. After a
backend change, build the zip and send it to whoever runs the server:

```
git archive --prefix=vvater-backend/ --add-file=deploy/server/Dockerfile \
  --add-file=deploy/server/HOSTING.md -o vvater-backend.zip HEAD server data
```

`deploy/server/HOSTING.md` (inside the zip) says how to rebuild the container while
keeping its cache volume. Viewer-only changes need nothing on the server.

## Viewer → Vercel

Root `vercel.json` points Vercel at `viewer/` (`npm ci`, `npm run build`, `viewer/dist`),
so the default "New Project" import needs no dashboard configuration.

Set in Vercel → Project → Settings → Environment Variables, for both Production and
Preview:

| Variable | Value | Notes |
|---|---|---|
| `VITE_API_BASE` | `https://v-vater.vercel.app` while the rewrite above is in use; otherwise `https://<backend-host>` | No trailing slash, no `/api` — `api.ts` appends `/api/...` itself. Must be HTTPS or the browser blocks it as mixed content. Baked in at build time — redeploy after changing it. |
| `VITE_CESIUM_ION_TOKEN` | a Cesium ion access token | Optional. Turns on Cesium World Terrain and Bing aerial imagery in Fly and immersive. It ships in the public bundle, as every ion token does: restrict it in the ion dashboard (Access Tokens → the token → *Allowed URLs*) to the Vercel domain and `http://localhost:5173`. Visitors need no account. Unset, the globe stays smooth and nothing calls ion. Baked in at build time — redeploy after changing it. Locally it goes in `viewer/.env.local` (gitignored). |

## Server → Render

Not in use since 2026-10-02 (the free plan's 512 MB is too small, D-40); kept as the
blueprint for a paid plan. Not on Vercel. Root `render.yaml` defines the web service (`pip install -r
server/requirements.txt`, then `uvicorn server.ocean.api:app --host 0.0.0.0 --port
$PORT`). On [render.com](https://render.com) → New → Blueprint, point at this repo and
it reads `render.yaml` directly — no manual service setup.

`sync: false` vars in `render.yaml` (secrets/URLs) are entered once in the Render
dashboard after the blueprint creates the service; they're deliberately not committed:

| Variable | Required | Notes |
|---|---|---|
| `AI_ROUTER_KEY` | for `/api/chat` | AIRouter (`api.airouter.in`, OpenAI-compatible, prepaid in rupees). Backend-only secret. Never prefix a secret `VITE_`, it ships in the public bundle. |
| `AI_ROUTER_MODEL` | optional | Comma-separated, tried in order when one fails. Defaults to `openai/gpt-4.1-mini,google/gemini-2.5-flash,deepseek/deepseek-v4-flash`. |
| `AI_ROUTER_URL` | optional | Defaults to `https://api.airouter.in/v1`. Any OpenAI-compatible base works. |
| `ALLOWED_ORIGINS` | yes, in production | Comma-separated exact origins, e.g. `https://vvater.vercel.app`. Local dev origins (`localhost`/`127.0.0.1` on 5173/4173) are always allowed. |
| `ALLOWED_ORIGIN_REGEX` | recommended | Vercel preview deploys get a random `*.vercel.app` subdomain per deploy; a regex like `https://vvater-.*\.vercel\.app` covers them since exact-match origins can't. |
| `COPERNICUSMARINE_SERVICE_USERNAME` / `_PASSWORD` | not needed | The Ocean Cube, whole ocean, winds and waves read Copernicus's public ARCO stores anonymously; checked 2026-09-24 with no credentials and no credential file. Only the older `sources.py` subset path used a login. |
| `MALLOC_ARENA_MAX` | set in `render.yaml` | `2`. Keeps glibc from giving each of the 32 zarr reader threads its own memory arena. |
| `ZARR_CONCURRENCY` | set in `render.yaml` | `8` (default 32). Fewer chunk reads in flight: slower cube loads, lower peak memory. |

**Memory.** From an empty cache (as on Render after every deploy), `/api/catalog` plus one Bay temperature cube peaks at 233 MB; before the stores shared one boto3 client the catalog alone reached 582 MB and Render killed the process. Measured earlier, locally, over a realistic session (the Bay cube, whole ocean, winds,
fishing zones, PFZ advisories, a second cube in the Gulf Stream, immersive): 126 MB idle,
377 MB at peak. A fuller session (every scenario, see "What a host needs" below) peaks at
638 MB, over the free plan's 512 MB: Render will restart the process during a thorough
demo. The Starter plan has the same 512 MB; the Standard plan's 2 GB removes the concern.

## What a host needs (measured)

`python -m server.tools.measure_hosting`, run twice on 2026-09-25 (the second writes `data/hosting-latest.json`, which the eval harness reads): a cold cache, one session touching
every feature (all 9 scenario cubes with casts, an Argo profile, currents, wind and
fishing each; the whole-ocean temperature and salinity; PFZ; a second variable; the INCOIS
volume; Argo observations), 97 requests, all 200, `ZARR_CONCURRENCY` 32 (the default).

| | Measured | Ask the host for |
|---|---|---|
| **RAM** | 128 MB idle after boot; 639 MB peak; 428 MB settled at the end (second run; the first: 193 MB after the catalog, 638 MB peak, 430 MB settled) | **1 GB** minimum. 2 GB for several visitors at once, since each new cube adds to the caches |
| **CPU** | 36 CPU-seconds over an 8-minute session, median 15 % of one core while busy, peak 2.5 cores (the first run: 53 CPU-seconds over 19 minutes, peak 1.6 cores; the network sets the pace) | **1 vCPU** works, **2** is comfortable. The time goes to waiting on Copernicus, not computing |
| **Disk, install** | Python 3.14 + `server/requirements.txt`: 605 MB of packages | 1 GB |
| **Disk, cache** | 1.2 GB after one full session; `data/cache` is never pruned (7.3 GB on the development laptop) | **5–10 GB persistent**. Ephemeral disk works but every restart is a cold start |
| **Egress per visitor** | Default page (Bay cube, the next day prefetched, surface temperature and currents, casts): about 8 MB gzipped. Every feature once: 54 MB uncompressed, about 25 MB gzipped | 100 visitors ≈ 1–3 GB |
| **Inbound** | Chunks from Copernicus's public S3 stores, ERDDAP, UCAR THREDDS | Unrestricted outbound HTTPS |
| **Process** | One long-lived process; requests take up to 80 s cold (an Argo profile), 44 s for the catalog | **No serverless.** No request timeout under ~120 s, and no sleep-on-idle if possible |
| **Boot** | 1 s to accept requests | — |

What rules hosts out: 512 MB plans (Render free and Starter, Fly's smallest), serverless
platforms (Vercel functions, Lambda, Cloud Run with short timeouts), and anything whose
proxy cuts requests under a minute. What fits: any VM or container host with 1–2 GB RAM
and 1–2 vCPU (Oracle Cloud's Always Free Ampere VM, a Hugging Face Docker Space at 16 GB,
a small Hetzner or DigitalOcean box, Render Standard; check each one's current terms), or this laptop via ngrok (below).
`ZARR_CONCURRENCY=8` lowers the peak at the cost of slower cube loads; its effect on the
638 MB peak was not measured.

**Cold start.** The free plan sleeps after 15 minutes without a request; the first request
after that takes about a minute, and the disk cache (`data/cache/`) starts empty after
every deploy or restart. Open the site a few minutes before a demo and load the cube once.

`.env` (gitignored, read once at import by `server/ocean/__init__.py`) still works for
local dev; a real deployment sets these in the host's own env config instead.

## Cesium ion (optional: 3D terrain and aerial imagery in Fly and immersive)

With the token, Fly and immersive get Cesium World Terrain (asset 1) and Bing Maps aerial
imagery (asset 2) under the data layers; the workspace views stay flat and never call ion.

Visitors never need an account; the token is built into the site.

1. At **ion.cesium.com**, open **Access Tokens** (not *Developer → OAuth applications*: the
   form asking for an app name and a redirect URL is for apps that log users in, and is not
   needed here; cancel it).
2. **Create token.** Name: `vvater-web`. Scopes: leave the defaults (`assets:read`,
   `geocode`). Resources: *All assets*, or just *Cesium World Terrain* (asset 1) and *Bing
   Maps Aerial* (asset 2).
3. **Allowed URLs**: choose *Selected URLs* and add `https://v-vater.vercel.app` and
   `http://localhost:5173` (add preview domains too if they should work). This is what stops
   anyone else spending the quota: the token itself is public in the bundle.
4. Copy the token. Locally, create `viewer/.env.local` (gitignored) with
   `VITE_CESIUM_ION_TOKEN=<token>` and restart `npm run dev`.
5. On Vercel: Project → Settings → Environment Variables → add `VITE_CESIUM_ION_TOKEN` for
   Production and Preview, then **redeploy** (Vite bakes it in at build time).

The free Community plan is for non-commercial use with a monthly cap; enough for a demo and
judging. Without the variable the globe stays smooth and nothing calls ion.

## Laptop as the backend (ngrok)

The fallback if the hosted server goes away; the live site used it from 2026-09-30 to
2026-10-02 (D-41). To switch back, set `VITE_API_BASE` to the ngrok domain and redeploy;
the rewrite in `vercel.json` can stay, nothing calls it then.

A laptop can serve as the live site's backend. ngrok's free plan gives one **static domain** (`<name>.ngrok-free.dev`) that
never changes, so the Vercel build is pointed at it once and then works whenever the
laptop is serving.

One-time setup:

1. `winget install ngrok.ngrok` (macOS: `brew install ngrok`), sign up at ngrok.com, and
   run `ngrok config add-authtoken <token>` from the dashboard. The token stays on the
   laptop, in ngrok's own config, never in the repo.
2. In the ngrok dashboard, **Domains** → claim the free static domain. Put it in the
   `NGROK_DOMAIN` line at the top of `serve.bat` and `serve.sh`.
3. On Vercel set `VITE_API_BASE` to `https://<name>.ngrok-free.dev` (this project: `https://rockstar-wanting-reanalyze.ngrok-free.dev`) and redeploy.

Each time: double-click `serve.bat` (or run `./serve.sh`). It starts the API on
`127.0.0.1:8011` with the Vercel origins allowed, opens the tunnel, and opens the site.
Closing the two windows takes the site's backend down.

ngrok's free domain answers browsers with a warning page instead of the API unless the
request carries `ngrok-skip-browser-warning`. `viewer/src/api.ts` adds that header when
`VITE_API_BASE` is an ngrok domain, and only then, because it makes every request
preflighted.

Limits:

- **Not every network lets ngrok through.** Found on 2026-09-30: a Fortinet FortiGate
  firewall (college or office Wi-Fi) inspects TLS to ngrok's hosts and re-signs their
  certificates with its own "FortiGate CA". The agent rejects that, as it should, and sits
  at `"status":"reconnecting"` (`curl http://127.0.0.1:4040/api/status`) with no tunnel,
  so the site shows the server as asleep while the API runs fine locally. GitHub was not
  intercepted on the same network. Fix: serve from a network that does not inspect
  traffic (a phone hotspot, home broadband). Do not point ngrok at the firewall's CA:
  that is trusting the interception, the same thing hard rule 7 forbids.
  Check with `openssl s_client -connect connect.ngrok-agent.com:443 </dev/null | grep i:`;
  the issuer must not be the firewall.
- The laptop must be on, awake and online: set Windows sleep to *Never* while plugged
  in, and don't close the lid unless lid-close is set to *Do nothing*.
- Cube loads are bounded by the laptop's upload speed, not a datacentre's.
- ngrok's free plan caps bandwidth and requests per month; check the current figures on
  ngrok's pricing page before a heavy demo.
- The domain is public. CORS stops other websites, not `curl`: anyone who finds it can
  call `/api/chat` and spend the prepaid AIRouter balance, as with Render. Questions are
  capped per visitor and per day (`api.py`, D-26); spend itself is not.
- In return: the disk cache stays warm between runs and there is no 512 MB ceiling, so
  no cold start and no out-of-memory restarts.

## When the server is down: the wake button

When the site cannot reach the API, it opens a card instead of a broken globe:
*"The ocean server is asleep"*, with a **Message server** button (`viewer/src/wake.ts`).
The button sends a push notification to the team's phone through ntfy.sh (no account),
and the card tells the visitor the server will be up within 30 minutes. The page checks
`/api/health` every 30 seconds and carries on loading by itself once it answers. If the
visitor reloads within 30 minutes, the card shows the message as already sent rather than
offering the button again. Local development (API on `localhost` or `127.0.0.1`) never
shows the card.

One-time setup on the phone: install **ntfy** (Android or iOS), then **Subscribe to
topic** → `vvater-wake-d83b0af66b99`, on the default server `ntfy.sh`. Allow its
notifications. A message arrives titled *"VVater: start the server"*; tapping it opens the
site. Then bring the backend back: check the container on the hosted server
(`docker ps`, `docker logs vvater-api`), or run `serve.bat` if the laptop is the backend.
Through the rewrite, a server that is down answers `/api/health` with a Vercel error,
which reads as down the same way.

Checked on 2026-09-30:
- The dead ngrok domain answers `/api/health` with 404, which reads as down.
- ntfy accepts the browser's request and sends `Access-Control-Allow-Origin: *`.
- End to end in headless Chrome against an API address with nothing on it: the card
  appeared, the button sent the push, a reload showed "Message sent", and the card cleared
  itself 31 s after the API was started. The site then loaded as normal.

The topic name ships in the public bundle, so anyone who reads it can send a push to it.
The random name stops guessing, not reading. If that is ever abused, move the send
behind a Vercel function that holds a secret.

## When the live site cannot reach the API

Check, in order, for the current setup:

1. **Is the server up?** `curl -i http://51.79.178.49:8004/api/health` must return
   `{"ok":true,...}`. If not, the container is down: `docker ps -a` and
   `docker logs vvater-api` on the server.
2. **Does the rewrite reach it?** `curl -i https://v-vater.vercel.app/api/health` must
   return the same. If (1) passes and this fails, check the destination in `vercel.json`
   and that the latest deploy is Ready.
3. **Is the site pointed at it?** Fetch the bundle (command in step 3 below) and grep it
   for `v-vater.vercel.app`. An ngrok or `127.0.0.1` address means `VITE_API_BASE` is
   stale on Vercel, or the browser holds the old bundle (Ctrl+Shift+R).

For Render, when it was the host:

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
