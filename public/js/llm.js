// Transport layer: everything that talks HTTP to the local server.
// Pure data in/out — no DOM, no chat/memory knowledge.
import { state, MOCK_BASE_URL } from './state.js';
import { emit } from './events.js';

export function currentModel() {
  const pref = state.settings.model;
  // A saved model name belongs to the upstream it came from: after the mock
  // toggle swaps the server, a name the new upstream does not serve must not
  // stick — the header label and the request follow the active server.
  if (pref && state.models.length && !state.models.includes(pref)) return state.models[0];
  return pref || state.models[0] || '';
}

// The Settings mock toggle is the only switch that diverts traffic: while it
// is on we pin the always-running built-in mock, and the saved baseUrl stays
// untouched so switching back restores the real endpoint.
export function effectiveBaseUrl() {
  return state.settings.mock ? MOCK_BASE_URL : state.settings.baseUrl;
}

// Discovers served models via the proxy; updates state and notifies listeners.
export async function fetchModels() {
  try {
    const res = await fetch(`/api/models?base=${encodeURIComponent(effectiveBaseUrl())}`, {
      headers: state.settings.apiKey ? { 'X-Upstream-Key': state.settings.apiKey } : {},
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.models = (data.data || []).map((m) => m.id).filter(Boolean);
  } catch (e) {
    state.models = [];
    console.warn('Model discovery failed:', e.message);
  }
  emit('models:changed');
  return state.models;
}

// MCP bridge: discover the server-managed MCP tools and run one call through
// the proxy. Discovery failures just mean "no extra tools" — never fatal.
// Servers unchecked in Settings (settings.mcpDisabled) are skipped without
// spawning; the per-server status feeds the Settings dialog. Returns status.
export async function fetchMcpTools() {
  const disabled = String(state.settings.mcpDisabled || '');
  try {
    const res = await fetch(`/api/mcp/tools?disabled=${encodeURIComponent(disabled)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.mcpTools = Array.isArray(data.tools) ? data.tools : [];
    state.mcpStatus = Array.isArray(data.servers) ? data.servers : [];
    if (data.errors && Object.keys(data.errors).length) console.warn('MCP server errors:', data.errors);
  } catch (e) {
    state.mcpTools = [];
    state.mcpStatus = [];
    console.warn('MCP tool discovery failed:', e.message);
  }
  return state.mcpStatus;
}

export async function callMcpTool(name, args) {
  const res = await fetch('/api/mcp/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `MCP call failed (HTTP ${res.status})`);
  return String(data.content || '');
}

// Streams one completion; resolves to { text, reasoning, toolCalls: [{id, name, args}],
// usage: {prompt, cached} | null }.
// `opts` overrides request fields: temperature, max_tokens, thinking, tools,
// cacheKey (per-chat prompt-cache affinity key),
// onReasoning (live callback for the model's thinking tokens).
export async function streamCompletion(apiMessages, onDelta, signal, opts = {}) {
  const body = {
    base: effectiveBaseUrl(),
    apiKey: state.settings.apiKey,
    model: currentModel(),
    temperature: opts.temperature ?? state.settings.temperature,
    max_tokens: opts.max_tokens ?? state.settings.maxTokens,
    thinking: opts.thinking ?? state.settings.thinking,
    messages: apiMessages,
    tools: opts.tools,
  };
  // cache_key gives every chat a stable KV-cache slot on llama.cpp-style
  // servers, so each turn re-prefills only the new tail instead of the whole
  // conversation; include_usage makes the server report the hit size in a
  // final SSE chunk. Both are dropped when the Settings toggle is off.
  if (opts.cacheKey && state.settings.promptCache !== false) {
    body.cache_key = opts.cacheKey;
    body.stream_options = { include_usage: true };
  }
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* keep default */ }
    throw new Error(detail || `Server returned HTTP ${res.status}`);
  }

  // Parse OpenAI-style SSE: "data: {json}" lines, comments like ": keep-alive" skipped.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  const toolCalls = new Map(); // index -> {id, name, args}
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.error) throw new Error(obj.error.message || 'LLM error');
      // The usage chunk carries no delta (choices is empty), so it must be
      // read before the delta guard below drops it.
      const u = obj.usage ? readUsage(obj) : null;
      if (u) usage = u;
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      // Thinking tokens: llama.cpp/Qwen serve them as a separate delta field.
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        opts.onReasoning?.(delta.reasoning_content);
      }
      if (delta.content) { text += delta.content; onDelta(delta.content); }
      // Streamed tool calls arrive as fragments keyed by index.
      for (const tcd of delta.tool_calls || []) {
        const i = tcd.index ?? 0;
        const tc = toolCalls.get(i) || { id: '', name: '', args: '' };
        if (tcd.id) tc.id = tcd.id;
        if (tcd.function?.name) tc.name = tcd.function.name;
        if (tcd.function?.arguments) tc.args += tcd.function.arguments;
        toolCalls.set(i, tc);
      }
    }
  }
  return { text, reasoning, toolCalls: [...toolCalls.values()].filter((t) => t.name), usage };
}

// Normalizes the token bookkeeping of a final usage chunk into
// { prompt, cached }. OpenAI-style servers put the cache hit in
// usage.prompt_tokens_details.cached_tokens; llama.cpp reports it as
// timings.cache_n. `cached` stays null when the server does not say.
function readUsage(obj) {
  const prompt = Number(obj.usage?.prompt_tokens);
  if (!Number.isFinite(prompt)) return null;
  const raw = obj.usage?.prompt_tokens_details?.cached_tokens
    ?? obj.usage?.prompt_cached_tokens
    ?? obj.timings?.cache_n;
  const cached = Number(raw);
  return { prompt, cached: Number.isFinite(cached) ? cached : null };
}
