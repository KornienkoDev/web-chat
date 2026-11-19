// Chat CRUD. Every mutation persists and emits 'chats:changed' so UI parts
// re-render without knowing about each other.
import { state, uid } from './state.js';
import { saveChats } from './storage.js';
import { emit } from './events.js';

export function mostRecentChatId() {
  let best = null;
  for (const c of state.chats.values()) if (!best || c.updatedAt > best.updatedAt) best = c;
  return best ? best.id : null;
}

export function activeChat() {
  return state.activeId ? state.chats.get(state.activeId) : null;
}

export function newChat() {
  const chat = { id: uid(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.chats.set(chat.id, chat);
  state.activeId = chat.id;
  saveChats();
  emit('chats:changed');
  return chat;
}

export function openChat(id) {
  if (!state.chats.has(id)) return;
  state.activeId = id;
  saveChats();
  emit('chats:changed');
}

export function renameChat(id, title) {
  const c = state.chats.get(id);
  if (!c || !title) return;
  c.title = title.trim().slice(0, 80) || c.title;
  saveChats();
  emit('chats:changed');
}

export function deleteChat(id) {
  state.chats.delete(id);
  if (state.activeId === id) state.activeId = mostRecentChatId();
  saveChats();
  if (!state.activeId) return newChat(); // always keep one chat open
  emit('chats:changed');
}

export function touchChat(chat) {
  chat.updatedAt = Date.now();
  saveChats();
}
