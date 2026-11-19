# AGENTS.md — Local Web Chat

Guidance for AI agents (and humans) working in this repository.

## What this is

A small, self-hosted chat UI for a locally served OpenAI-compatible LLM.
Frontend + Node server, **zero npm dependencies, no build step**. Node ≥ 22.

## Hard rules

1. **No dependencies.** Never add `package.json` deps, npm installs, or a build step.
   The server (`server.js`, `mcp.js`, `mock-llm.js`) uses only `node:*` builtins;
   the frontend is native ES modules loaded straight by the browser. If a feature
   needs a library, implement it by hand or don't do it.
2. **Never delete or rewrite user data.** `memories.json` (gitignored) is real user
   data; `mcp.json` is a user-authored config — treat both like `server.js` itself.
3. **Privacy guarantee:** the `/api/chat` proxy must only accept localhost targets
   (private-LAN only with `WC_ALLOW_LAN=1`). Do not loosen this validation.
4. **XSS safety:** all model output is rendered through the mini-renderer in
   `public/js/ui/markdown.js` (escapes first). Never introduce `innerHTML` with
   unescaped content anywhere in `public/`.
5. **No network in tests.** The test suite drives `mock-llm.js` and
   `test/mock-mcp-server.js` only — never the real model, never the real `mcp.json`.

## Commands

```bash
./start.sh                     # app on :3000 (expects a model on :8081); the mock LLM always runs silently on :11435 — the Settings "Use built-in mock LLM" toggle is the only switch that diverts traffic to it

bash test/smoke-mock.sh        # quick curl smoke test of the mock LLM (no browser)
./test/run.sh                  # full CDP browser suite (needs Chromium; deterministic, no GPU/network)
APP_PORT=3100 MOCK_PORT=11436 ./test/run.sh   # free ports while a dev instance runs
```

There is no linter/formatter/test-runner config — style is what the codebase already does.
**Always run the suite after changes touching server.js, turn/session flow, memory, or MCP.**

## Environment variables

`PORT` (3000), `MOCK_PORT` (11435), `WC_MEMORY_FILE` (./memories.json),
`WC_ALLOW_LAN` (0), `WC_MCP_CONFIG` (./mcp.json), `APP_PORT`/`MOCK_PORT`/`CDP_PORT` (tests).

## Architecture (see README.md for the full map)

- `server.js` — static files + localhost-only LLM proxy (SSE) + `/api/memory`
  JSON-file storage + `/api/mcp/{tools,call}` bridge. CommonJS.
- `mcp.js` — zero-dep MCP stdio client (spawn, JSON-RPC, tool registry). Tools are
  exposed to the model as `server__tool`.
- `public/js/` — native ESM, layered:
  - data layer: `storage.js` (the **only** file allowed to touch `localStorage`),
    `state.js`, `chats.js`, `memory.js`, `attachments.js`, `llm.js`, `turn.js`,
    `session.js`, `io.js`
  - glue: `events.js` (event bus), `main.js` (wiring/boot, exposes `window.__wc` for tests)
  - view layer: `public/js/ui/*` — pure rendering, **never touches the DOM from the
    data layer**, never imports UI modules from data modules; UI subscribes via `on()`.
- `mock-llm.js` — OpenAI-compatible fake server; `test/` — CDP suite, mock MCP server.

Data-flow rule of thumb: data modules mutate state and `emit()`; `ui/` modules
subscribe and render. `session.js` injects UI hooks instead of importing `ui/`.

## Code style (match the existing code)

- 2-space indent, single quotes, semicolons, trailing commas in multiline literals.
- Server files: `'use strict';` + `require('node:*')`. Frontend: `import`/`export`, no bundler syntax.
- Every file starts with a short block comment explaining **why** the module exists
  and any non-obvious contract (read a few existing files before writing new ones —
  they are the style reference).
- Comment the *why* and the gotchas, not the what (e.g. "mktemp leaves the file empty,
  which the server reads as invalid JSON; seed it").
- Prefer small named functions over long inline blocks; keep functions flat (early returns).
- Shell scripts: bash with `set -euo pipefail` and a header comment explaining usage.

## Testing conventions

- `test/run.sh` deliberately **refuses to start** if the app/mock ports are already
  in use and points the app at a throwaway `WC_TEST_MEM_FILE`; keep that guard intact —
  the suite wipes the memory file as its first step.
- New end-to-end behavior goes into `test/cdp-suite.mjs` (drives Chrome via CDP,
  asserts through `window.__wc` and the DOM). Keep tests deterministic: mock LLM +
  `test/mock-mcp-server.js`, fixed responses, no timing races.

## Commit style

Conventional-ish, lowercase, imperative, short: `feat: …`, `fix: …`, `style: …`,
`chore: …`, `docs: …`. One logical change per commit; describe user-visible effect.

## Gotchas

- `memories.json` and `memories.json.*.tmp` are gitignored — never commit them,
  and never run the CDP suite against a server using the real one.
- Icon font: all icons come from the 21-codepoint subset
  `public/fonts/wc-icons.woff2`. Adding an icon means updating the codepoint list in
  `tools/subset-icons.sh` **and** a `.ic-*` rule in `style.css` (or the
  `summary::before` chevron codepoint) and rebuilding with `tools/subset-icons.sh`
  (needs `fonttools`/`pyftsubset` + brotli, font path via `SYMBOLS_FONT`).
  A missing codepoint renders as a silent blank box.
- `mcp.json`'s `ddg-search` entry pins `duckduckgo-mcp-server==0.7.0` and sets
  `PYTHONWARNINGS` with a **builtin** warning category only — dotted paths like
  `mcp.shared.exceptions.MCPDeprecationWarning` are not importable at interpreter
  start and get dropped with a warning.
- Memory format is load-bearing: facts render as `[m<id> | <date>] text` (newest
  first) so the model can resolve contradictions with `forget_memory`. Changing the
  format touches `memory.js`, prompt assembly in `turn.js`, and the panel in
  `ui/memoryPanel.js`.
- The per-message timeline (`msg.timeline`: think/tool steps) is stripped from the
  history sent back to the model — keep renderer (`ui/timeline.js`) and
  `turn.js` prompt assembly in sync when extending it.
- Prompt cache: requests carry a per-chat+model `cache_key` (built in
  `turn.js`, forwarded by the `/api/chat` proxy) so llama.cpp-style servers
  pin a chat to a KV-cache slot. Everything before the newest message must
  stay token-stable across turns — notably the volatile "current date and
  time" line rides in a **trailing** system message (`buildApiMessages`);
  moving it back into the leading system prompt silently invalidates the
  cache for the whole conversation every turn. `msg.usage`
  (`{prompt, cached}` tokens, badge in `ui/messages.js`) is display-only and
  stripped in `stampHistory()` like the timeline.
- Mobile-first: inputs stay at 16 px (iOS zoom), touch targets ≥ 40 px, respect safe areas.
