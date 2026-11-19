// Message list rendering. Data hooks (memory button) go through the domain
// layer and the bus; this module owns no state beyond its own element ref.
import { state } from '../state.js';
import { activeChat } from '../chats.js';
import { addMemory } from '../memory.js';
import { regenerate } from '../session.js';
import { emit } from '../events.js';
import { $ } from './dom.js';
import { mdToHtml } from './markdown.js';

let messagesEl;

export function initMessages() {
  messagesEl = $('messages');
  // Delegated: code copy buttons and the regenerate action.
  messagesEl.addEventListener('click', (e) => {
    const copy = e.target.closest('.code-copy');
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.innerText);
        copy.textContent = 'copied';
        setTimeout(() => { copy.textContent = 'copy'; }, 1500);
      }
      return;
    }
    if (e.target.closest('.msg-regen')) regenerate();
  });
}

export function renderMessages() {
  const chat = activeChat();
  messagesEl.innerHTML = '';
  if (!chat) return;
  const last = chat.messages.length - 1;
  const canRegenerate = !state.streaming
    && chat.messages[last]?.role === 'assistant'
    && chat.messages.some((m) => m.role === 'user');
  chat.messages.forEach((m, i) => messagesEl.appendChild(renderMessage(m, {
    md: m.role === 'assistant',
    canRegenerate: i === last && canRegenerate,
  })));
  scrollToBottom();
}

export function renderMessage(m, { md = false, canRegenerate = false } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}${md ? ' md' : ''}`;
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  if (md) textEl.innerHTML = mdToHtml(m.content);
  else textEl.textContent = m.content;
  el.appendChild(textEl);
  if (m.savedFacts?.length) el.appendChild(savedFactsEl(m));
  if (m.role === 'user' || m.role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (canRegenerate) {
      const regen = document.createElement('button');
      regen.className = 'msg-action msg-regen';
      regen.textContent = '\u21BB'; // ↻
      regen.title = 'Regenerate reply';
      meta.appendChild(regen);
    }
    const copy = document.createElement('button');
    copy.className = 'msg-action msg-copy';
    copy.textContent = '\u2398'; // ⎘
    copy.title = 'Copy text';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(m.content);
      emit('toast', 'Copied');
    });
    meta.appendChild(copy);
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
