@echo off
rem Runs the API on :8011 and the viewer on :5173 locally, each in its own window, then opens the browser.
cd /d "%~dp0"
if not exist viewer\node_modules (pushd viewer & call npm install & popd)
start "VVater API" cmd /k .venv\Scripts\python.exe -m uvicorn server.ocean.api:app --port 8011
start "VVater viewer" cmd /k "cd viewer && npm run dev"
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
