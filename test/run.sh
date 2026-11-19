#!/usr/bin/env bash
# End-to-end runner for the CDP suite. Starts everything the suite needs and
# guarantees it only ever touches a throwaway memory file and the mock LLM:
#   * mock-llm.js      -> the model (never the real one; test chats evict its cache)
#   * server.js        -> the app, with WC_MEMORY_FILE pointed at a temp file
#   * a headless browser -> only launched if a CDP endpoint isn't already up
# Usage: test/run.sh            # uses defaults
#        APP_PORT=3001 test/run.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

APP_PORT="${APP_PORT:-3000}"
MOCK_PORT="${MOCK_PORT:-11435}"
CDP_PORT="${CDP_PORT:-9222}"
APP_URL="${APP_URL:-http://localhost:$APP_PORT}"
MOCK_BASE="${MOCK_BASE:-http://127.0.0.1:$MOCK_PORT/v1}"
CDP_URL="${CDP_URL:-http://127.0.0.1:$CDP_PORT}"

MEM_FILE="$(mktemp -t wc-test-memories.XXXXXX.json)"
# mktemp leaves the file empty, which the server reads as invalid JSON; seed it
# so the suite's first GET (the memory-file guard probe) answers properly.
echo '[]' > "$MEM_FILE"
# Point the app at the deterministic mock MCP server, never the real mcp.json
# (that would spawn ddg-search and hit the network during tests).
MCP_CONF="$(mktemp -t wc-test-mcp.XXXXXX.json)"
cat > "$MCP_CONF" <<JSON
{ "mcpServers": { "searchtest": { "command": "node", "args": ["$REPO/test/mock-mcp-server.js"] } } }
JSON
# Snapshot of the repo's real memories file for the post-run shield below.
REAL_MEM="$REPO/memories.json"
MEM_BACKUP=""
if [ -f "$REAL_MEM" ]; then
  MEM_BACKUP="$(mktemp -t wc-mem-backup.XXXXXX.json)"
  cp "$REAL_MEM" "$MEM_BACKUP"
fi
CHROME_DIR=""
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  # Give children a beat, then force anything still up.
  sleep 0.2
  for pid in "${PIDS[@]:-}"; do kill -9 "$pid" 2>/dev/null || true; done
  [ -n "$CHROME_DIR" ] && rm -rf "$CHROME_DIR"
  [ -n "$MEM_BACKUP" ] && rm -f "$MEM_BACKUP"
  rm -f "$MEM_FILE" "$MCP_CONF"
}
trap cleanup EXIT

wait_for() { # url, label
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null --max-time 2 "$1" && return 0
    sleep 0.2
  done
  echo "timeout waiting for $2 ($1)" >&2; return 1
}

# --- never share ports with a live instance: if the suite's server fails to
# bind and the tests silently reuse a running app, the memory reset below hits
# that instance's real memories.json. Own the ports or don't run. ---
if curl -s -o /dev/null --max-time 1 "$MOCK_BASE/models"; then
  echo "port $MOCK_PORT is busy — a mock LLM already answers there; stop it or pick a free MOCK_PORT=…" >&2
  exit 1
fi
if curl -s -o /dev/null --max-time 1 "$APP_URL"; then
  echo "port $APP_PORT is busy — a live app answers there and the suite wipes its memory file on purpose." >&2
  echo "Stop it or pick a free APP_PORT=… (run.sh must own the server it tests)." >&2
  exit 1
fi

# --- the model: mock only ---
echo "start: mock LLM on :$MOCK_PORT"
PORT="$MOCK_PORT" node mock-llm.js &
PIDS+=($!)
wait_for "$MOCK_BASE/models" "mock LLM"

# --- the app, with an isolated memory file so memories.json is never touched ---
echo "start: app on :$APP_PORT (memory -> $MEM_FILE, mcp -> $MCP_CONF)"
PORT="$APP_PORT" WC_MEMORY_FILE="$MEM_FILE" WC_MCP_CONFIG="$MCP_CONF" node server.js &
PIDS+=($!)
wait_for "$APP_URL" "app server"

# --- a browser exposing CDP, reused if one is already running ---
if curl -sf -o /dev/null --max-time 2 "$CDP_URL/json/version"; then
  echo "cdp: reusing browser already on :$CDP_PORT"
else
  CHROME="$(command -v google-chrome chromium chromium-browser chrome 2>/dev/null | head -1 || true)"
  [ -n "$CHROME" ] || { echo "no Chrome/Chromium found and no CDP endpoint on :$CDP_PORT" >&2; exit 1; }
  CHROME_DIR="$(mktemp -d -t wc-chrome.XXXXXX)"
  echo "start: headless Chromium ($CHROME) on :$CDP_PORT"
  "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-port="$CDP_PORT" --user-data-dir="$CHROME_DIR" \
    --window-size=1200,900 about:blank >/dev/null 2>&1 &
  PIDS+=($!)
  wait_for "$CDP_URL/json/version" "CDP endpoint"
fi

# --- run the suite against those exact endpoints ---
echo "run: cdp-suite"
set +e
APP_URL="$APP_URL" MOCK_BASE="$MOCK_BASE" CDP_URL="$CDP_URL" WC_TEST_MEM_FILE="$MEM_FILE" node test/cdp-suite.mjs
rc=$?
set -e

# Last-resort shield: whatever path the tests took, the repo's real memories
# file must be byte-identical when we are done. If it changed (e.g. someone ran
# the suite against a live server without this runner), keep the modified
# content for review, restore the snapshot, and fail the run.
touched=0
if [ -n "$MEM_BACKUP" ]; then cmp -s "$MEM_BACKUP" "$REAL_MEM" || touched=1
elif [ -f "$REAL_MEM" ]; then touched=1   # appeared from nowhere
fi
if [ "$touched" = 1 ]; then
  kept="$(mktemp -t wc-mem-changed.XXXXXX.json)"
  cp "$REAL_MEM" "$kept"
  if [ -n "$MEM_BACKUP" ]; then cp "$MEM_BACKUP" "$REAL_MEM"; else rm -f "$REAL_MEM"; fi
  echo "ERROR: memories.json changed during the test run — restored the snapshot;" >&2
  echo "       the modified content is kept at $kept for review" >&2
  rc=1
fi

exit "$rc"
