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
  'what is important — do not ask permission, and do not save trivial or temporary details. ' +
  'If a new fact contradicts one from the memory list, save the new one and call ' +
  'forget_memory for the outdated id.';

export const FORGET_TOOL = {
  type: 'function',
  function: {
    name: 'forget_memory',
    description:
      'Forget one saved fact from long-term memory. Use when the user says a stored fact is ' +
      'wrong, outdated or should be removed, or when you replace an old fact with a newer one. ' +
      'Identify the fact by its id from the memory list (e.g. "m3") or by distinctive wording.',
    parameters: {
      type: 'object',
      properties: {
        memory_id_or_text: {
          type: 'string',
          description: 'Memory id from the list (e.g. "m3") or a distinctive part of the fact text.',
        },
      },
      required: ['memory_id_or_text'],
    },
  },
};

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

// Facts injected into the system prompt, newest first. Each line gets a short
// id and the date the fact was learned, so the model can tell which of two
// contradicting facts is newer and can name one to forget. forgetMemory()
// resolves those ids against the refs of the latest rendered block.
let lastRefs = []; // [{ref, id}] mirroring the ids shown in the current block

function factDate(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function memoryBlock() {
  const items = state.memory.slice(0, MEMORY_INJECT);
  if (!items.length) { lastRefs = []; return ''; }
  lastRefs = items.map((m, i) => ({ ref: `m${i + 1}`, id: m.id }));
  return '## Long-term memory (about the user), newest first\n'
    + 'Each line: [id | date learned] fact. If two facts contradict, the newer date wins.\n'
    + items.map((m, i) => `- [${lastRefs[i].ref} | ${factDate(m.createdAt)}] ${m.text}`).join('\n')
    + '\nUse these facts naturally when relevant. Do not recite this list back. '
    + 'If the user says one is wrong or outdated, forget it with forget_memory (give its id) '
    + 'and save the corrected fact.';
}

// Deletes one memory by list id ("m3"), by uid prefix, or by wording: exact
// text, substring, or every long-ish word of the query appearing in the fact
// (small models paraphrase). Ambiguous wording deletes nothing and answers
// with the candidate ids so the model can retry precisely. Returns a message
// for the model.
export function forgetMemory(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 'No memory identifier given.';

  const refHit = lastRefs.find((r) => r.ref === q);
  let hit = null;
  if (refHit) {
    hit = state.memory.find((m) => m.id === refHit.id) || null;
  } else {
    const uidHits = q.length >= 4
      ? state.memory.filter((m) => String(m.id).toLowerCase().startsWith(q))
      : [];
    if (uidHits.length === 1) hit = uidHits[0];
    if (!hit) {
      let matches = state.memory.filter((m) => normText(m.text).includes(normText(q)));
      if (!matches.length) {
        const words = normText(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
        if (words.length) matches = state.memory.filter((m) => words.every((w) => normText(m.text).includes(w)));
      }
      if (matches.length === 1) hit = matches[0];
      if (matches.length > 1) {
        const cands = matches.slice(0, 4).map((m) => {
          const ref = lastRefs.find((r) => r.id === m.id);
          return `${ref ? ref.ref + ': ' : ''}"${m.text.slice(0, 60)}"`;
        });
        return `Several memories match "${query}" — which one? ${cands.join(' | ')}. Call again with the exact id.`;
      }
    }
  }
  if (!hit) return `No stored memory matches "${query}". Use an id like m1 from the memory list.`;
  deleteMemory(hit.id);
  return `Forgot: ${hit.text}`;
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
