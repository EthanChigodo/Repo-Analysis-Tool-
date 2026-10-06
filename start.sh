#!/usr/bin/env bash
# RAT - Repo Analysis Tool
# Installs dependencies (first run only), builds the frontend, and starts the
# server. Visit http://localhost:3000 once it prints "listening".
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d node_modules ]; then
  echo "[start.sh] Installing dependencies..."
  npm install
fi

echo "[start.sh] Building frontend..."
npm run build

echo "[start.sh] Starting server on http://localhost:${PORT:-3000} ..."
exec npm start
