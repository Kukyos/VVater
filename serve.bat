@echo off
rem Serves the API from this laptop to the live Vercel site through an ngrok static domain.
rem Close both windows to stop. See docs/18-deploy.md, "Laptop as the backend".
set NGROK_DOMAIN=CHANGE-ME.ngrok-free.app
set SITE=https://v-vater.vercel.app
cd /d "%~dp0"
where ngrok >nul 2>nul || (echo ngrok is not installed: winget install ngrok.ngrok, then ngrok config add-authtoken ^<token^> & pause & exit /b 1)
set ALLOWED_ORIGINS=%SITE%
set ALLOWED_ORIGIN_REGEX=https://v-vater-.*\.vercel\.app
start "VVater API" cmd /k .venv\Scripts\python.exe -m uvicorn server.ocean.api:app --host 127.0.0.1 --port 8011
start "VVater tunnel" cmd /k ngrok http --url=%NGROK_DOMAIN% 8011
timeout /t 8 /nobreak >nul
start "" %SITE%
