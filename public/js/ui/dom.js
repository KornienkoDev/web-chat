// Small DOM helpers + transient feedback (toast, storage warning banner).
// Toasts and warnings are driven by bus events so data layers never touch them.
import { on } from '../events.js';

export const $ = (id) => document.getElementById(id);

let toastTimer = null;

export function initFeedback() {
  on('toast', (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  });
  on('storage:warning', (text) => {
    const el = $('warning');
    el.textContent = text;
    el.hidden = false;
  });
  on('storage:ok', () => { $('warning').hidden = true; });
}
