// Settings dialog: read/write settings through storage.js.
import { state } from '../state.js';
import { loadSettings, saveSettings } from '../storage.js';
import { fetchModels } from '../llm.js';
import { renderModelLabel } from './header.js';
import { $ } from './dom.js';

export function initSettings() {
  const dialog = $('settingsDialog');
  const form = $('settingsForm');
  const msg = $('settingsMsg');

  $('btnSettings').addEventListener('click', () => {
    fillForm();
    msg.textContent = '';
    dialog.showModal();
    fetchModels().then(fillModelList);
  });

  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    Object.assign(state.settings, readForm());
    saveSettings();
    renderModelLabel();
  });

  // Storage is the source of truth: after closing, reset any unsaved edits.
  dialog.addEventListener('close', () => {
    loadSettings();
    renderModelLabel();
  });

  $('btnTestConn').addEventListener('click', async () => {
    msg.textContent = 'Testing…';
    Object.assign(state.settings, readForm());
    const models = await fetchModels();
    msg.textContent = models.length
      ? `OK — ${models.length} model(s) available`
      : 'Cannot reach the server. Check the base URL above.';
    fillModelList();
  });
}

function readForm() {
  return {
    baseUrl: $('setBaseUrl').value.trim(),
    apiKey: $('setApiKey').value.trim(),
    model: $('setModel').value.trim(),
    temperature: $('setTemp').value.trim(),
    maxTokens: $('setMaxTokens').value.trim(),
    contextMessages: $('setContext').value.trim(),
    system: $('setSystem').value,
    thinking: $('setThinking').value,
  };
}

function fillForm() {
  const s = state.settings;
  $('setBaseUrl').value = s.baseUrl;
  $('setApiKey').value = s.apiKey;
  $('setModel').value = s.model;
  $('setTemp').value = s.temperature;
  $('setMaxTokens').value = s.maxTokens;
  $('setContext').value = s.contextMessages;
  $('setSystem').value = s.system;
  $('setThinking').value = s.thinking;
  fillModelList();
}

function fillModelList() {
  const list = $('modelList');
  list.innerHTML = '';
  for (const id of state.models) {
    const opt = document.createElement('option');
    opt.value = id;
    list.appendChild(opt);
  }
}
