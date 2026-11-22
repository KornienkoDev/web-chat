// Turn orchestration: builds the API request for a chat turn (system prompt +
// injected memories + recent messages) and runs the agentic loop: while the
// model calls save_memory, execute it locally and feed the result back.
import { state } from './state.js';
import { saveChats } from './storage.js';
import { streamCompletion, callMcpTool, currentModel } from './llm.js';
import { addMemory, memoryBlock, MEMORY_TOOL, MEMORY_TOOL_GUIDANCE, FORGET_TOOL, forgetMemory } from './memory.js';
import { documentPartText } from './attachments.js';

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
    // saved facts, the tool-usage timeline and the prompt-cache badge are
    // display-only history; models do not expect their own past reasoning or
    // tool-use notes echoed back).
    const { ts, reasoning, savedFacts, mcpUsed, timeline, attachments, usage, ...clean } = m;
    let tag = '';
    if (ts) {
      tag = prev == null ? formatTs(ts) : `${formatTs(ts)} (${formatGap(ts - prev)})`;
      prev = ts;
    } else {
      prev = null;
    }
    if (!attachments?.length) {
      return tag ? { ...clean, content: `[${tag}] ${clean.content}` } : clean;
    }
    // A user message with attachments: the caption and any text documents
    // travel as one text part (so even non-vision upstreams get every word),
    // images as OpenAI `image_url` parts carrying their base64 data URL.
    let text = (tag ? `[${tag}] ` : '') + (clean.content || '');
    for (const a of attachments) {
      if (a.kind === 'text') text += (text.trim() ? '\n\n' : '') + documentPartText(a);
    }
    const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
    if (!images.length) return { ...clean, content: text };
    const parts = [];
    if (text.trim()) parts.push({ type: 'text', text });
    for (const a of images) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    return { ...clean, content: parts };
  });
}

// Tells small models the search/fetch tools are there for a reason.
const MCP_TOOL_GUIDANCE =
  'You also have live tools (such as web search) available right now. Use them whenever ' +
  'the answer depends on current events, recent information, or any fact you are not ' +
  'fully sure about — call the tool first, then answer from its result. Do not claim you ' +
  'cannot browse the web.';

// Default cap on model calls per turn that may still invoke tools; Settings
// exposes it as maxToolRounds. When the model keeps searching past the
// budget, the turn must not simply stop: the loop breaks and one tool-less
// wrap-up call forces the conclusion (runChatTurn).
const DEFAULT_TOOL_ROUNDS = 20;

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
  sysParts.push('Chat messages are tagged [sent-at (+gap since the previous message)], so you can ' +
    'tell how much time passed between turns; take that into account when relevant. ' +
    'Never repeat these tags back to the user.');
  msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  const recent = chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ctx);
  msgs.push(...stampHistory(recent));
  // The clock rides in a trailing user message, NOT inside the leading system
  // prompt: prompt caches only reuse KV state up to the first changed token,
  // so a time string in the system prompt would invalidate everything behind
  // it — the whole conversation — on every single turn. Kept at the end, only
  // this one line re-prefills; everything before it stays byte-stable across
  // turns. It is a user, not a system, message on purpose: Qwen3's chat
  // template raises "System message must be at the beginning" for any system
  // message after the first, and user is the only trailing role every chat
  // template accepts.
  msgs.push({ role: 'user', content: 'The current date and time is ' + formatTs(Date.now()) + '.' });
  return msgs;
}

// Prompt-cache affinity key: stable for one chat on one model, so a llama.cpp
// style server pins the chat to one KV-cache slot and reuses the prefix every
// turn. The model is part of the key because KV state is model-specific — on
// a model switch the old slot is useless, so start a fresh one instead of
// polluting it. chat.id is a random uid; the slug keeps the whole key
// lowercase-alphanumeric so any server accepts it.
function cacheKeyFor(chat) {
  const slug = currentModel().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `wc1-${chat.id}${slug ? '-' + slug : ''}`;
}

// One user turn: keep calling the model while it invokes tools (save_memory,
// forget_memory or any MCP tool), executing them locally and feeding the
// results back. Tool-using model calls are capped per turn by the
// `maxToolRounds` setting (default 20) so a search -> read -> answer chain
// fits; if the model still wants tools when the budget runs out, the turn
// ends with a forced, tool-less conclusion call instead of stopping on a tool
// pill (see runChatTurn).
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

  // Small models sometimes emit an immediate EOS right after receiving tool
  // results (long search dumps make it likelier): the round returns no text
  // and no tool call, the turn would end with just the pills and the answer
  // silently lost. Give the model one nudge out of that state — the nudge
  // lives only in the transient apiMessages, so it never reaches the saved
  // chat or the next turn's prompt.
  let nudged = false;
  const nudge = () => apiMessages.push({
    role: 'user',
    content: '(no answer received - please answer now, using the tool results shown above.)',
  });

  // Tool-round budget from Settings (empty/invalid falls back to 20; the
  // 1..50 clamp mirrors the Settings input's min/max so a hand-edited
  // localStorage value cannot stall a tab on an endless search chain).
  const maxRounds = Math.max(1, Math.min(50, Number(state.settings.maxToolRounds) || DEFAULT_TOOL_ROUNDS));

  // One model request plus the prompt-cache bookkeeping for the badge: across
  // tool rounds the total is the work done and `cached` the part the server
  // reused; a server that does not report the hit keeps `cached` null (badge
  // then shows tokens only). Pass `tools` for a tool round, omit them for the
  // tool-less conclusion call.
  const ask = async (roundTools) => {
    const r = await streamCompletion(
      apiMessages, onText, signal, { tools: roundTools, onReasoning, cacheKey: cacheKeyFor(chat) });
    if (r.usage) {
      const prev = asst.usage || { prompt: 0, cached: null };
      asst.usage = {
        prompt: prev.prompt + r.usage.prompt,
        cached: r.usage.cached == null && prev.cached == null
          ? null
          : (prev.cached || 0) + (r.usage.cached || 0),
      };
    }
    return r;
  };

  for (let round = 0; round < maxRounds; round++) {
    const { text, toolCalls } = await ask(tools);
    if (!toolCalls.length) {
      // A real answer (or a model that never used tools) ends the turn.
      if (text || round === 0) return;
      // Empty on a round that followed tool results -> nudge once; a second
      // such quit falls through to the forced conclusion below.
      if (!nudged) {
        nudged = true;
        nudge();
        continue;
      }
      break;
    }

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

  // Forced conclusion. Reaching here means the turn used tools and then either
  // ran out of rounds mid-chain (the classic "turn stops during a ddg-search
  // chain": the last round asked for another search and nothing ever answered
  // it) or quit empty twice after tool results. One last request with the
  // tools taken away leaves the model no move but to summarize what the
  // results already in the context say — a turn that used tools must end on
  // an answer, never on a tool pill.
  // A user, not a system, message: Qwen3's chat template raises on any
  // system message after the first (see the trailing clock above).
  apiMessages.push({
    role: 'user',
    content: 'The tool budget for this turn is used up. Do not call any more '
      + 'tools - answer the user now, using the tool results shown above.',
  });
  if (!(await ask()).text && !nudged) {
    nudged = true;
    nudge();
    await ask();
  }
}
