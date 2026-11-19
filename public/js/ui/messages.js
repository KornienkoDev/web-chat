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
let mainEl; // the .main column; gets .empty so CSS can centre the composer
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
  mainEl = messagesEl.closest('.main');
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
        copy.classList.replace('ic-copy', 'ic-check');
        copy.classList.add('copied');
        setTimeout(() => {
          copy.classList.replace('ic-check', 'ic-copy');
          copy.classList.remove('copied');
        }, 1500);
      }
      return;
    }
    if (e.target.closest('.msg-regen')) regenerate();
  });
}

export function renderMessages() {
  const chat = activeChat();
  // No messages yet -> CSS floats the composer in the middle of the screen.
  mainEl.classList.toggle('empty', !chat || chat.messages.length === 0);
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

// Human-friendly send time: "13:34" today, "Nov 16, 13:34" this year, with the
// year when older. Hovering shows the full system timestamp.
function formatMsgTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString([], opts)}, ${time}`;
}

// Collapsible model reasoning: collapsed by default, only open while the model
// is still generating (mountLiveThink).
function thinkEl(m, { open = false, label = 'Thinking' } = {}) {
  const box = document.createElement('details');
  box.className = 'msg-think';
  box.open = open;
  const sum = document.createElement('summary');
  sum.textContent = label;
  const body = document.createElement('div');
  body.className = 'msg-think-text';
  body.textContent = m.reasoning || '';
  box.append(sum, body);
  return box;
}

export function renderMessage(m, { md = false, canRegenerate = false } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}${md ? ' md' : ''}`;
  if (m.reasoning) el.appendChild(thinkEl(m));
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  if (md) textEl.innerHTML = mdToHtml(m.content);
  else textEl.textContent = m.content;
  el.appendChild(textEl);
  if (m.savedFacts?.length) el.appendChild(savedFactsEl(m));
  if (m.role === 'user' || m.role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (m.ts) {
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = formatMsgTime(m.ts);
      time.title = new Date(m.ts).toLocaleString();
      meta.appendChild(time);
    }
    if (canRegenerate) {
      const regen = document.createElement('button');
      regen.className = 'msg-action msg-regen ic ic-reload';
      regen.title = 'Regenerate reply';
      regen.setAttribute('aria-label', 'Regenerate reply');
      meta.appendChild(regen);
    }
    const copy = document.createElement('button');
    copy.className = 'msg-action msg-copy ic ic-copy';
    copy.title = 'Copy text';
    copy.setAttribute('aria-label', 'Copy reply text');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(m.content);
      emit('toast', 'Copied');
    });
    meta.appendChild(copy);
    const btn = document.createElement('button');
    btn.className = 'msg-action ic ic-brain';
    btn.title = 'Save this message to memory';
    btn.setAttribute('aria-label', 'Save this message to memory');
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
  // The icon is a styled span; the facts themselves stay a single text node.
  const icon = document.createElement('span');
  icon.className = 'ic ic-brain';
  icon.setAttribute('aria-hidden', 'true');
  note.append(icon, 'Remembered: ' + m.savedFacts.join('  ·  '));
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

// Called on the first thinking token: mounts an open live think block at the
// top of the bubble and returns the element the streamer fills.
export function mountLiveThink(el, m) {
  const box = thinkEl(m, { open: true, label: 'Thinking\u2026' });
  el.prepend(box);
  return box.querySelector('.msg-think-text');
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
