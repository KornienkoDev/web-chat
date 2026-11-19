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
// Whether the list keeps following a streaming reply. Turns off the moment the
// user scrolls up and back on when they return to the bottom, so a reply can't
// hijack the scrollbar mid-stream.
let pinned = true;
// Flags the scroll events our own scrollToBottom() causes, so a growing list
// (which shifts the geometry) is never mistaken for the user scrolling away.
let autoScroll = false;

const nearBottom = () =>
  messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 24;

export function initMessages() {
  messagesEl = $('messages');
  // Upward wheel releases the pin instantly (a wheel can land between stream
  // chunks, before a scroll event would); touch and scrollbar drags are judged
  // by the scroll handler, which ignores our own programmatic jumps.
  messagesEl.addEventListener('wheel', (e) => { if (e.deltaY < 0) pinned = false; }, { passive: true });
  messagesEl.addEventListener('scroll', () => {
    if (autoScroll) { autoScroll = false; return; }
    pinned = nearBottom();
  }, { passive: true });
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

// Append one live message and return the nodes the streamer updates. Assistant
// replies start as Markdown so the streaming body upgrades in place.
export function appendMessageEl(m) {
  const el = renderMessage(m, { md: m.role === 'assistant' });
  messagesEl.appendChild(el);
  scrollToBottom();
  return { el, textEl: el.querySelector('.msg-text') };
}

// Re-render a still-streaming reply's Markdown. Called on a throttle, so partial
// syntax (bold, lists, fences) upgrades to final markup as tokens arrive.
export function renderLiveText(textEl, text) {
  textEl.innerHTML = mdToHtml(text);
}

export function updateSavedFacts(el, m) {
  el.querySelector('.msg-saved')?.remove();
  if (m.savedFacts?.length) el.appendChild(savedFactsEl(m));
}

export function atBottom() {
  return pinned;
}
export function scrollToBottom() {
  pinned = true;
  autoScroll = true; // tag this jump so the scroll handler ignores it
  // Force an instant jump: the stylesheet sets scroll-behavior: smooth, and a
  // smooth animation would lag behind (and be retargeted by) each stream chunk.
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'instant' });
}
