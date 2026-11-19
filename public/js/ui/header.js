// Top bar: chat title + current model label.
import { activeChat } from '../chats.js';
import { currentModel } from '../llm.js';
import { on } from '../events.js';
import { $ } from './dom.js';

export function initHeader() {
  on('models:changed', renderModelLabel);
}

export function renderHeader() {
  const chat = activeChat();
  $('chatTitle').textContent = chat ? chat.title : 'New chat';
}

export function renderModelLabel() {
  $('modelLabel').textContent = currentModel() || 'no model — check Settings';
}
