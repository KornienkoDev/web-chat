// Turn orchestration: builds the API request for a chat turn (system prompt +
// injected memories + recent messages) and runs the agentic loop: while the
// model calls save_memory, execute it locally and feed the result back.
import { state } from './state.js';
import { saveChats } from './storage.js';
import { streamCompletion, callMcpTool } from './llm.js';
import { addMemory, memoryBlock, MEMORY_TOOL, MEMORY_TOOL_GUIDANCE, FORGET_TOOL, forgetMemory } from './memory.js';

// Per-message clock for the model: each history message gets its send time and
// the gap since the previous one, and the system prompt states the current
// time. Messages saved before timestamps existed stay untagged. Annotation
// happens on copies so stored chats keep their clean text.
// Local system clock with explicit UTC offset, e.g. "2026-11-19 13:34:07 UTC+02:00".
function formatTs(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `
    + `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function formatGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '+moments';
  if (min < 60) return `+${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `+${h}h ${min % 60}m` : `+${h}h`;
  const d = Math.floor(h / 24);
  return `+${d}d ${h % 24}h`;
}

function stampHistory(msgs) {
  let prev = null;
  return msgs.map((m) => {
    // Upstream APIs may reject unknown fields like ts and reasoning (thinking,
    // saved facts and the tool-usage timeline are display-only history; models
    // do not expect their own past reasoning or tool-use notes echoed back).
    const { ts, reasoning, savedFacts, mcpUsed, timeline, ...clean } = m;
    if (!ts) { prev = null; return clean; }
    const tag = prev == null ? formatTs(ts) : `${formatTs(ts)} (${formatGap(ts - prev)})`;
    prev = ts;
    return { ...clean, content: `[${tag}] ${clean.content}` };
  });
}

// Tells small models the search/fetch tools are there for a reason.
const MCP_TOOL_GUIDANCE =
  'You also have live tools (such as web search) available right now. Use them whenever ' +
  'the answer depends on current events, recent information, or any fact you are not ' +
  'fully sure about — call the tool first, then answer from its result. Do not claim you ' +
  'cannot browse the web.';

// A short one-line preview of a tool call's arguments for the usage badge: the
// first meaningful argument (a search query or URL usually), flattened and
// capped so one long prompt can't stretch the badge across the screen.
function mcpArgPreview(args) {
  if (!args || typeof args !== 'object') return '';
  const preferred = ['query', 'q', 'search', 'url', 'uri', 'text', 'input', 'prompt', 'name'];
  let hit = '';
  for (const k of preferred) {
    if (typeof args[k] === 'string' && args[k].trim()) { hit = args[k].trim(); break; }
  }
  if (!hit) {
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.trim()) { hit = v.trim(); break; }
      if (typeof v === 'number' || typeof v === 'boolean') { hit = String(v); break; }
    }
  }
  const flat = hit.replace(/\s+/g, ' ');
  return flat.length > 80 ? flat.slice(0, 80) + '…' : flat;
}

// Collapse a raw string (a saved fact, a forget target) to a single short line
// for a tool pill's tooltip.
function preview(s, max = 80) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function buildApiMessages(chat) {
  const ctx = Math.max(2, Number(state.settings.contextMessages) || 20);
  const msgs = [];
  const sysParts = [];
  const sys = (state.settings.system || '').trim();
  if (sys) sysParts.push(sys);
  const mem = memoryBlock();
  if (mem) sysParts.push(mem);
  sysParts.push(MEMORY_TOOL_GUIDANCE);
  if (state.mcpTools.length) sysParts.push(MCP_TOOL_GUIDANCE);
  sysParts.push('The current date and time is ' + formatTs(Date.now()) +
    '. Chat messages are tagged [sent-at (+gap since the previous message)], so you can ' +
    'tell how much time passed between turns; take that into account when relevant. ' +
    'Never repeat these tags back to the user.');
  msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  const recent = chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ctx);
  msgs.push(...stampHistory(recent));
  return msgs;
}

// One user turn: keep calling the model while it invokes tools (save_memory,
// forget_memory or any MCP tool), executing them locally and feeding the
// results back. Max 6 rounds so a search -> read -> answer chain fits.
//
// Everything the model does this turn — its thinking and every tool call — is
// recorded on `asst.timeline` as one ordered list of steps ({kind:'think'|
// 'tool', …}) so a multi-round turn reads think → tool → think → tool instead
// of one merged blob. onText streams the answer; onSaved refreshes the
// "Remembered" note; onTimeline redraws the process strip after each change.
export async function runChatTurn(chat, asst, onText, onSaved, onTimeline, signal) {
  const apiMessages = buildApiMessages(chat);
  const tools = state.mcpTools.length
    ? [MEMORY_TOOL, FORGET_TOOL, ...state.mcpTools]
    : [MEMORY_TOOL, FORGET_TOOL];

  const steps = () => (asst.timeline || (asst.timeline = []));
  // Reasoning tokens grow the current think step; the first token after a tool
  // call opens a fresh one — that boundary is what the timeline is for.
  const onReasoning = (delta) => {
    const list = steps();
    const last = list[list.length - 1];
    if (last && last.kind === 'think') last.text += delta;
    else list.push({ kind: 'think', text: delta });
    onTimeline?.();
  };

  for (let round = 0; round < 6; round++) {
    const { text, toolCalls } = await streamCompletion(
      apiMessages, onText, signal, { tools, onReasoning });
    if (!toolCalls.length) return;

    const toolResults = [];
    const saved = [];
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.args || '{}'); } catch { /* malformed args -> empty */ }
      if (tc.name === 'save_memory') {
        const fact = String(args.fact || '').trim();
        const added = addMemory(fact, 'tool');
        if (added && fact) saved.push(fact);
        steps().push({ kind: 'tool', family: 'memory', action: 'save', name: tc.name, arg: preview(fact) });
        onTimeline?.();
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: added ? 'Saved.' : fact ? 'Already known.' : 'No fact given.',
        });
      } else if (tc.name === 'forget_memory') {
        const target = String(args.memory_id_or_text || '');
        steps().push({ kind: 'tool', family: 'memory', action: 'forget', name: tc.name, arg: preview(target) });
        onTimeline?.();
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: forgetMemory(target),
        });
      } else if (state.mcpTools.some((t) => t.function.name === tc.name)) {
        // A live "running" pill flips to ok/error as the call resolves; it stays
        // the newest timeline step for the whole call, so the view can update it.
        const step = { kind: 'tool', family: 'mcp', name: tc.name, arg: mcpArgPreview(args), status: 'running' };
        steps().push(step);
        onTimeline?.();
        let out;
        try {
          out = await callMcpTool(tc.name, args);
          step.status = 'ok';
        } catch (err) {
          out = `Tool call failed: ${err.message}`;
          step.status = 'error';
          step.error = err.message;
        }
        onTimeline?.();
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: out });
      } else {
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: 'Unknown tool.' });
      }
    }
    if (saved.length) {
      asst.savedFacts = [...(asst.savedFacts || []), ...saved];
      onSaved();
      saveChats();
    }

    apiMessages.push(
      {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args || '{}' },
        })),
      },
      ...toolResults,
    );
  }
}
