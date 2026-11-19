// Long-term memory domain: storage-backed fact list with duplicate detection,
// the save_memory tool definition the model uses to save facts by itself, and
// the fallback post-reply extractor for models without tool support.
import { state, uid } from './state.js';
import { saveMemory } from './storage.js';
import { streamCompletion } from './llm.js';
import { emit } from './events.js';

export const MEMORY_CAP = 100;   // max stored memories
export const MEMORY_INJECT = 30; // max memories injected into one prompt

export const MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      'Save one durable fact about the user to long-term memory. Call once per fact, ' +
      'only for information that will still matter in future conversations ' +
      '(preferences, personal details, ongoing projects, goals, constraints). ' +
      'Never save trivia, temporary details, or facts already in the memory list.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'One concise, self-contained fact (max ~160 chars).' },
      },
      required: ['fact'],
    },
  },
};

export const MEMORY_TOOL_GUIDANCE =
  'You can remember things with the save_memory tool. When the user reveals a durable ' +
  'fact about themselves, call save_memory with one concise fact per call. Decide yourself ' +
  'what is important — do not ask permission, and do not save trivial or temporary details.';

const normText = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/^(the|a|an)\s+/, '');

export function isDuplicate(a, b) {
  const x = normText(a);
  const y = normText(b);
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 16 && longer.includes(shorter);
}

export function addMemory(text, source = 'manual') {
  const clean = (text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return false;
  if (state.memory.some((m) => isDuplicate(m.text, clean))) return false;
  state.memory.unshift({ id: uid(), text: clean, createdAt: Date.now(), source });
  state.memory = state.memory.slice(0, MEMORY_CAP);
  saveMemory();
  emit('memory:changed');
  return true;
}

export function deleteMemory(id) {
  state.memory = state.memory.filter((m) => m.id !== id);
  saveMemory();
  emit('memory:changed');
}

export function clearMemory() {
  state.memory = [];
  saveMemory();
  emit('memory:changed');
}

// Facts injected into the system prompt so the model "knows" them.
export function memoryBlock() {
  const items = state.memory.slice(0, MEMORY_INJECT);
  if (!items.length) return '';
  return '## Long-term memory (about the user)\n'
    + items.map((m) => `- ${m.text}`).join('\n')
    + '\nUse these facts naturally when relevant. Do not recite this list back.';
}

// ---------- Fallback extractor (opt-in, for models without tools) ----------
const EXTRACT_SYSTEM =
  'You extract durable facts about the user from chat transcripts. ' +
  'Respond with ONLY a JSON array of short strings (each at most 160 chars). ' +
  'Include preferences, personal facts, ongoing projects, goals and constraints. ' +
  'Skip chit-chat, guesses and anything already present in the KNOWN list. ' +
  'If there is nothing new, respond with [].';

// Asks the model for new facts learned from a transcript; returns saved count.
export async function extractFacts(transcript) {
  const known = state.memory.slice(0, 30).map((m) => m.text);
  const convo = transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map((m) => `${m.role}: ${m.content.slice(0, 900)}`)
    .join('\n')
    .slice(0, 8000);
  if (!convo) return 0;

  const { text: raw } = await streamCompletion(
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `KNOWN:\n${known.join('\n') || '(none)'}\n\nTRANSCRIPT:\n${convo}` },
    ],
    () => {},
    null,
    { max_tokens: 240, temperature: 0, thinking: 'off' },
  );

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return 0;
  let facts;
  try { facts = JSON.parse(raw.slice(start, end + 1)); } catch { return 0; }
  if (!Array.isArray(facts)) return 0;

  let added = 0;
  for (const f of facts) if (typeof f === 'string' && addMemory(f, 'auto')) added++;
  return added;
}

// Fire-and-forget extraction after a successful reply.
export async function autoExtract(chat) {
  if (!state.settings.autoExtract || state.extracting) return;
  state.extracting = true;
  try {
    const n = await extractFacts(chat.messages);
    if (n) emit('toast', `Memory: learned ${n} new fact${n > 1 ? 's' : ''}`);
  } catch { /* extraction failures are silent */ }
  state.extracting = false;
}
