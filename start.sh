#!/usr/bin/env bash
# Start the local web chat server. No dependencies — just Node.
#
#   ./start.sh              app on http://localhost:3000 (expects a model on :8081)
#
# The built-in mock LLM always runs alongside it (silently, on MOCK_PORT); the
# Settings → "Use built-in mock LLM" toggle in the UI is the only switch that
# decides whether the app talks to it. Ctrl+C stops both.
#
# Config via environment (all optional):
#   PORT             app port            (default 3000)
#   MOCK_PORT        mock LLM port       (default 11435)
#   WC_MEMORY_FILE   where memories save (default ./memories.json next to server.js)
#   WC_ALLOW_LAN=1   let the proxy reach a private-LAN model host
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
MOCK_PORT="${MOCK_PORT:-11435}"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "usage: ./start.sh"
      echo "env:       PORT=$PORT MOCK_PORT=$MOCK_PORT WC_MEMORY_FILE=${WC_MEMORY_FILE:-./memories.json} WC_ALLOW_LAN=${WC_ALLOW_LAN:-0}"
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

MOCK_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Background fixture: it listens, it never talks. If something already holds
# the port we just carry on without the mock — only the toggle notices.
PORT="$MOCK_PORT" node mock-llm.js >/dev/null 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$MOCK_PORT/v1/models" && break; sleep 0.2; done
if ! curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$MOCK_PORT/v1/models"; then
  echo "note: no mock LLM answering on :$MOCK_PORT — the Settings mock toggle will not work" >&2
fi

echo "app       -> http://localhost:$PORT   (Ctrl+C to stop)"
node server.js
