// Sidebar: mobile drawer, chat list (open/rename/delete/search), memory count.
import { state } from '../state.js';
import { openChat, renameChat, deleteChat, newChat } from '../chats.js';
import { on } from '../events.js';
import { $ } from './dom.js';

let sidebarEl, backdropEl, chatListEl, chatSearchEl;

export function initSidebar() {
  sidebarEl = $('sidebar');
  backdropEl = $('backdrop');
  chatListEl = $('chatList');
  chatSearchEl = $('chatSearch');

  $('btnMenu').addEventListener('click', openSidebar);
  backdropEl.addEventListener('click', closeSidebar);
  $('btnNewChat').addEventListener('click', () => { newChat(); closeSidebar(); });
  chatSearchEl.addEventListener('input', () => {
    state.search = chatSearchEl.value;
    renderChatList();
  });

  on('chats:changed', renderChatList);
  on('memory:changed', renderMemCount);
}

export function openSidebar() {
  sidebarEl.classList.add('open');
  backdropEl.hidden = false;
}
export function closeSidebar() {
  sidebarEl.classList.remove('open');
  backdropEl.hidden = true;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                 : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function chatMatches(c, query) {
  return c.title.toLowerCase().includes(query) || c.messages.some((m) => m.content.toLowerCase().includes(query));
}

export function renderChatList() {
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
    main.addEventListener('click', () => { openChat(c.id); closeSidebar(); });

    const btnRename = document.createElement('button');
    btnRename.className = 'chat-item-btn';
    btnRename.textContent = '\u270E'; // pencil
    btnRename.title = 'Rename';
    btnRename.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = prompt('Rename chat', c.title);
      if (t && t.trim()) renameChat(c.id, t);
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'chat-item-btn chat-item-del';
    btnDel.textContent = '\u2715'; // cross
    btnDel.title = 'Delete';
    btnDel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${c.title}"?`)) deleteChat(c.id);
    });

    item.append(main, btnRename, btnDel);
    chatListEl.appendChild(item);
  }
}

export function renderMemCount() {
  $('memCount').textContent = state.memory.length ? `(${state.memory.length})` : '';
}
