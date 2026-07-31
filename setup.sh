#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  chiapartment - one-command setup for macOS and Linux.
#
#      ./setup.sh
#
#  Checks Node, installs dependencies, loads the demo data, opens your browser,
#  and starts the app. Each step stops with a plain-English message if it
#  fails, rather than scrolling past.
# ---------------------------------------------------------------------------
set -u

cd "$(dirname "$0")"

echo
echo "  chiapartment setup"
echo "  =================="
echo

# --- 1. Is Node installed? --------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  [X] Node.js is not installed."
  echo
  echo "      Install the LTS from https://nodejs.org, then open a new"
  echo "      terminal and run ./setup.sh again."
  echo
  exit 1
fi

# --- 2. Is it new enough? ---------------------------------------------------
# better-sqlite3's prebuilt binary needs Node-API 10 (Node 22.14+). On older
# versions the app dies with no error at all, so this is checked up front.
NODE_VER="$(node -p 'process.version')"
if [ "$(node -p 'process.versions.napi>=10?1:0')" != "1" ]; then
  echo "  [X] Node $NODE_VER is too old."
  echo
  echo "      This needs Node 22.14 or newer. Versions 22.0 to 22.13 are"
  echo "      affected too, including some installers labelled '22 LTS'."
  echo
  echo "      Install the current LTS from https://nodejs.org, then open a"
  echo "      new terminal and run ./setup.sh again."
  echo
  exit 1
fi
echo "  [OK] Node $NODE_VER"

# Node 22 is the tested line. On Node 23+ npm compiles the database driver from
# source instead of using the binary that ships with it.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "22" ]; then
  echo
  echo "  [!] Node $NODE_VER is newer than the tested version (22 LTS)."
  echo "      If the install below fails mentioning node-gyp, install Node 22."
fi

# --- 3. Install dependencies ------------------------------------------------
echo
echo "  Installing dependencies. This takes a minute or two..."
echo
if ! npm install; then
  echo
  echo "  [X] npm install failed."
  echo
  echo "      If the errors mention node-gyp or a missing compiler, the cause"
  echo "      is the Node version: 23+ has no ready-made database driver, so"
  echo "      npm tries to compile one. Install Node 22 LTS from"
  echo "      https://nodejs.org/en/download, delete node_modules, and rerun."
  echo
  exit 1
fi

# --- 4. Load the demo data (idempotent) -------------------------------------
echo
echo "  Loading demo data..."
if ! npm run seed:demo; then
  echo
  echo "  [X] Could not load the demo data. The lines above say why."
  echo
  exit 1
fi

# --- 5. Check everything really works ---------------------------------------
echo
if ! npm run doctor; then
  echo
  echo "  [X] Something is not right. The 'What to do' section above says what."
  echo
  exit 1
fi

# --- 6. Open the browser shortly after the server comes up ------------------
open_browser() {
  sleep 12
  if command -v open >/dev/null 2>&1; then
    open http://localhost:3000
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:3000
  fi
}
open_browser >/dev/null 2>&1 &

echo
echo "  Starting the app. Your browser will open in a few seconds."
echo "  If it does not, go to  http://localhost:3000"
echo
echo "  Press Ctrl+C to stop."
echo

exec npm run dev
