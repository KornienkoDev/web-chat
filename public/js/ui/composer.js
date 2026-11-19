// Composer: textarea + one send button that turns into a stop button while a
// reply streams. Pure UI; delegates to session.js.
import { sendMessage, stopStreaming } from '../session.js';
import { $ } from './dom.js';

let input, btnSend;
let streaming = false;

export function initComposer() {
  input = $('input');
  btnSend = $('btnSend');

  btnSend.addEventListener('click', () => {
    if (streaming) stopStreaming();
    else sendMessage(input.value);
  });
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });
}

export function clearInput() {
  input.value = '';
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

// Auto-grow textarea with the typed text. scrollHeight leaves out the border,
// and the box is border-box, so the border widths must be added back — otherwise
// every height lands 2px short and the field scrolls (a phantom overflow) when
// it should just fit.
function autoGrow() {
  input.style.height = 'auto';
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = Math.min(input.scrollHeight + border, window.innerHeight * 0.4) + 'px';
}
