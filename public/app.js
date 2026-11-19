'use strict';

// ---------- State ----------
// Chats persist in localStorage so history survives reloads and restarts.
const LS_CHATS = 'wc.chats';
const LS_ACTIVE = 'wc.active';
const LS_SETTINGS = 'wc.settings';

const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:8081/v1',
  apiKey: '',
  model: '',
  temperature: '',
  maxTokens: '1024',
  contextMessages: '20',
  system: '',
  thinking: 'default',
};

const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content}] }
  activeId: null,
  streaming: false,
  search: '',
  settings: { ...DEFAULT_SETTINGS },
  models: [],
  controller: null,
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadState() {
  try {
    const chats = JSON.parse(localStorage.getItem(LS_CHATS) || '[]');
    for (const c of Array.isArray(chats) ? chats : []) {
      if (c && typeof c.id === 'string' && Array.isArray(c.messages)) state.chats.set(c.id, c);
    }
  } catch (e) {
    console.warn('Could not read saved chats:', e);
  }
  const saved = localStorage.getItem(LS_ACTIVE);
  state.activeId = state.chats.has(saved) ? saved : mostRecentChatId();
}

function saveState() {
  const chats = [...state.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  try {
    localStorage.setItem(LS_CHATS, JSON.stringify(chats));
    if (state.activeId) localStorage.setItem(LS_ACTIVE, state.activeId);
    hideWarning();
  } catch (e) {
    showWarning('Browser storage is full — the oldest chats may not be saved. Delete some to free space.');
  }
}

function loadSettings() {
  try {
    Object.assign(state.settings, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'));
  } catch (e) {
    state.settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
}

function mostRecentChatId() {
  let best = null;
  for (const c of state.chats.values()) if (!best || c.updatedAt > best.updatedAt) best = c;
  return best ? best.id : null;
}

function newChat({ focus = true } = {}) {
  const chat = { id: uid(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.chats.set(chat.id, chat);
  state.activeId = chat.id;
  saveState();
  renderAll();
  if (focus) input.focus();
  return chat;
}

function activeChat() {
  return state.activeId ? state.chats.get(state.activeId) : null;
}

function touchChat(chat) {
  chat.updatedAt = Date.now();
  saveState();
}

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const sidebar = $('sidebar');
const backdrop = $('backdrop');
const messagesEl = $('messages');
const chatListEl = $('chatList');
const chatSearchEl = $('chatSearch');
const input = $('input');
const btnSend = $('btnSend');
const btnStop = $('btnStop');
const chatTitleEl = $('chatTitle');
const modelLabelEl = $('modelLabel');
const warningEl = $('warning');

function showWarning(text) {
  warningEl.textContent = text;
  warningEl.hidden = false;
}
function hideWarning() {
  warningEl.hidden = true;
}

// ---------- Sidebar drawer (mobile) ----------
function openSidebar() {
  sidebar.classList.add('open');
  backdrop.hidden = false;
}
function closeSidebar() {
  sidebar.classList.remove('open');
  backdrop.hidden = true;
}

$('btnMenu').addEventListener('click', openSidebar);
backdrop.addEventListener('click', closeSidebar);
$('btnNewChat').addEventListener('click', () => { newChat(); closeSidebar(); });

// ---------- Chat list (sidebar) ----------
function chatMatches(c, query) {
  return c.title.toLowerCase().includes(query) || c.messages.some((m) => m.content.toLowerCase().includes(query));
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                 : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderChatList() {
  const q = state.search.trim().toLowerCase();
  const chats = [...state.chats.values()]
    .filter((c) => !q || chatMatches(c, q))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  chatListEl.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === state.activeId ? ' active' : '');

    const main = document.createElement('div');
    main.className = 'chat-item-main';
    main.innerHTML = `<span class="chat-item-title"></span><span class="chat-item-date"></span>`;
    main.firstChild.textContent = c.title || 'Untitled';
    main.lastChild.textContent = fmtDate(c.updatedAt);
    main.title = c.title;
    main.addEventListener('click', () => {
      state.activeId = c.id;
      saveState();
      renderAll();
      closeSidebar();
    });

    const btnRename = document.createElement('button');
    btnRename.className = 'chat-item-btn';
    btnRename.textContent = '\u270E'; // pencil
    btnRename.title = 'Rename';
    btnRename.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = prompt('Rename chat', c.title);
      if (t && t.trim()) { c.title = t.trim().slice(0, 80); saveState(); renderAll(); }
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'chat-item-btn chat-item-del';
    btnDel.textContent = '\u2715'; // cross
    btnDel.title = 'Delete';
    btnDel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.title}"?`)) return;
      state.chats.delete(c.id);
      if (state.activeId === c.id) state.activeId = mostRecentChatId();
      saveState();
      if (!state.activeId) newChat({ focus: false }); else renderAll();
    });

    item.append(main, btnRename, btnDel);
    chatListEl.appendChild(item);
  }
}

chatSearchEl.addEventListener('input', () => {
  state.search = chatSearchEl.value;
  renderChatList();
});

// ---------- Message rendering ----------
function renderAll() {
  const chat = activeChat();
  chatTitleEl.textContent = chat ? chat.title : 'New chat';
  renderChatList();
  messagesEl.innerHTML = '';
  if (!chat) return;
  for (const m of chat.messages) messagesEl.appendChild(renderMessage(m));
  scrollToBottom();
}

function renderMessage(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.textContent = m.content;
  return el;
}

function atBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- LLM connection ----------
function currentModel() {
  return state.settings.model || state.models[0] || '';
}

function buildApiMessages(chat) {
  const ctx = Math.max(2, Number(state.settings.contextMessages) || 20);
  const msgs = [];
  const sys = state.settings.system.trim();
  if (sys) msgs.push({ role: 'system', content: sys });
  msgs.push(...chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ctx));
  return msgs;
}

// Streams a chat completion from the local server, calling onDelta for text chunks.
async function streamChat(chat, onDelta, signal) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      model: currentModel(),
      temperature: state.settings.temperature,
      max_tokens: state.settings.maxTokens,
      thinking: state.settings.thinking,
      messages: buildApiMessages(chat),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(detail || `Server returned HTTP ${res.status}`);
  }

  // Parse OpenAI-style SSE: "data: {json}" lines, comments like ": keep-alive" skipped.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.error) throw new Error(obj.error.message || 'LLM error');
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) { text += delta; onDelta(delta); }
    }
  }
  return text;
}

async function fetchModels() {
  try {
    const res = await fetch(`/api/models?base=${encodeURIComponent(state.settings.baseUrl)}`, {
      headers: state.settings.apiKey ? { 'X-Upstream-Key': state.settings.apiKey } : {},
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.models = (data.data || []).map((m) => m.id).filter(Boolean);
  } catch (e) {
    state.models = [];
    console.warn('Model discovery failed:', e.message);
  }
  renderModelLabel();
  return state.models;
}

function renderModelLabel() {
  modelLabelEl.textContent = currentModel() || 'no model — check Settings';
}

// ---------- Sending ----------
async function sendMessage() {
  const text = input.value.trim();
  if (!text || state.streaming) return;

  const chat = activeChat() || newChat();
  chat.messages.push({ role: 'user', content: text });
  if (chat.title === 'New chat') chat.title = text.slice(0, 40);
  input.value = '';
  autoGrow();
  renderAll();

  setStreaming(true);
  state.controller = new AbortController();
  const asst = { role: 'assistant', content: '' };
  chat.messages.push(asst);
  const el = renderMessage(asst);
  messagesEl.appendChild(el);
  scrollToBottom();

  try {
    await streamChat(chat, (delta) => {
      asst.content += delta;
      el.textContent = asst.content;
      if (atBottom()) scrollToBottom();
    }, state.controller.signal);
    if (!asst.content) asst.content = '(empty response)';
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!asst.content) chat.messages.pop();
    } else {
      chat.messages.pop();
      chat.messages.push({ role: 'error', content: e.message });
    }
  }
  state.controller = null;
  touchChat(chat);
  setStreaming(false);
  renderAll();
}

function setStreaming(on) {
  state.streaming = on;
  btnSend.hidden = on;
  btnStop.hidden = !on;
}

btnSend.addEventListener('click', sendMessage);
btnStop.addEventListener('click', () => state.controller?.abort());

input.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-grow textarea with the typed text.
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
input.addEventListener('input', autoGrow);

// ---------- Settings dialog ----------
const settingsDialog = $('settingsDialog');
const settingsForm = $('settingsForm');
const settingsMsg = $('settingsMsg');

function readSettingsForm() {
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

function fillSettingsForm() {
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

$('btnSettings').addEventListener('click', () => {
  fillSettingsForm();
  settingsMsg.textContent = '';
  settingsDialog.showModal();
  fetchModels().then(fillModelList);
});

settingsForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  Object.assign(state.settings, readSettingsForm());
  saveSettings();
  renderModelLabel();
});

// Storage is the source of truth: after closing, reset any unsaved edits.
settingsDialog.addEventListener('close', () => {
  loadSettings();
  renderModelLabel();
});

$('btnTestConn').addEventListener('click', async () => {
  settingsMsg.textContent = 'Testing…';
  Object.assign(state.settings, readSettingsForm());
  const models = await fetchModels();
  settingsMsg.textContent = models.length
    ? `OK — ${models.length} model(s) available`
    : 'Cannot reach the server. Check the base URL above.';
  fillModelList();
});

// ---------- Boot ----------
loadSettings();
loadState();
renderModelLabel();
fetchModels();
if (!state.activeId) newChat({ focus: false }); else renderAll();
