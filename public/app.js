'use strict';

// ---------- State ----------
// Chats are kept in memory for now (browser storage comes next).
const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content}] }
  activeId: null,
  streaming: false,
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function newChat() {
  const chat = { id: uid(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.chats.set(chat.id, chat);
  state.activeId = chat.id;
  renderAll();
  input.focus();
}

function activeChat() {
  return state.activeId ? state.chats.get(state.activeId) : null;
}

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const sidebar = $('sidebar');
const backdrop = $('backdrop');
const messagesEl = $('messages');
const input = $('input');
const btnSend = $('btnSend');
const btnStop = $('btnStop');
const chatTitleEl = $('chatTitle');
const modelLabelEl = $('modelLabel');

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

// ---------- Rendering ----------
function renderAll() {
  const chat = activeChat();
  chatTitleEl.textContent = chat ? chat.title : 'New chat';
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

  if (!activeChat()) newChat();
  const chat = activeChat();

  chat.messages.push({ role: 'user', content: text });
  chat.updatedAt = Date.now();
  if (chat.title === 'New chat') chat.title = text.slice(0, 40);
  input.value = '';
  autoGrow();
  renderAll();

  // Placeholder reply until the LLM connection is wired up.
  setStreaming(true);
  await new Promise((r) => setTimeout(r, 300));
  chat.messages.push({ role: 'assistant', content: `Echo: ${text}` });
  chat.updatedAt = Date.now();
  setStreaming(false);
  renderAll();
}

function setStreaming(on) {
  state.streaming = on;
  btnSend.hidden = on;
  btnStop.hidden = !on;
  input.disabled = false;
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
newChat();
