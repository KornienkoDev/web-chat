#!/usr/bin/env bash
# Smoke test for mock-llm.js (no browser needed).
set -e
PORT="${MOCK_PORT:-11435}"
BASE="http://127.0.0.1:$PORT/v1"

node mock-llm.js &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 0.5

echo "1) models"
curl -sf "$BASE/models" | grep -q mock-llm && echo "   OK"

echo "2) streaming chat"
out=$(curl -sf -N "$BASE/chat/completions" -H 'Content-Type: application/json' \
  -d '{"model":"mock-llm","messages":[{"role":"user","content":"hello there"}],"stream":true}')
echo "$out" | grep -q '\[DONE\]' && echo "$out" | grep -q '"content"' && echo "   OK"

echo "3) tool call on 'remember'"
out=$(curl -sf -N "$BASE/chat/completions" -H 'Content-Type: application/json' \
  -d '{"model":"mock-llm","messages":[{"role":"user","content":"remember that my name is Boris"}],"stream":true,
       "tools":[{"type":"function","function":{"name":"save_memory","parameters":{"type":"object"}}}]}')
echo "$out" | grep -q 'tool_calls' && echo "$out" | grep -q 'save_memory' && echo "   OK"

echo "mock-llm smoke test passed"
