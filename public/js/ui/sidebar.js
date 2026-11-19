// Sidebar: mobile drawer, chat list (open/rename/delete/search), memory count.
import { state } from '../state.js';
import { openChat, renameChat, deleteChat, newChat } from '../chats.js';
import { on } from '../events.js';
import { $ } from './dom.js';
import { confirmDialog } from './modal.js';
import { focusInput } from './composer.js';

let sidebarEl, backdropEl, chatListEl, chatSearchEl;
let renaming = null; // { cancel() } for the row whose title is being edited

export function initSidebar() {
  sidebarEl = $('sidebar');
  backdropEl = $('backdrop');
  chatListEl = $('chatList');
  chatSearchEl = $('chatSearch');

  $('btnMenu').addEventListener('click', openSidebar);
  backdropEl.addEventListener('click', closeSidebar);
  $('btnNewChat').addEventListener('click', () => {
    newChat();
    closeSidebar();
    // The new chat should be ready to type into right away.
    focusInput();
  });
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

  // The list is about to be rebuilt, which would drop an open inline editor and
  // its listeners without a blur — close it first so no stale state is left.
  if (renaming) renaming.cancel();

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
    btnRename.className = 'chat-item-btn ic ic-pencil';
    btnRename.title = 'Rename';
    btnRename.setAttribute('aria-label', `Rename “${c.title || 'Untitled'}”`);
    btnRename.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(item, c);
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'chat-item-btn chat-item-del ic ic-close';
    btnDel.title = 'Delete';
    btnDel.setAttribute('aria-label', `Delete “${c.title || 'Untitled'}”`);
    btnDel.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: 'Delete this chat?',
        message: `“${c.title || 'Untitled'}” and its ${c.messages.length} message${c.messages.length === 1 ? '' : 's'} will be gone for good.`,
        confirmLabel: 'Delete',
      });
      if (ok) deleteChat(c.id);
    });

    item.append(main, btnRename, btnDel);
    chatListEl.appendChild(item);
  }
}

// Rename in place: the title is swapped for an input holding the current name,
// so the user never leaves the list for a browser prompt. Enter or a click away
// commits, Escape reverts, an empty name keeps the old one.
function startRename(item, chat) {
  if (renaming) renaming.cancel(); // a second pencil moves the editor to this row
  const main = item.querySelector('.chat-item-main');
  const titleEl = main.querySelector('.chat-item-title');
  const previous = chat.title || '';

  const input = document.createElement('input');
  input.className = 'chat-item-input';
  input.value = previous;
  input.maxLength = 80; // matches the cap in chats.js renameChat
  input.setAttribute('aria-label', 'Chat name');

  let finished = false;
  function finish(commit) {
    if (finished) return; // Enter blurs the input, so blur must not commit twice
    finished = true;
    renaming = null;
    item.classList.remove('editing');
    const value = input.value.trim();
    const next = commit && value ? value : previous; // an empty or cancelled edit reverts
    input.remove();
    titleEl.hidden = false;
    titleEl.textContent = next || 'Untitled';
    if (next && next !== previous) renameChat(chat.id, next);
  }

  // The row's click handler opens the chat (and shuts the drawer on phones);
  // typing here must not trigger it.
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));

  item.classList.add('editing');
  titleEl.hidden = true;
  main.prepend(input);
  input.focus();
  input.select();
  renaming = { cancel: () => finish(false) };
}

export function renderMemCount() {
  const n = state.memory.length;
  const badge = $('memCount');
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n; // the button is icon-only now, so the count rides on top of it
}
