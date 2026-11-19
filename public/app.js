'use strict';

// ---------- State ----------
// Chats persist in localStorage so history survives reloads and restarts.
const LS_CHATS = 'wc.chats';
const LS_ACTIVE = 'wc.active';
const LS_SETTINGS = 'wc.settings';
const LS_MEMORY = 'wc.memory';

const MEMORY_CAP = 100;      // max stored memories
const MEMORY_INJECT = 30;    // max memories injected into one prompt

const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:8081/v1',
  apiKey: '',
  model: '',
  temperature: '',
  maxTokens: '1024',
  contextMessages: '20',
  system: '',
  thinking: 'default',
  autoExtract: false, // fallback learner for models without tool support
};

const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content}] }
  activeId: null,
  streaming: false,
  search: '',
  settings: { ...DEFAULT_SETTINGS },
  models: [],
  controller: null,
  memory: [], // [{id, text, createdAt, source: 'manual'|'auto'}]
  extracting: false,
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

// ---------- Long-term memory ----------
function loadMemory() {
  try {
    const mem = JSON.parse(localStorage.getItem(LS_MEMORY) || '[]');
    state.memory = (Array.isArray(mem) ? mem : []).filter(
      (m) => m && typeof m.text === 'string' && m.text.trim());
  } catch { state.memory = []; }
}
function saveMemory() {
  try { localStorage.setItem(LS_MEMORY, JSON.stringify(state.memory.slice(0, MEMORY_CAP))); }
  catch (e) { showWarning('Browser storage is full — free some space to keep memories.'); }
}

const normText = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/^(the|a|an)\s+/, '');

function isDuplicate(a, b) {
  const x = normText(a);
  const y = normText(b);
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 16 && longer.includes(shorter);
}

function addMemory(text, source = 'manual') {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return false;
  if (state.memory.some((m) => isDuplicate(m.text, clean))) return false;
  state.memory.unshift({ id: uid(), text: clean, createdAt: Date.now(), source });
  state.memory = state.memory.slice(0, MEMORY_CAP);
  saveMemory();
  renderMemory();
  return true;
}

function deleteMemory(id) {
  state.memory = state.memory.filter((m) => m.id !== id);
  saveMemory();
  renderMemory();
}

// Facts injected into the system prompt so the model "knows" them.
function memoryBlock() {
  const items = state.memory.slice(0, MEMORY_INJECT);
  if (!items.length) return '';
  return '## Long-term memory (about the user)\n'
    + items.map((m) => `- ${m.text}`).join('\n')
    + '\nUse these facts naturally when relevant. Do not recite this list back.';
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
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = m.content;
  el.appendChild(textEl);
  if (m.savedFacts?.length) el.appendChild(savedFactsEl(m));
  if (m.role === 'user' || m.role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const btn = document.createElement('button');
    btn.className = 'msg-action';
    btn.textContent = '🧠';
    btn.title = 'Save this message to memory';
    btn.addEventListener('click', () => {
      if (addMemory(m.content, 'manual')) showToast('Saved to memory');
      else showToast('Already in memory');
    });
    meta.appendChild(btn);
    el.appendChild(meta);
  }
  return el;
}

function savedFactsEl(m) {
  const note = document.createElement('div');
  note.className = 'msg-saved';
  note.textContent = '🧠 remembered: ' + m.savedFacts.join('  ·  ');
  return note;
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
  const sysParts = [];
  const sys = (state.settings.system || '').trim();
  if (sys) sysParts.push(sys);
  const mem = memoryBlock();
  if (mem) sysParts.push(mem);
  sysParts.push(MEMORY_TOOL_GUIDANCE);
  if (sysParts.length) msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  msgs.push(...chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ctx));
  return msgs;
}

// Streams one completion; returns the full text. `opts` overrides request fields.
async function streamCompletion(apiMessages, onDelta, signal, opts = {}) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      model: currentModel(),
      temperature: opts.temperature ?? state.settings.temperature,
      max_tokens: opts.max_tokens ?? state.settings.maxTokens,
      thinking: opts.thinking ?? state.settings.thinking,
      messages: apiMessages,
      tools: opts.tools,
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
  const toolCalls = new Map(); // index -> {id, name, args}
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
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; onDelta(delta.content); }
      // Streamed tool calls arrive as fragments keyed by index.
      for (const tcd of delta.tool_calls || []) {
        const i = tcd.index ?? 0;
        const tc = toolCalls.get(i) || { id: '', name: '', args: '' };
        if (tcd.id) tc.id = tcd.id;
        if (tcd.function?.name) tc.name = tcd.function.name;
        if (tcd.function?.arguments) tc.args += tcd.function.arguments;
        toolCalls.set(i, tc);
      }
    }
  }
  return { text, toolCalls: [...toolCalls.values()].filter((t) => t.name) };
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

// ---------- Memory tool (LLM decides what to save) ----------
const MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      'Save one durable fact about the user to long-term memory. Call once per fact, ' +
      'only for information that will still matter in future conversations ' +
      '(preferences, personal details, ongoing projects, goals, constraints). ' +
      'Never save trivia, temporary details, or facts already in the memory list.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'One concise, self-contained fact (max ~160 chars).' },
      },
      required: ['fact'],
    },
  },
};

const MEMORY_TOOL_GUIDANCE =
  'You can remember things with the save_memory tool. When the user reveals a durable ' +
  'fact about themselves, call save_memory with one concise fact per call. Decide yourself ' +
  'what is important — do not ask permission, and do not save trivial or temporary details.';
const EXTRACT_SYSTEM =
  'You extract durable facts about the user from chat transcripts. ' +
  'Respond with ONLY a JSON array of short strings (each at most 160 chars). ' +
  'Include preferences, personal facts, ongoing projects, goals and constraints. ' +
  'Skip chit-chat, guesses and anything already present in the KNOWN list. ' +
  'If there is nothing new, respond with [].';

// Asks the model for new facts learned from a transcript; returns saved count.
async function extractFacts(transcript) {
  const known = state.memory.slice(0, 30).map((m) => m.text);
  const convo = transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map((m) => `${m.role}: ${m.content.slice(0, 900)}`)
    .join('\n')
    .slice(0, 8000);
  if (!convo) return 0;

  const { text: raw } = await streamCompletion(
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `KNOWN:\n${known.join('\n') || '(none)'}\n\nTRANSCRIPT:\n${convo}` },
    ],
    () => {},
    null,
    { max_tokens: 240, temperature: 0, thinking: 'off' },
  );

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return 0;
  let facts;
  try { facts = JSON.parse(raw.slice(start, end + 1)); } catch { return 0; }
  if (!Array.isArray(facts)) return 0;

  let added = 0;
  for (const f of facts) if (typeof f === 'string' && addMemory(f, 'auto')) added++;
  return added;
}

// Fire-and-forget extraction after a successful reply.
async function autoExtract(chat) {
  if (!state.settings.autoExtract || state.extracting) return;
  state.extracting = true;
  try {
    const n = await extractFacts(chat.messages);
    if (n) showToast(`Memory: learned ${n} new fact${n > 1 ? 's' : ''}`);
  } catch { /* extraction failures are silent */ }
  state.extracting = false;
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
  const textEl = el.querySelector('.msg-text');
  scrollToBottom();

  const onText = (delta) => {
    asst.content += delta;
    textEl.textContent = asst.content;
    if (atBottom()) scrollToBottom();
  };
  const onSaved = () => {
    el.querySelector('.msg-saved')?.remove();
    if (asst.savedFacts?.length) el.appendChild(savedFactsEl(asst));
  };

  try {
    await runChatTurn(chat, asst, onText, onSaved, state.controller.signal);
    if (!asst.content && !asst.savedFacts?.length) asst.content = '(empty response)';
    autoExtract(chat);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!asst.content && !asst.savedFacts?.length) chat.messages.pop();
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

// One user turn: keep calling the model while it invokes the memory tool,
// executing tool calls locally and feeding the results back. Max 3 rounds.
async function runChatTurn(chat, asst, onText, onSaved, signal) {
  const apiMessages = buildApiMessages(chat);
  for (let round = 0; round < 3; round++) {
    const { text, toolCalls } = await streamCompletion(
      apiMessages, onText, signal, { tools: [MEMORY_TOOL] });
    if (!toolCalls.length) return;

    const toolResults = [];
    const saved = [];
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.args || '{}'); } catch { /* malformed args -> empty */ }
      if (tc.name === 'save_memory') {
        const fact = String(args.fact || '').trim();
        const added = addMemory(fact, 'tool');
        if (added && fact) saved.push(fact);
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: added ? 'Saved.' : fact ? 'Already known.' : 'No fact given.',
        });
      } else {
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: 'Unknown tool.' });
      }
    }
    if (saved.length) {
      asst.savedFacts = [...(asst.savedFacts || []), ...saved];
      onSaved();
      saveState();
    }

    apiMessages.push(
      {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args || '{}' },
        })),
      },
      ...toolResults,
    );
  }
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

// ---------- Toast ----------
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- Memory panel ----------
const memoryDialog = $('memoryDialog');

function renderMemory() {
  $('memCount').textContent = state.memory.length ? `(${state.memory.length})` : '';
  $('memCountTitle').textContent = state.memory.length ? `${state.memory.length} saved` : '';
  $('memAuto').checked = !!state.settings.autoExtract;

  const list = $('memList');
  list.innerHTML = '';
  if (!state.memory.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No memories yet. The model saves important facts about you automatically.';
    list.appendChild(empty);
  }
  const tags = { manual: 'you', auto: 'auto', tool: 'by model' };
  for (const m of state.memory) {
    const item = document.createElement('div');
    item.className = 'mem-item';
    const text = document.createElement('span');
    text.className = 'mem-item-text';
    text.textContent = m.text;
    const tag = document.createElement('span');
    tag.className = `mem-tag src-${m.source}`;
    tag.textContent = tags[m.source] || m.source;
    const del = document.createElement('button');
    del.className = 'chat-item-btn chat-item-del';
    del.textContent = '\u2715';
    del.title = 'Forget';
    del.addEventListener('click', () => deleteMemory(m.id));
    item.append(text, tag, del);
    list.appendChild(item);
  }
}

$('btnMemory').addEventListener('click', () => { renderMemory(); memoryDialog.showModal(); });
$('btnMemClose').addEventListener('click', () => memoryDialog.close());
$('btnMemAdd').addEventListener('click', () => {
  const inp = $('memInput');
  if (addMemory(inp.value, 'manual')) { inp.value = ''; showToast('Saved to memory'); }
});
$('memAuto').addEventListener('change', (e) => {
  state.settings.autoExtract = e.target.checked;
  saveSettings();
});
$('btnMemExtract').addEventListener('click', async () => {
  const chat = activeChat();
  if (!chat) return;
  const status = $('memStatus');
  status.hidden = false;
  status.textContent = 'Extracting…';
  try {
    const n = await extractFacts(chat.messages);
    status.textContent = n ? `Added ${n} new fact${n > 1 ? 's' : ''}.` : 'Nothing new found.';
  } catch (e) {
    status.textContent = `Extraction failed: ${e.message}`;
  }
});
$('btnMemClear').addEventListener('click', () => {
  if (!state.memory.length || !confirm('Forget all saved memories?')) return;
  state.memory = [];
  saveMemory();
  renderMemory();
});

// ---------- Boot ----------
loadSettings();
loadMemory();
loadState();
renderMemory();
renderModelLabel();
fetchModels();
if (!state.activeId) newChat({ focus: false }); else renderAll();
