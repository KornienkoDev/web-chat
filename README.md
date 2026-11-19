# Local Web Chat

A small, fast, self-hosted chat UI for a **locally served LLM**. No build step,
no dependencies — just Node and a browser. The whole frontend runs on the
machine and the conversation never leaves it.

## Quick start

```bash
node server.js                 # serves the UI on http://localhost:3000
```

Open <http://localhost:3000>. By default the app talks to an OpenAI-compatible
server at `http://127.0.0.1:8081/v1` (e.g. llama.cpp's `llama-server`).
Everything is configurable in **Settings** (works with llama.cpp, vLLM, LM
Studio, Ollama `…/v1`, …): API base URL, API key, model (auto-discovered from
`/models`), temperature, max tokens, context size, system prompt and a
thinking-mode toggle for Qwen-style models.

## Features

- **Chat history in browser storage** — multiple chats with search, rename and
  delete; everything lives in `localStorage`, nothing on the server.
- **Memory** — the model saves durable facts about *you* by itself using a
  native `save_memory` tool call (it decides what matters mid-conversation);
  facts are injected into every future prompt, shown as a "remembered" badge,
  and manageable in the Memory panel (manual add, per-chat extraction, forget).
  Memories are persisted to a plain JSON file on the server (`memories.json`,
  override with `WC_MEMORY_FILE`) and mirrored to `localStorage`, so they
  survive clearing site data and can be edited or backed up by hand. A
  **Save to file** button in the panel forces the full list to disk right away;
  if the server is unreachable it downloads a `memories.json` copy instead, so
  the browser copy always reaches a real file. A fallback post-reply extractor
  exists for models without tool support.
- **Streaming** responses (SSE) with a Stop button that aborts upstream
  generation too.
- **Mobile-first responsive UI** — drawer sidebar on phones, safe-area aware,
  16 px inputs (no iOS zoom), touch targets ≥ 40 px.
- Markdown rendering (XSS-safe, own mini-renderer) with copy buttons on code
  blocks, regenerate reply, per-message copy.
- JSON **export/import** of all chats + memories.
- **Privacy:** the built-in proxy only accepts **localhost** LLM endpoints
  (`WC_ALLOW_LAN=1` relaxes it to private LAN ranges for when the model runs
  on another box). The proxy exists purely to avoid CORS — the browser cannot
  reach the LLM directly from another origin.

## Architecture

```
server.js              static file server + localhost-only LLM proxy (streams SSE)
                       + /api/memory JSON-file storage for memories
public/
  index.html, style.css
  js/
    main.js            entry: module wiring + boot
    events.js          event bus (data layer <-> UI decoupling)
    state.js           single app state + defaults
    storage.js         the ONLY place that touches localStorage
    chats.js           chat CRUD (persists + emits events)
    llm.js             transport: /api/chat streaming, /api/models discovery
    memory.js          memory domain: dedup, save_memory tool, extractors
    turn.js            one user turn: prompt assembly + agentic tool loop
    session.js         send-flow service (stream, stop, errors) — UI hooks injected
    io.js              export/import backups
    ui/                dom, header, messages, sidebar, composer, settings,
                       memoryPanel, markdown (pure view layer)
test/
  cdp-suite.mjs        end-to-end browser suite via Chrome DevTools Protocol
  smoke-mock.sh        curl smoke test for mock-llm.js
mock-llm.js            OpenAI-compatible fake server for testing without a GPU
```

## Testing

```bash
# 1) mock LLM smoke test (no browser):
bash test/smoke-mock.sh

# 2) full browser suite (needs Chromium + app + a reachable LLM):
chromium --headless=new --no-sandbox --remote-debugging-port=9222 about:blank &
node server.js &
node test/cdp-suite.mjs        # CDP_URL / APP_URL env vars supported
```

Point **Settings → API base URL** at `http://127.0.0.1:11435/v1` after
`node mock-llm.js` to try the whole UI (including the memory tool flow)
without a real model.

## Notes

- Chats are stored per browser profile; use Export before clearing data.
- Memories are stored both in `localStorage` and in **`memories.json`** next to
  `server.js`. Point `WC_MEMORY_FILE=/path/to/file.json` at another location
  (or a mounted volume) to keep them elsewhere. The file is plain JSON and can
  be edited while the app is stopped; the Memory panel shows its full path.
- The proxy rejects non-local targets, so the page can never be tricked into
  hitting arbitrary URLs.
