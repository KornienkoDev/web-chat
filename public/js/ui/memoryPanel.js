// Memory panel dialog: browse, add, forget, extract-from-chat, save-to-file.
import { state } from '../state.js';
import { saveSettings, saveMemoryNow } from '../storage.js';
import { downloadMemories } from '../io.js';
import { activeChat } from '../chats.js';
import { addMemory, deleteMemory, clearMemory, extractFacts } from '../memory.js';
import { on, emit } from '../events.js';
import { $ } from './dom.js';
import { confirmDialog } from './modal.js';

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
  $('btnMemClear').addEventListener('click', async () => {
    const n = state.memory.length;
    if (!n) return;
    const ok = await confirmDialog({
      title: 'Forget all memories?',
      message: `All ${n} saved ${n === 1 ? 'fact is' : 'facts are'} dropped from the model's context and from the saved file. This cannot be undone.`,
      confirmLabel: 'Forget all',
    });
    if (ok) clearMemory();
  });
  $('btnMemSave').addEventListener('click', async () => {
    const btn = $('btnMemSave');
    const status = $('memStatus');
    btn.disabled = true;
    status.hidden = false;
    status.textContent = 'Saving…';
    try {
      const { saved, error, count, file } = await saveMemoryNow();
      const label = `${count} ${count === 1 ? 'memory' : 'memories'}`;
      if (saved) {
        status.textContent = file ? `Saved ${label} to ${file}.` : `Saved ${label}.`;
        emit('toast', `Saved ${label} to file`);
      } else {
        // Server file not writable (server not running?): land the browser
        // copy on disk as a real file via download instead of losing it.
        downloadMemories();
        const target = state.memoryFile || 'memories.json';
        status.textContent = `Server file not available (${error || 'unknown error'}) — downloaded ${label} as memories.json instead. To restore: replace ${target} with that file and reload the app.`;
      }
    } finally {
      btn.disabled = false;
      renderMemory();
    }
  });

  on('memory:changed', renderMemory);
}

function renderMemory() {
  $('memCountTitle').textContent = state.memory.length ? `${state.memory.length} saved` : '';
  $('memAuto').checked = !!state.settings.autoExtract;
  const fileEl = $('memFile');
  fileEl.hidden = !state.memoryFile;
  fileEl.textContent = state.memoryFile ? `Saved to ${state.memoryFile}` : '';

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
    const date = document.createElement('span');
    date.className = 'muted mem-date';
    date.textContent = new Date(m.createdAt).toLocaleDateString();
    date.title = `Learned ${new Date(m.createdAt).toLocaleString()}`;
    // Right-hand column: learned date above the source tag.
    const meta = document.createElement('span');
    meta.className = 'mem-meta';
    meta.append(date, tag);
    const del = document.createElement('button');
    del.className = 'chat-item-btn chat-item-del ic ic-close';
    del.title = 'Forget';
    del.setAttribute('aria-label', 'Forget this memory');
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Forget this memory?',
        message: m.text,
        confirmLabel: 'Forget',
      });
      if (ok) deleteMemory(m.id); // by id: this row is re-rendered while asking
    });
    item.append(text, meta, del);
    list.appendChild(item);
  }
}
