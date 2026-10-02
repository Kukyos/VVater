# VVater API: hosting notes

The FastAPI backend for https://v-vater.vercel.app. One long-running process on port 8000
inside the container. This file and the `Dockerfile` beside it travel in the backend zip
(`docs/18-deploy.md`, "Updating the server").

## Run

Docker:

    docker build -t vvater-api .
    docker run -d --restart unless-stopped -p 8004:8000 \
      -v vvater-cache:/app/data/cache \
      -e ALLOWED_ORIGINS=https://v-vater.vercel.app \
      -e ALLOWED_ORIGIN_REGEX='https://v-vater-.*\.vercel\.app' \
      -e AI_ROUTER_KEY=<sent separately> \
      --name vvater-api vvater-api

Without Docker: Python 3.14, `pip install -r server/requirements.txt`, then the same
environment variables and `uvicorn server.ocean.api:app --host 0.0.0.0 --port 8000` from
this folder.

Check: `curl http://localhost:8004/api/health`

## Routing

The site reaches the server through a Vercel rewrite (`/api/*` on the site's domain is
forwarded to `http://<server>:8004/api/*`), so plain HTTP on a public port is enough.

- Every path under `/api` must reach the app unchanged, with no prefix stripped.
- Requests can take up to 80 s with an empty cache; nothing in front of the app may cut
  them shorter than about 120 s.
- CORS is handled by the app itself. No auth in front of it.

An HTTPS hostname (Caddy, or a Cloudflare Tunnel to `http://localhost:8004`) is optional;
with one, the site can call the server directly and the rewrite can go.

## What the server needs

- 1 GB RAM minimum, 2 GB comfortable. 1-2 vCPU.
- 5-10 GB persistent disk for `data/cache` (the volume above). It is never pruned.
- Unrestricted outbound HTTPS (Copernicus S3, INCOIS ERDDAP, UCAR THREDDS). A firewall
  that re-signs TLS will break the fetches.

## Updating

Replace this folder with the new zip, keep the `vvater-cache` volume, then:

    docker build -t vvater-api . && docker rm -f vvater-api && docker run ... (as above)
