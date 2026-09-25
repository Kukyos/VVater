#!/usr/bin/env sh
# Serves the API from this laptop to the live Vercel site through an ngrok static domain.
# Ctrl+C stops both. See docs/18-deploy.md, "Laptop as the backend".
NGROK_DOMAIN=CHANGE-ME.ngrok-free.app
SITE=https://v-vater.vercel.app
cd "$(dirname "$0")"
command -v ngrok >/dev/null || { echo "ngrok is not installed: https://ngrok.com/download, then ngrok config add-authtoken <token>"; exit 1; }
PY=.venv/bin/python; [ -x "$PY" ] || PY=.venv/Scripts/python.exe
ALLOWED_ORIGINS=$SITE ALLOWED_ORIGIN_REGEX='https://v-vater-.*\.vercel\.app' \
  "$PY" -m uvicorn server.ocean.api:app --host 127.0.0.1 --port 8011 &
API=$!
trap 'kill $API 2>/dev/null' EXIT INT TERM
(sleep 8; open "$SITE" 2>/dev/null || xdg-open "$SITE" 2>/dev/null) &
ngrok http --url="$NGROK_DOMAIN" 8011
