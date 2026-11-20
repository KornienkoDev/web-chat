// Settings dialog: read/write settings through storage.js.
import { state, MOCK_BASE_URL } from '../state.js';
import { loadSettings, saveSettings } from '../storage.js';
import { fetchModels, fetchMcpTools } from '../llm.js';
import { renderModelLabel } from './header.js';
import { $ } from './dom.js';

export function initSettings() {
  const dialog = $('settingsDialog');
  const form = $('settingsForm');
  const msg = $('settingsMsg');
  const mcpDetails = $('setMcpDetails');

  $('btnSettings').addEventListener('click', () => {
    fillForm();
    msg.textContent = '';
    // MCP rows are (re)loaded lazily each time the dialog opens.
    mcpDetails.open = false;
    $('mcpList').innerHTML = '<span class="muted">Open to load…</span>';
    dialog.showModal();
    fetchModels().then(fillModelList);
  });

  mcpDetails.addEventListener('toggle', () => {
    if (mcpDetails.open) loadMcpList();
  });

  // Mock swaps the upstream, so re-discover models right away: the header
  // label and the datalist follow the active server. Closing without saving
  // resets the settings and the 'close' handler below fetches again.
  $('setMock').addEventListener('change', () => {
    applyMockToggle();
    state.settings.mock = $('setMock').checked;
    fetchModels().then(fillModelList);
  });

  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    Object.assign(state.settings, readForm());
    saveSettings();
    renderModelLabel();
    // Apply checked/unchecked MCP servers to the next turn right away.
    fetchMcpTools();
  });

  // Storage is the source of truth: after closing, reset any unsaved edits.
  dialog.addEventListener('close', () => {
    loadSettings();
    renderModelLabel();
    // A toggled-then-cancelled mock may have swapped state.models to the other
    // upstream's list; rediscover so the label matches the restored settings.
    fetchModels();
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
  // With the MCP list never opened there are no checkboxes to read, so keep
  // the saved value instead of silently re-enabling everything.
  const mcpBoxes = [...$('mcpList').querySelectorAll('input[type=checkbox]')];
  return {
    // While mock is on the field displays the mock URL for information only —
    // parkedUrl holds the real (possibly freshly typed) URL so saving does
    // not overwrite it and unchecking restores it.
    baseUrl: $('setMock').checked ? parkedUrl : $('setBaseUrl').value.trim(),
    apiKey: $('setApiKey').value.trim(),
    model: $('setModel').value.trim(),
    temperature: $('setTemp').value.trim(),
    maxTokens: $('setMaxTokens').value.trim(),
    contextMessages: $('setContext').value.trim(),
    maxToolRounds: $('setMaxToolRounds').value.trim(),
    system: $('setSystem').value,
    thinking: $('setThinking').value,
    promptCache: $('setPromptCache').checked,
    attachTextChars: $('setAttachTextChars').value.trim(),
    attachImageSide: $('setAttachImageSide').value.trim(),
    attachImageMb: $('setAttachImageMb').value.trim(),
    mock: $('setMock').checked,
    mcpDisabled: mcpBoxes.length
      ? mcpBoxes.filter((b) => !b.checked).map((b) => b.value).join(',')
      : state.settings.mcpDisabled,
  };
}

// Parked base URL while the mock toggle greys the field out.
let parkedUrl = '';

// Grey out the API URL field and show the well-known mock endpoint in its
// place; unchecking restores the real URL (unsaved edits included).
function applyMockToggle() {
  const url = $('setBaseUrl');
  if ($('setMock').checked) {
    // Capture only a field that still holds the real URL; re-entrance (or a
    // dialog left disabled by a previous session) must not park the mock URL.
    if (url.value !== MOCK_BASE_URL) parkedUrl = url.value;
    url.value = MOCK_BASE_URL;
    url.disabled = true;
  } else {
    url.value = parkedUrl;
    url.disabled = false;
  }
}

function fillForm() {
  const s = state.settings;
  $('setBaseUrl').value = s.baseUrl;
  $('setMock').checked = !!s.mock;
  parkedUrl = s.baseUrl;
  applyMockToggle();
  $('setApiKey').value = s.apiKey;
  $('setModel').value = s.model;
  $('setTemp').value = s.temperature;
  $('setMaxTokens').value = s.maxTokens;
  $('setContext').value = s.contextMessages;
  $('setMaxToolRounds').value = s.maxToolRounds;
  $('setSystem').value = s.system;
  $('setThinking').value = s.thinking;
  $('setPromptCache').checked = s.promptCache !== false;
  $('setAttachTextChars').value = s.attachTextChars;
  $('setAttachImageSide').value = s.attachImageSide;
  $('setAttachImageMb').value = s.attachImageMb;
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

// ---------- MCP rows: one checkbox per configured server ----------
async function loadMcpList() {
  const list = $('mcpList');
  list.innerHTML = '<span class="muted">Loading…</span>';
  const servers = await fetchMcpTools();
  renderMcpList(servers);
}

function renderMcpList(servers) {
  const list = $('mcpList');
  list.innerHTML = '';
  if (!servers.length) {
    list.innerHTML = '<span class="muted">No MCP servers configured (see mcp.json).</span>';
    return;
  }
  for (const s of servers) {
    const row = document.createElement('label');
    row.className = 'mcp-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = s.name;
    box.checked = s.status !== 'disabled';
    box.title = 'Uncheck to stop offering this server\'s tools to the model';
    const name = document.createElement('span');
    name.className = 'mcp-name';
    name.textContent = s.name;
    const info = document.createElement('span');
    info.className = 'muted mcp-info';
    if (s.status === 'ready') info.textContent = `${s.tools.length} tool(s): ${s.tools.map((t) => t.name.replace(`${s.name}__`, '')).join(', ')}`;
    else if (s.status === 'error') info.textContent = `failed: ${s.error}`;
    else info.textContent = 'disabled';
    box.addEventListener('change', () => {
      info.textContent = box.checked
        ? (s.status === 'ready' ? `${s.tools.length} tool(s): ${s.tools.map((t) => t.name.replace(`${s.name}__`, '')).join(', ')}` : 'not probed')
        : 'disabled';
    });
    row.append(box, name, info);
    list.appendChild(row);
  }
}
