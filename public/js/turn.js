// Turn orchestration: builds the API request for a chat turn (system prompt +
// injected memories + recent messages) and runs the agentic loop: while the
// model calls save_memory, execute it locally and feed the result back.
import { state } from './state.js';
import { saveChats } from './storage.js';
import { streamCompletion } from './llm.js';
import { addMemory, memoryBlock, MEMORY_TOOL, MEMORY_TOOL_GUIDANCE } from './memory.js';

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
    // Upstream APIs may reject unknown fields like ts and reasoning (thinking
    // is display-only history; models do not expect their own past reasoning).
    const { ts, reasoning, savedFacts, ...clean } = m;
    if (!ts) { prev = null; return clean; }
    const tag = prev == null ? formatTs(ts) : `${formatTs(ts)} (${formatGap(ts - prev)})`;
    prev = ts;
    return { ...clean, content: `[${tag}] ${clean.content}` };
  });
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
  sysParts.push('The current date and time is ' + formatTs(Date.now()) +
    '. Chat messages are tagged [sent-at (+gap since the previous message)], so you can ' +
    'tell how much time passed between turns; take that into account when relevant. ' +
    'Never repeat these tags back to the user.');
  msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  const recent = chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ctx);
  msgs.push(...stampHistory(recent));
  return msgs;
}

// One user turn: keep calling the model while it invokes the memory tool,
// executing tool calls locally and feeding the results back. Max 3 rounds.
// onReasoning streams the model's thinking tokens for the live collapsible.
export async function runChatTurn(chat, asst, onText, onSaved, onReasoning, signal) {
  const apiMessages = buildApiMessages(chat);
  for (let round = 0; round < 3; round++) {
    const { text, toolCalls } = await streamCompletion(
      apiMessages, onText, signal, { tools: [MEMORY_TOOL], onReasoning });
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
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: added ? 'Saved.' : fact ? 'Already known.' : 'No fact given.',
        });
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
