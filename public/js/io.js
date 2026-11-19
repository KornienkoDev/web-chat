// Backup: export chats + memories to a JSON file, import (merge) it back.
import { state } from './state.js';
import { saveChats } from './storage.js';
import { addMemory } from './memory.js';
import { emit } from './events.js';

export function exportData() {
  const data = {
    app: 'web_chat',
    version: 1,
    exportedAt: new Date().toISOString(),
    chats: [...state.chats.values()],
    memory: state.memory,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `web-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Saves just the memory list as a plain JSON file, in the same shape as the
// server's memories.json, for when the server's file endpoint is unreachable.
export function downloadMemories() {
  const blob = new Blob([JSON.stringify(state.memory, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'memories.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    emit('toast', 'Import failed: not a valid JSON file.');
    return;
  }
  if (!data || data.app !== 'web_chat' || !Array.isArray(data.chats)) {
    emit('toast', 'Import failed: not a web chat backup file.');
    return;
  }
  const sources = new Set(['manual', 'auto', 'tool']);
  let chats = 0;
  for (const c of data.chats) {
    if (c && typeof c.id === 'string' && Array.isArray(c.messages) && !state.chats.has(c.id)) {
      state.chats.set(c.id, c);
      chats++;
    }
  }
  let mem = 0;
  for (const m of Array.isArray(data.memory) ? data.memory : []) {
    if (m && typeof m.text === 'string') {
      mem += addMemory(m.text, sources.has(m.source) ? m.source : 'manual') ? 1 : 0;
    }
  }
  saveChats();
  emit('chats:changed');
  emit('toast', `Imported ${chats} chat(s), ${mem} memories.`);
}
