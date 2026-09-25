#!/usr/bin/env sh
# Runs the API on :8011 and the viewer on :5173 locally, then opens the browser. Ctrl+C stops both.
cd "$(dirname "$0")"
PY=.venv/bin/python; [ -x "$PY" ] || PY=.venv/Scripts/python.exe
[ -d viewer/node_modules ] || (cd viewer && npm install)
"$PY" -m uvicorn server.ocean.api:app --port 8011 &
API=$!
trap 'kill $API 2>/dev/null' EXIT INT TERM
(sleep 6; open http://localhost:5173 2>/dev/null || xdg-open http://localhost:5173 2>/dev/null) &
cd viewer && npm run dev
