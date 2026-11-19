// Turn orchestration: builds the API request for a chat turn (system prompt +
// injected memories + recent messages) and runs the agentic loop: while the
// model calls save_memory, execute it locally and feed the result back.
import { state } from './state.js';
import { saveChats } from './storage.js';
import { streamCompletion } from './llm.js';
import { addMemory, memoryBlock, MEMORY_TOOL, MEMORY_TOOL_GUIDANCE } from './memory.js';

export function buildApiMessages(chat) {
  const ctx = Math.max(2, Number(state.settings.contextMessages) || 20);
  const msgs = [];
  const sysParts = [];
  const sys = (state.settings.system || '').trim();
  if (sys) sysParts.push(sys);
  const mem = memoryBlock();
  if (mem) sysParts.push(mem);
  sysParts.push(MEMORY_TOOL_GUIDANCE);
  msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  msgs.push(...chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ctx));
  return msgs;
}

// One user turn: keep calling the model while it invokes the memory tool,
// executing tool calls locally and feeding the results back. Max 3 rounds.
export async function runChatTurn(chat, asst, onText, onSaved, signal) {
  const apiMessages = buildApiMessages(chat);
  for (let round = 0; round < 3; round++) {
    const { text, toolCalls } = await streamCompletion(
      apiMessages, onText, signal, { tools: [MEMORY_TOOL] });
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
