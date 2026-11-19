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

export function setStreamingUI(on) {
  streaming = on;
  // The same key sends or halts: swap glyph, colour and label with its role.
  btnSend.classList.toggle('stop-mode', on);
  btnSend.innerHTML = on ? '&#9632;' : '&#10148;';
  btnSend.setAttribute('aria-label', on ? 'Stop' : 'Send');
}

// Auto-grow textarea with the typed text.
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
