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
CHROME_DIR=""
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  # Give children a beat, then force anything still up.
  sleep 0.2
  for pid in "${PIDS[@]:-}"; do kill -9 "$pid" 2>/dev/null || true; done
  [ -n "$CHROME_DIR" ] && rm -rf "$CHROME_DIR"
  rm -f "$MEM_FILE"
}
trap cleanup EXIT

wait_for() { # url, label
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null --max-time 2 "$1" && return 0
    sleep 0.2
  done
  echo "timeout waiting for $2 ($1)" >&2; return 1
}

# --- the model: mock only ---
echo "start: mock LLM on :$MOCK_PORT"
PORT="$MOCK_PORT" node mock-llm.js &
PIDS+=($!)
wait_for "$MOCK_BASE/models" "mock LLM"

# --- the app, with an isolated memory file so memories.json is never touched ---
echo "start: app on :$APP_PORT (memory -> $MEM_FILE)"
PORT="$APP_PORT" WC_MEMORY_FILE="$MEM_FILE" node server.js &
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
APP_URL="$APP_URL" MOCK_BASE="$MOCK_BASE" CDP_URL="$CDP_URL" node test/cdp-suite.mjs
rc=$?
set -e

# Safety net: the suite must never have written to the repo's real memory file.
if [ -s "$REPO/memories.json" ] && cmp -s "$MEM_FILE" "$REPO/memories.json"; then
  echo "WARNING: test memory file matches repo memories.json — something pointed at the real file" >&2
fi

exit "$rc"
