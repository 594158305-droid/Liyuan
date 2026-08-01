#!/usr/bin/env bash
# Liyuan Agent - Linux / macOS launcher
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-7620}"
HOST="${HOST:-0.0.0.0}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"
MIN_NODE_MAJOR=22

echo ""
echo "  ========================================"
echo "    Liyuan Agent"
echo "  ========================================"
echo ""

os_name="$(uname -s 2>/dev/null || echo unknown)"
is_macos=0
if [[ "$os_name" == "Darwin" ]]; then
  is_macos=1
fi

node_install_hint() {
  echo "         Install Node.js >= ${MIN_NODE_MAJOR}:"
  echo "         - https://nodejs.org/  (LTS / Current, pick >= ${MIN_NODE_MAJOR})"
  if [[ "$is_macos" -eq 1 ]]; then
    echo "         - Homebrew:  brew install node@${MIN_NODE_MAJOR}"
    echo "                      brew link --overwrite --force node@${MIN_NODE_MAJOR}"
  else
    echo "         - Linux: use NodeSource / nvm / distro packages for Node ${MIN_NODE_MAJOR}+"
  fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found."
  node_install_hint
  exit 1
fi

NODE_VER="$(node -v 2>/dev/null || true)"
echo "[liyuan] Node ${NODE_VER}"

# Require major version >= MIN_NODE_MAJOR (e.g. v22.x.x)
major="$(echo "${NODE_VER#v}" | cut -d. -f1)"
if ! [[ "$major" =~ ^[0-9]+$ ]] || (( major < MIN_NODE_MAJOR )); then
  echo "[ERROR] Need Node.js >= ${MIN_NODE_MAJOR} (found ${NODE_VER:-unknown})."
  node_install_hint
  exit 1
fi

# First-run defaults (no personal keys)
if [[ ! -f liyuan.config.json && -f liyuan.config.example.json ]]; then
  echo "[liyuan] Creating liyuan.config.json from example ..."
  cp liyuan.config.example.json liyuan.config.json
fi
if [[ ! -f liyuan.agent.json && -f liyuan.agent.example.json ]]; then
  echo "[liyuan] Creating liyuan.agent.json from example ..."
  cp liyuan.agent.example.json liyuan.agent.json
  echo "[liyuan] Edit liyuan.agent.json and set your API key before chatting."
fi

# Apply staged online update (downloaded via the in-app updater; no-op otherwise)
if [[ -f .liyuan-cache/update/pending.json ]]; then
  echo "[liyuan] Applying staged update ..."
  node scripts/apply-update.mjs || true
fi

if [[ ! -d node_modules/ws ]]; then
  if [[ -d node_modules ]]; then
    echo "[liyuan] node_modules incomplete - reinstalling ..."
  else
    echo "[liyuan] node_modules missing - running npm install ..."
  fi
  echo "[liyuan] First run needs network; later starts are offline-ready."
  npm install
fi

# Online update changed dependencies -> reinstall once
if [[ -f .liyuan-cache/needs-npm-install ]]; then
  echo "[liyuan] Update changed dependencies - running npm install ..."
  npm install && rm -f .liyuan-cache/needs-npm-install
fi

if [[ ! -f web/dist/index.html ]]; then
  echo "[liyuan] Frontend dist missing - running web:build ..."
  npm run web:build
fi

# free port if busy (optional; ignore errors)
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  pid="$(lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pid}" ]]; then
    echo "[liyuan] Port ${PORT} in use, killing ${pid} ..."
    # shellcheck disable=SC2086
    kill ${pid} 2>/dev/null || true
    sleep 0.5
  fi
fi

export HOST PORT
LOCAL_URL="http://127.0.0.1:${PORT}"
echo "[liyuan] Starting ${LOCAL_URL}  (bind ${HOST}:${PORT})"
echo "[liyuan] Continues last session. New:  ./start.sh --new"
echo "[liyuan] Ctrl+C to stop."
echo ""

# Open browser shortly after server start (macOS open / Linux xdg-open)
if [[ "${OPEN_BROWSER}" != "0" ]]; then
  (
    sleep 2
    if [[ "$is_macos" -eq 1 ]] && command -v open >/dev/null 2>&1; then
      open "${LOCAL_URL}/" 2>/dev/null || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "${LOCAL_URL}/" 2>/dev/null || true
    fi
  ) &
fi

# Supervised run: exit 87 = in-app "restart to apply update" -> apply + relaunch
export LIYUAN_SUPERVISED=1
while true; do
  set +e
  node server/main.ts "$@"
  ec=$?
  set -e
  if [[ "$ec" == "87" ]]; then
    echo ""
    echo "[liyuan] Restarting to apply update ..."
    [[ -f .liyuan-cache/update/pending.json ]] && node scripts/apply-update.mjs || true
    if [[ -f .liyuan-cache/needs-npm-install ]]; then
      npm install && rm -f .liyuan-cache/needs-npm-install
    fi
    continue
  fi
  exit "$ec"
done

