// Message list rendering. Data hooks (memory button) go through the domain
// layer and the bus; this module owns no state beyond its own element ref.
import { state } from '../state.js';
import { activeChat } from '../chats.js';
import { addMemory } from '../memory.js';
import { regenerate, editUserMessage } from '../session.js';
import { emit } from '../events.js';
import { $ } from './dom.js';
import { mdToHtml } from './markdown.js';
import { buildProcess } from './timeline.js';

let messagesEl;
let mainEl; // the .main column; gets .empty so CSS can centre the composer
// Whether the list keeps following a streaming reply. Turns off the moment the
// user scrolls up and back on when they return to the bottom, so a reply can't
// hijack the scrollbar mid-stream.
let pinned = true;
// Flags the scroll events our own scrollToBottom() causes, so a growing list
// (which shifts the geometry) is never mistaken for the user scrolling away.
let autoScroll = false;
// The bubble whose text is currently swapped for the inline editor: { cancel() }.
let editing = null;

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
  // The list is about to be rebuilt, which would drop an open inline editor and
  // its listeners without a blur — close it first so no stale state is left.
  if (editing) editing.cancel();
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
    index: i,
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

// Prompt-cache report for a reply: how many prompt tokens the server reused
// from the KV cache of this chat's previous turn. Rendered as plain text (the
// icon font has no spare codepoints — see AGENTS.md); counts are k-formatted
// so the meta row stays narrow on phones.
function fmtTok(n) {
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

export function renderMessage(m, { md = false, canRegenerate = false, index = null } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}${md ? ' md' : ''}`;
  const process = buildProcess(m); // thinking + tool pills, in chronological order
  if (process) el.appendChild(process);
  if (m.attachments?.length) el.appendChild(attachmentsEl(m));
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
    // Cache badge: only for replies that actually ran through the cached path.
    if (m.usage?.prompt) {
      const usage = document.createElement('span');
      usage.className = 'msg-usage';
      usage.textContent = m.usage.cached == null
        ? `${fmtTok(m.usage.prompt)} tok`
        : `${fmtTok(m.usage.cached)}/${fmtTok(m.usage.prompt)} cached`;
      usage.title = m.usage.cached == null
        ? `${m.usage.prompt} prompt tokens sent`
        : `${m.usage.cached} of ${m.usage.prompt} prompt tokens were reused from the server's KV cache`;
      meta.appendChild(usage);
    }
    if (canRegenerate) {
      const regen = document.createElement('button');
      regen.className = 'msg-action msg-regen ic ic-reload';
      regen.title = 'Regenerate reply';
      regen.setAttribute('aria-label', 'Regenerate reply');
      meta.appendChild(regen);
    }
    // Only real, finished user messages are editable (index is null on the
    // live-appended streaming bubble, where it would be meaningless anyway).
    if (m.role === 'user' && index != null && !state.streaming) {
      const edit = document.createElement('button');
      edit.className = 'msg-action msg-edit ic ic-pencil';
      edit.title = 'Edit & resend';
      edit.setAttribute('aria-label', 'Edit message');
      edit.addEventListener('click', () => startEdit(el, index));
      meta.appendChild(edit);
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

// Edit a user message in place (mirrors the sidebar's rename): the bubble text
// swaps for a textarea with Save/Cancel underneath. Enter saves, Shift+Enter
// inserts a newline, Escape cancels. Saving hands the new text to session.js,
// which drops everything after this message and re-answers, so the rest of the
// chat re-grows from the corrected prompt.
function startEdit(msgEl, index) {
  if (editing) editing.cancel(); // a second pencil moves the editor to this bubble
  const chat = activeChat();
  const original = chat?.messages[index];
  if (!original || original.role !== 'user') return;

  const textEl = msgEl.querySelector('.msg-text');
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit-input';
  ta.value = original.content;
  ta.rows = Math.min(12, Math.max(2, ta.value.split('\n').length));
  ta.setAttribute('aria-label', 'Message text');

  const bar = document.createElement('div');
  bar.className = 'msg-edit-actions';
  const btn = (cls, label, fn) => {
    const b = document.createElement('button');
    b.className = `msg-action msg-edit-btn ic ${cls}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    btn('ic-close msg-edit-cancel', 'Cancel', () => finish(false)),
    btn('ic-check msg-edit-save', 'Save & resend', () => finish(true)),
  );
  // The send time rides along on the button row (the meta row hides while
  // editing) so the bubble's bottom edge keeps its usual shape.
  const srcTime = msgEl.querySelector('.msg-time');
  if (srcTime) {
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = srcTime.textContent;
    time.title = srcTime.title;
    bar.prepend(time);
  }

  let finished = false;
  async function finish(commit) {
    if (finished) return; // a button click plus a key must not commit twice
    finished = true;
    editing = null;
    msgEl.classList.remove('editing');
    ta.remove();
    bar.remove();
    textEl.hidden = false;
    // An unchanged or empty text leaves the message as it was; on a real edit
    // session.js rebuilds the whole list, so the reverted text never flashes.
    if (commit) await editUserMessage(index, ta.value);
  }

  // Same keys as the composer: Enter sends, Shift+Enter is a newline, Esc drops it.
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  // Auto-grow like the composer: hug the text, capped at 40% of the viewport.
  const grow = () => {
    ta.style.height = 'auto';
    const border = ta.offsetHeight - ta.clientHeight;
    ta.style.height = Math.min(ta.scrollHeight + border, window.innerHeight * 0.4) + 'px';
  }
  ta.addEventListener('input', grow);

  msgEl.classList.add('editing');
  textEl.hidden = true;
  msgEl.insertBefore(bar, textEl.nextSibling);
  msgEl.insertBefore(ta, bar);
  grow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length); // caret at the end, text visible from the top
  editing = { cancel: () => finish(false) };
}

// Files a user message carries: images render as click-free thumbnails (the
// data URL came from our own FileReader), documents as one-line chips that
// expand to the text. Everything lands via textContent/img.src — model output
// never reaches this path, and neither do file names.
//
// Images are grouped into rows of two (see the CSS note on .attach-row): a
// single wrapping container would stretch the bubble to the width of one
// hypothetical all-in-a-line row, leaving a dead strip beside the grid.
const IMG_ROW_SIZE = 2;

function attachmentsEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-attach';
  const images = m.attachments.filter((a) => a.kind === 'image' && a.dataUrl);
  const others = m.attachments.filter((a) => !(a.kind === 'image' && a.dataUrl));
  for (let i = 0; i < images.length; i += IMG_ROW_SIZE) {
    const row = document.createElement('div');
    row.className = 'attach-row';
    for (const a of images.slice(i, i + IMG_ROW_SIZE)) row.appendChild(attachImg(a));
    wrap.appendChild(row);
  }
  for (const a of others) wrap.appendChild(attachDoc(a));
  return wrap;
}

function attachImg(a) {
  const img = document.createElement('img');
  img.className = 'attach-img';
  img.src = a.dataUrl;
  // Dimension attributes hand the engine the aspect ratio directly: the
  // picture then keeps its shape in every browser and reserves its space
  // before the data URL paints. Older records may lack w/h — skip then.
  if (a.w && a.h) { img.width = a.w; img.height = a.h; }
  img.alt = a.name;
  img.title = a.name;
  img.loading = 'lazy';
  return img;
}

function attachDoc(a) {
  const det = document.createElement('details');
  det.className = 'attach-doc';
  const sum = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'ic ic-file-doc';
  icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'attach-doc-name';
  name.textContent = a.name;
  sum.append(icon, name);
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'attach-doc-text';
  pre.textContent = a.text || '';
  det.appendChild(pre);
  return det;
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
  // While the upstream is still prefilling, the reply bubble would be an empty
  // box — plant a shimmering stand-in word. The first real output clears it:
  // text via renderLiveText, a thinking/tool step via timeline's updateProcess.
  // Never part of renderMessage, so a finished chat can never resurrect it.
  if (m.role === 'assistant') {
    const wait = document.createElement('div');
    wait.className = 'msg-processing';
    wait.textContent = 'Processing\u2026';
    el.insertBefore(wait, el.querySelector('.msg-text'));
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return { el, textEl: el.querySelector('.msg-text') };
}

// Re-render a still-streaming reply's Markdown. Called on a throttle, so partial
// syntax (bold, lists, fences) upgrades to final markup as tokens arrive.
export function renderLiveText(textEl, text) {
  if (text.trim()) textEl.parentElement?.querySelector('.msg-processing')?.remove();
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
