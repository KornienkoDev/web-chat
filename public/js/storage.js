// Persistence boundary: everything that touches localStorage lives here.
// The UI never calls localStorage directly, so storage keys and (de)serialization
// are defined once. Storage failures emit a 'storage:warning' event instead of
// reaching into the DOM.
import { state, DEFAULT_SETTINGS } from './state.js';
import { emit } from './events.js';

const LS_CHATS = 'wc.chats';
const LS_ACTIVE = 'wc.active';
const LS_SETTINGS = 'wc.settings';
const LS_MEMORY = 'wc.memory';
const LS_THEME = 'wc.theme';

// ---------- Theme ----------
// The pre-paint inline script in index.html reads the same key directly;
// keep the two in sync if this ever changes shape.
export function loadThemePref() {
  const v = localStorage.getItem(LS_THEME);
  return v === 'light' || v === 'dark' ? v : null; // null = follow the system
}
export function saveThemePref(pref) {
  if (pref === 'light' || pref === 'dark') localStorage.setItem(LS_THEME, pref);
  else localStorage.removeItem(LS_THEME);
}

// ---------- Chats ----------
export function loadChats() {
  try {
    const chats = JSON.parse(localStorage.getItem(LS_CHATS) || '[]');
    for (const c of Array.isArray(chats) ? chats : []) {
      if (c && typeof c.id === 'string' && Array.isArray(c.messages)) state.chats.set(c.id, c);
    }
  } catch (e) {
    console.warn('Could not read saved chats:', e);
  }
  const saved = localStorage.getItem(LS_ACTIVE);
  state.activeId = state.chats.has(saved) ? saved : null;
}

export function saveChats() {
  const chats = [...state.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  try {
    localStorage.setItem(LS_CHATS, JSON.stringify(chats));
    if (state.activeId) localStorage.setItem(LS_ACTIVE, state.activeId);
    emit('storage:ok');
  } catch (e) {
    emit('storage:warning', 'Browser storage is full — the oldest chats may not be saved. Delete some to free space.');
  }
}

// ---------- Settings ----------
export function loadSettings() {
  try {
    Object.assign(state.settings, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'));
  } catch {
    Object.assign(state.settings, DEFAULT_SETTINGS);
  }
}
export function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
}

// ---------- Memory ----------
// Memories are mirrored to localStorage and persisted to a JSON file by the
// server (/api/memory). The file is the durable copy: it survives clearing
// browser data and can be edited outside the app.
const API_MEMORY = '/api/memory';
const MEMORY_SYNC_CAP = 500;

const memKey = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

function parseMemories(value) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.memory) ? value.memory : null;
  if (!list) return [];
  const out = [];
  for (const m of list.slice(0, MEMORY_SYNC_CAP)) {
    if (!m || typeof m.text !== 'string') continue;
    const text = m.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      id: typeof m.id === 'string' && m.id ? m.id : Math.random().toString(36).slice(2, 10),
      text,
      createdAt: Number.isFinite(m.createdAt) ? m.createdAt : Date.now(),
      source: ['manual', 'auto', 'tool'].includes(m.source) ? m.source : 'manual',
    });
  }
  return out;
}

function loadMemoryLocal() {
  try {
    const mem = JSON.parse(localStorage.getItem(LS_MEMORY) || '[]');
    state.memory = parseMemories(mem);
  } catch {
    state.memory = [];
  }
}

function mirrorMemory() {
  try {
    localStorage.setItem(LS_MEMORY, JSON.stringify(state.memory));
  } catch {
    emit('storage:warning', 'Browser storage is full — free some space to keep memories.');
  }
}

// Loads the file copy from the server and merges it with the browser copy so
// facts added while the server was unreachable are not lost.
export async function loadMemory() {
  loadMemoryLocal();
  try {
    const res = await fetch(API_MEMORY, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const fromFile = parseMemories(data);
    state.memoryFile = typeof data.file === 'string' ? data.file : '';
    if (fromFile.length) {
      const seen = new Set(fromFile.map((m) => memKey(m.text)));
      const extra = state.memory.filter((m) => !seen.has(memKey(m.text)));
      state.memory = [...fromFile, ...extra].slice(0, MEMORY_SYNC_CAP);
      mirrorMemory();
    } else if (state.memory.length) {
      // File is empty but the browser has facts: seed the file.
      saveMemory();
    }
    emit('memory:changed');
  } catch {
    // No server file (or opened without the server): keep the local copy.
  }
}

// Debounced file writes: saving a memory should feel instant even though it
// also goes over HTTP, and bulk edits (import) produce one write.
let memWriteTimer = null;
let memWritePending = false;
// Serializes PUTs so they never overlap and resolves with the outcome of the
// newest queued write ({ ok } or { ok: false, error }). saveMemoryNow() awaits it.
let memWriteSettled = Promise.resolve();

function writeMemoryFile() {
  const payload = JSON.stringify({ memory: state.memory });
  return fetch(API_MEMORY, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json().catch(() => ({}));
    })
    .then((data) => {
      if (data && typeof data.file === 'string') state.memoryFile = data.file;
      emit('storage:ok');
      return { ok: true };
    })
    .catch((e) => {
      emit('storage:warning', 'Could not save memories to the server file — they are only in browser storage.');
      return { ok: false, error: e instanceof TypeError ? 'unreachable' : e.message };
    });
}

function flushMemoryFile() {
  memWriteTimer = null;
  if (!memWritePending) return;
  memWritePending = false;
  memWriteSettled = memWriteSettled
    .then(writeMemoryFile)
    .finally(() => { if (memWritePending) flushMemoryFile(); });
}

function scheduleMemoryWrite() {
  memWritePending = true;
  if (memWriteTimer) return;
  memWriteTimer = setTimeout(flushMemoryFile, 250);
}

export function saveMemory() {
  mirrorMemory();
  scheduleMemoryWrite();
}

// Forces the full memory list into the server file right now, bypassing the
// debounce, so the "Save to file" button can report a definite result.
// Resolves { saved, error, count, file }; on failure `error` explains why.
export async function saveMemoryNow() {
  mirrorMemory();
  if (memWriteTimer) { clearTimeout(memWriteTimer); memWriteTimer = null; }
  memWritePending = true;
  flushMemoryFile();
  const res = await memWriteSettled;
  return { saved: res.ok, error: res.error, count: state.memory.length, file: state.memoryFile };
}
