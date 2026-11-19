// Composer: textarea + send/stop buttons. Pure UI; delegates to session.js.
import { sendMessage, stopStreaming } from '../session.js';
import { $ } from './dom.js';

let input, btnSend, btnStop;

export function initComposer() {
  input = $('input');
  btnSend = $('btnSend');
  btnStop = $('btnStop');

  btnSend.addEventListener('click', () => sendMessage(input.value));
  btnStop.addEventListener('click', stopStreaming);
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
  btnSend.hidden = on;
  btnStop.hidden = !on;
}

// Auto-grow textarea with the typed text.
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
