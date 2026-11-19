// Message list rendering. Data hooks (memory button) go through the domain
// layer and the bus; this module owns no state beyond its own element ref.
import { activeChat } from '../chats.js';
import { addMemory } from '../memory.js';
import { emit } from '../events.js';
import { $ } from './dom.js';

let messagesEl;

export function initMessages() {
  messagesEl = $('messages');
}

export function renderMessages() {
  const chat = activeChat();
  messagesEl.innerHTML = '';
  if (!chat) return;
  for (const m of chat.messages) messagesEl.appendChild(renderMessage(m));
  scrollToBottom();
}

export function renderMessage(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = m.content;
  el.appendChild(textEl);
  if (m.savedFacts?.length) el.appendChild(savedFactsEl(m));
  if (m.role === 'user' || m.role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const btn = document.createElement('button');
    btn.className = 'msg-action';
    btn.textContent = '🧠';
    btn.title = 'Save this message to memory';
    btn.addEventListener('click', () => {
      emit('toast', addMemory(m.content, 'manual') ? 'Saved to memory' : 'Already in memory');
    });
    meta.appendChild(btn);
    el.appendChild(meta);
  }
  return el;
}

function savedFactsEl(m) {
  const note = document.createElement('div');
  note.className = 'msg-saved';
  note.textContent = '🧠 remembered: ' + m.savedFacts.join('  ·  ');
  return note;
}

// Append one live message and return the nodes the streamer updates.
export function appendMessageEl(m) {
  const el = renderMessage(m);
  messagesEl.appendChild(el);
  scrollToBottom();
  return { el, textEl: el.querySelector('.msg-text') };
}

export function updateSavedFacts(el, m) {
  el.querySelector('.msg-saved')?.remove();
  if (m.savedFacts?.length) el.appendChild(savedFactsEl(m));
}

export function atBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}
export function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
