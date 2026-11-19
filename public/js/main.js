// Entry point: wires the modules together, boots persisted state, and exposes
// a small `window.__wc` handle used for debugging and automated tests.
import { state } from './state.js';
import { loadSettings, loadChats, loadMemory, saveSettings } from './storage.js';
import { activeChat, newChat, openChat, mostRecentChatId } from './chats.js';
import { fetchModels } from './llm.js';
import { sendMessage, stopStreaming, regenerate, initSession } from './session.js';
import { addMemory, deleteMemory } from './memory.js';
import { on } from './events.js';

import { $, initFeedback } from './ui/dom.js';
import { initHeader, renderHeader } from './ui/header.js';
import { initMessages, renderMessages, appendMessageEl, updateSavedFacts, atBottom, scrollToBottom } from './ui/messages.js';
import { initSidebar, renderChatList, renderMemCount } from './ui/sidebar.js';
import { initComposer, clearInput, setStreamingUI } from './ui/composer.js';
import { initSettings } from './ui/settings.js';
import { initMemoryPanel } from './ui/memoryPanel.js';
import { exportData, importData } from './io.js';

function renderAll() {
  renderHeader();
  renderMessages();
  renderChatList();
}

function boot() {
  initFeedback();
  initHeader();
  initMessages();
  initSidebar();
  initComposer();
  initSettings();
  initMemoryPanel();

  initSession({
    renderAll,
    appendMessage: appendMessageEl,
    updateSavedFacts,
    clearInput,
    setStreaming: setStreamingUI,
    atBottom,
    scrollToBottom,
  });

  on('chats:changed', renderAll);

  $('btnExport').addEventListener('click', exportData);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = '';
  });

  loadSettings();
  loadMemory();
  loadChats();
  if (!state.activeId) state.activeId = mostRecentChatId();
  if (!state.activeId) newChat(); else renderAll();
  renderMemCount();
  fetchModels();

  window.__wc = {
    state, $, activeChat, newChat, openChat, sendMessage, stopStreaming, regenerate,
    fetchModels, addMemory, deleteMemory, renderAll, saveSettings, loadSettings,
    exportData, importData,
    input: $('input'),
  };
}

boot();
