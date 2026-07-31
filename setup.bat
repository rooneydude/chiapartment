@echo off
REM ---------------------------------------------------------------------------
REM  chiapartment - one-click setup for Windows.
REM
REM  Double-click this file, or run  setup.bat  from Command Prompt.
REM  It checks Node, installs dependencies, loads the demo data, opens your
REM  browser, and starts the app. Every step stops with a plain-English message
REM  if it fails, rather than scrolling past.
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

REM Run from this file's own folder, whatever directory it was launched from.
cd /d "%~dp0"

echo.
echo   chiapartment setup
echo   ==================
echo.

REM --- 1. Is Node installed at all? ------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo.
  echo       Download the LTS installer from  https://nodejs.org
  echo       Run it, accept the defaults, then CLOSE this window,
  echo       open a new one, and run setup.bat again.
  echo.
  pause
  exit /b 1
)

REM --- 2. Is it new enough? ---------------------------------------------------
REM better-sqlite3's prebuilt binary needs Node-API 10 (Node 22.14+). On older
REM versions the app dies with no error at all, so this is checked up front.
for /f "delims=" %%v in ('node -p "process.versions.napi" 2^>nul') do set "NAPI=%%v"
for /f "delims=" %%v in ('node -p "process.version" 2^>nul') do set "NODE_VER=%%v"
if not defined NAPI set "NAPI=0"
if not defined NODE_VER set "NODE_VER=(unknown)"

if !NAPI! LSS 10 (
  echo   [X] Node !NODE_VER! is too old.
  echo.
  echo       This needs Node 22.14 or newer. Versions 22.0 to 22.13 are
  echo       affected too, including some installers labelled "22 LTS".
  echo.
  echo       Download the current LTS from  https://nodejs.org
  echo       Then CLOSE this window, open a new one, and run setup.bat again.
  echo.
  pause
  exit /b 1
)
echo   [OK] Node !NODE_VER!

REM --- 3. Install dependencies ------------------------------------------------
echo.
echo   Installing dependencies. This takes a minute or two...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo   [X] npm install failed. The lines above say why.
  echo       Copy them and send them over.
  echo.
  pause
  exit /b 1
)

REM --- 4. Load the demo data (idempotent) -------------------------------------
echo.
echo   Loading demo data...
call npm run seed:demo
if errorlevel 1 (
  echo.
  echo   [X] Could not load the demo data. The lines above say why.
  echo.
  pause
  exit /b 1
)

REM --- 5. Check everything really works ---------------------------------------
echo.
call npm run doctor
if errorlevel 1 (
  echo.
  echo   [X] Something is not right. The "What to do" section above says what.
  echo.
  pause
  exit /b 1
)

REM --- 6. Open the browser shortly after the server comes up ------------------
REM Detached, so it does not block the server starting.
start /min "" cmd /c "timeout /t 12 /nobreak >nul & start http://localhost:3000"

echo.
echo   Starting the app. Your browser will open in a few seconds.
echo   If it does not, go to  http://localhost:3000
echo.
echo   Leave this window open. Press Ctrl+C to stop.
echo.

call npm run dev

REM If the dev server exits, keep the window open so any error stays readable.
echo.
pause
