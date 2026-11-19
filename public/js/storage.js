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
export function loadMemory() {
  try {
    const mem = JSON.parse(localStorage.getItem(LS_MEMORY) || '[]');
    state.memory = (Array.isArray(mem) ? mem : []).filter(
      (m) => m && typeof m.text === 'string' && m.text.trim());
  } catch {
    state.memory = [];
  }
}
export function saveMemory() {
  try {
    localStorage.setItem(LS_MEMORY, JSON.stringify(state.memory));
    emit('storage:ok');
  } catch {
    emit('storage:warning', 'Browser storage is full — free some space to keep memories.');
  }
}
