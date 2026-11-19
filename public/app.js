'use strict';

// ---------- State ----------
// Chats persist in localStorage so history survives reloads and restarts.
const LS_CHATS = 'wc.chats';
const LS_ACTIVE = 'wc.active';

const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content}] }
  activeId: null,
  streaming: false,
  search: '',
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

// ---------- Sending ----------
async function sendMessage() {
  const text = input.value.trim();
  if (!text || state.streaming) return;

  const chat = activeChat() || newChat();
  chat.messages.push({ role: 'user', content: text });
  if (chat.title === 'New chat') chat.title = text.slice(0, 40);
  touchChat(chat);
  input.value = '';
  autoGrow();
  renderAll();

  // Placeholder reply until the LLM connection is wired up.
  setStreaming(true);
  await new Promise((r) => setTimeout(r, 300));
  chat.messages.push({ role: 'assistant', content: `Echo: ${text}` });
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

// ---------- Boot ----------
loadState();
if (!state.activeId) newChat({ focus: false }); else renderAll();
