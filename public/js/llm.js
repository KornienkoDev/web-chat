// Transport layer: everything that talks HTTP to the local server.
// Pure data in/out — no DOM, no chat/memory knowledge.
import { state } from './state.js';
import { emit } from './events.js';

export function currentModel() {
  return state.settings.model || state.models[0] || '';
}

// Discovers served models via the proxy; updates state and notifies listeners.
export async function fetchModels() {
  try {
    const res = await fetch(`/api/models?base=${encodeURIComponent(state.settings.baseUrl)}`, {
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
export async function fetchMcpTools() {
  try {
    const res = await fetch('/api/mcp/tools');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.mcpTools = Array.isArray(data.tools) ? data.tools : [];
    if (data.errors && Object.keys(data.errors).length) console.warn('MCP server errors:', data.errors);
  } catch (e) {
    state.mcpTools = [];
    console.warn('MCP tool discovery failed:', e.message);
  }
  return state.mcpTools;
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

// Streams one completion; resolves to { text, reasoning, toolCalls: [{id, name, args}] }.
// `opts` overrides request fields: temperature, max_tokens, thinking, tools,
// onReasoning (live callback for the model's thinking tokens).
export async function streamCompletion(apiMessages, onDelta, signal, opts = {}) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      model: currentModel(),
      temperature: opts.temperature ?? state.settings.temperature,
      max_tokens: opts.max_tokens ?? state.settings.maxTokens,
      thinking: opts.thinking ?? state.settings.thinking,
      messages: apiMessages,
      tools: opts.tools,
    }),
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
  return { text, reasoning, toolCalls: [...toolCalls.values()].filter((t) => t.name) };
}
