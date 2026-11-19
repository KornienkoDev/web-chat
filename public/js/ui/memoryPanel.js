// Memory panel dialog: browse, add, forget, extract-from-chat.
import { state } from '../state.js';
import { saveSettings } from '../storage.js';
import { activeChat } from '../chats.js';
import { addMemory, deleteMemory, clearMemory, extractFacts } from '../memory.js';
import { on } from '../events.js';
import { $ } from './dom.js';

export function initMemoryPanel() {
  const dialog = $('memoryDialog');

  $('btnMemory').addEventListener('click', () => { renderMemory(); dialog.showModal(); });
  $('btnMemClose').addEventListener('click', () => dialog.close());
  $('btnMemAdd').addEventListener('click', () => {
    const inp = $('memInput');
    if (addMemory(inp.value, 'manual')) inp.value = '';
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
    if (state.memory.length && confirm('Forget all saved memories?')) clearMemory();
  });

  on('memory:changed', renderMemory);
}

function renderMemory() {
  $('memCountTitle').textContent = state.memory.length ? `${state.memory.length} saved` : '';
  $('memAuto').checked = !!state.settings.autoExtract;

  const list = $('memList');
  list.innerHTML = '';
  if (!state.memory.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No memories yet. The model saves important facts about you automatically.';
    list.appendChild(empty);
    return;
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
