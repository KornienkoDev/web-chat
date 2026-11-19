// Theme control. Colours live in style.css as tokens that flip on <html class="dark">.
// Default follows the OS (prefers-color-scheme, tracked live); an explicit choice
// made with the topbar toggle is persisted and wins until the user clears it.
// The head script in index.html applies the same resolution before first paint.
import { loadThemePref, saveThemePref } from '../storage.js';
import { $ } from './dom.js';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function isDark() {
  const pref = loadThemePref();
  return pref ? pref === 'dark' : media.matches;
}

function apply() {
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#151515' : '#fcfcfc');
  const btn = $('btnTheme');
  if (btn) {
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = loadThemePref() ? `${dark ? 'Dark' : 'Light'} (manual)` : `${dark ? 'Dark' : 'Light'} (follows system)`;
  }
}

export function initTheme() {
  apply();
  $('btnTheme').addEventListener('click', () => {
    saveThemePref(isDark() ? 'light' : 'dark');
    apply();
  });
  // While no explicit choice exists, keep up with the OS.
  media.addEventListener('change', () => { if (!loadThemePref()) apply(); });
}
