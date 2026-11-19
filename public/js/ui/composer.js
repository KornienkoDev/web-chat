// Composer: textarea + paperclip + one send button that turns into a stop
// button while a reply streams. Pure UI; delegates to session.js. Picked,
// pasted or dropped files stage as removable chips above the field and ride
// along with the next message (attachments.js does the file reading).
import { state } from '../state.js';
import { sendMessage, stopStreaming } from '../session.js';
import { readFiles, MAX_ATTACHMENTS } from '../attachments.js';
import { emit } from '../events.js';
import { $ } from './dom.js';

let input, btnSend, btnAttach, fileInput, attachBar, composerEl;
let streaming = false;
let pending = []; // staged attachment records, sent with the next message

export function initComposer() {
  input = $('input');
  btnSend = $('btnSend');
  btnAttach = $('btnAttach');
  fileInput = $('attachFile');
  attachBar = $('attachBar');
  composerEl = attachBar.closest('.composer');

  btnSend.addEventListener('click', () => {
    if (streaming) stopStreaming();
    else send();
  });
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  btnAttach.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    await attachFiles(e.target.files);
    e.target.value = ''; // let the same file be picked again after removal
  });

  // A pasted image or file is a file too — stage it instead of pasting junk.
  input.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) {
      e.preventDefault();
      attachFiles(e.clipboardData.files);
    }
  });

  // Drag & drop anywhere over the chat column stages files as well. The class
  // is the only drop affordance, so clear it on every way the drag can leave.
  const zone = composerEl.closest('.main');
  zone.addEventListener('dragover', (e) => {
    if (state.streaming || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    composerEl.classList.add('dragging');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) composerEl.classList.remove('dragging'); // left the column
  });
  zone.addEventListener('drop', (e) => {
    composerEl.classList.remove('dragging');
    if (state.streaming || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    attachFiles(e.dataTransfer.files);
  });
}

// Enter/send path: attachments move out of `pending` before the send so a
// late-rendering chip can never be attached twice.
function send() {
  if (streaming || (!input.value.trim() && !pending.length)) return;
  const attachments = pending.length ? pending : undefined;
  pending = [];
  renderAttachBar();
  sendMessage(input.value, attachments);
}

// Process files into staged chips; toasts report what was refused.
export async function attachFiles(files) {
  if (state.streaming) return pending.length;
  const { items, errors } = await readFiles(files);
  for (const err of errors) emit('toast', err);
  const room = MAX_ATTACHMENTS - pending.length;
  if (items.length > room) emit('toast', `At most ${MAX_ATTACHMENTS} attachments per message.`);
  pending.push(...items.slice(0, Math.max(0, room)));
  renderAttachBar();
  return pending.length;
}

export function clearInput() {
  input.value = '';
  pending = []; // staged files belong to the message that was just sent
  renderAttachBar();
  autoGrow();
}

export function focusInput() {
  input.focus();
}

export function setStreamingUI(on) {
  streaming = on;
  // The same key sends or halts: one class flips its glyph, colour and label.
  btnSend.classList.toggle('stop-mode', on);
  btnSend.setAttribute('aria-label', on ? 'Stop' : 'Send');
}

// One chip per staged file: a thumbnail for images, a document icon otherwise,
// the name, and an ✕ that puts the file back where it came from.
function renderAttachBar() {
  attachBar.hidden = !pending.length;
  attachBar.innerHTML = '';
  for (const a of pending) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.title = a.name;
    if (a.kind === 'image') {
      const thumb = document.createElement('img');
      thumb.className = 'attach-thumb';
      thumb.src = a.dataUrl;
      thumb.alt = '';
      chip.appendChild(thumb);
    } else {
      const icon = document.createElement('span');
      icon.className = 'ic ic-file-doc';
      icon.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon);
    }
    const name = document.createElement('span');
    name.className = 'attach-chip-name';
    name.textContent = a.name;
    chip.appendChild(name);
    const rm = document.createElement('button');
    rm.className = 'attach-x ic ic-close';
    rm.title = 'Remove attachment';
    rm.setAttribute('aria-label', 'Remove attachment');
    rm.addEventListener('click', () => {
      pending = pending.filter((x) => x.id !== a.id);
      renderAttachBar();
    });
    chip.appendChild(rm);
    attachBar.appendChild(chip);
  }
}

// Auto-grow textarea with the typed text. scrollHeight leaves out the border,
// and the box is border-box, so the border widths must be added back — otherwise
// every height lands 2px short and the field scrolls (a phantom overflow) when
// it should just fit.
function autoGrow() {
  input.style.height = 'auto';
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = Math.min(input.scrollHeight + border, window.innerHeight * 0.4) + 'px';
}
