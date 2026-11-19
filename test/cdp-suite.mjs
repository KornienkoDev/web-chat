// Full CDP test suite for the modular web chat. Runs against mock-llm.js ONLY
// (default http://127.0.0.1:11435/v1): sending test chats to a real model evicts
// its KV cache and flushes the served conversation, so that is never allowed.
// The suite WIPES the server's memory file as its first step, so it refuses to
// run unless WC_TEST_MEM_FILE names the exact throwaway file the app under test
// was started with (test/run.sh does all of this correctly).
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MOCK_BASE = process.env.MOCK_BASE ?? 'http://127.0.0.1:11435/v1';
const MEM_FILE = process.env.WC_TEST_MEM_FILE;
if (!MEM_FILE) {
  console.error('WC_TEST_MEM_FILE is not set: this suite resets the memory file, so it must be ' +
    'told which throwaway file the app under test uses. Run it through test/run.sh.');
  process.exit(1);
}
try {
  await fetch(`${MOCK_BASE}/models`, { signal: AbortSignal.timeout(2000) });
} catch {
  console.error(`mock LLM not reachable at ${MOCK_BASE} — start it with "node mock-llm.js" or use test/run.sh`);
  process.exit(1);
}

const version = await (await fetch(`${process.env.CDP_URL ?? 'http://127.0.0.1:9222'}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; waiting.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function must(method, params, sessionId) {
  const r = await send(method, params, sessionId);
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
}
const { targetId } = await must('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await must('Target.attachToTarget', { targetId, flatten: true });
await must('Page.enable', {}, sessionId);
// Install an error collector on EVERY page load (survives navigations).
await must('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message)));`,
}, sessionId);
async function evalJs(expression, awaitPromise = false) {
  const r = await must('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('page JS error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function reload() { await must('Page.navigate', { url: process.env.APP_URL ?? "http://localhost:3000" }, sessionId); await sleep(900); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`); };

// Boot clean.
await reload();
await evalJs(`localStorage.clear()`);
// Pin the mock endpoint before any request can reach the default (real) one.
await evalJs(`Object.assign(__wc.state.settings, { baseUrl: ${JSON.stringify(MOCK_BASE)} }); __wc.saveSettings();`);
// The reset below wipes whatever memory file the app under test serves, so
// first make sure it is the throwaway run.sh started the server with. A
// mismatch means we are pointed at a live instance — abort before touching it.
const servedMem = await evalJs(`(async () => (await (await fetch('/api/memory')).json()).file)()`, true);
if (path.resolve(String(servedMem)) !== path.resolve(MEM_FILE)) {
  console.error(`refusing to run: the app at ${process.env.APP_URL ?? 'localhost:3000'} writes ` +
    `memories to ${servedMem}, not the throwaway ${MEM_FILE} — a live instance is in the way.`);
  ws.close();
  process.exit(1);
}
// Also reset the server-side memory file so runs start from a clean slate.
await evalJs(`fetch('/api/memory', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: '[]' })`, true);
await reload();
const consoleErrors = [];

// ---------- Section: boot & model discovery ----------
check('app boots (module graph loads)', await evalJs(`!!window.__wc && __wc.state.chats.size === 1`));
check('no page errors on boot', (await evalJs(`window.__errs.length`)) === 0);
await evalJs(`__wc.fetchModels()`);
const models = await evalJs(`__wc.state.models`);
check('model discovery', Array.isArray(models) && models.length >= 1, models.join(','));

// Tuning for speed/determinism.
await evalJs(`Object.assign(__wc.state.settings, {thinking:'off', maxTokens:'400'}); __wc.saveSettings();`);

// ---------- Section: Settings mock toggle ----------
// Mock pins the built-in URL and greys the field out; the saved URL must
// survive the toggle round-trip. The header must also never advertise a model
// the active upstream does not serve (a pref from the other side falls back).
await evalJs(`(async () => { Object.assign(__wc.state.settings, { model: 'not-served' });
  await __wc.fetchModels(); __wc.saveSettings(); })()`, true);
check('stale model pref falls back to a served one',
  await evalJs(`document.getElementById('modelLabel').textContent`) === 'mock-llm');
await evalJs(`document.getElementById('btnSettings').click()`);
check('mock toggle greys out the base URL field', await evalJs(`(() => {
  const box = document.getElementById('setMock');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  const url = document.getElementById('setBaseUrl');
  return url.disabled && url.value === 'http://127.0.0.1:11435/v1';
})()`));
await evalJs(`document.querySelector('#settingsForm [value="save"]').click()`);
check('mock toggle persists and keeps the real URL', await evalJs(
  `__wc.state.settings.mock === true && __wc.state.settings.baseUrl === ${JSON.stringify(MOCK_BASE)}`));
await evalJs(`document.getElementById('btnSettings').click()`);
const mockOff = await evalJs(`(() => {
  const box = document.getElementById('setMock');
  box.checked = false;
  box.dispatchEvent(new Event('change'));
  const url = document.getElementById('setBaseUrl');
  return !url.disabled && url.value === ${JSON.stringify(MOCK_BASE)};
})()`);
await evalJs(`document.querySelector('#settingsForm [value="save"]').click()`);
check('unchecking mock restores the URL field', mockOff);
await evalJs(`Object.assign(__wc.state.settings, { model: '' }); __wc.saveSettings();`);

// ---------- Section: real LLM round-trip + memory tool ----------
await evalJs(`__wc.sendMessage('A few things to note: my name is Marcin, I am vegetarian, and my dog Pixel is 3 years old.')`, true);
const lastMsg = await evalJs(`__wc.activeChat().messages.at(-1)`);
const mem = await evalJs(`__wc.state.memory`);
const joined = mem.map((m) => m.text).join(' | ').toLowerCase();
check('real LLM replied', lastMsg.role === 'assistant' && lastMsg.content.length > 0);
check('model saved facts by itself', mem.length >= 2 && mem.every((m) => m.source === 'tool'),
  `${mem.length} facts`);
check('facts cover name/diet/dog', /marcin/.test(joined) && /vegetarian/.test(joined) && /pixel/.test(joined));
check('savedFacts badge on message', Array.isArray(lastMsg.savedFacts) && lastMsg.savedFacts.length >= 2);
check('memory tool use shown on timeline',
  Array.isArray(lastMsg.timeline)
  && lastMsg.timeline.filter((s) => s.kind === 'tool' && s.family === 'memory' && s.action === 'save').length >= 2,
  JSON.stringify((lastMsg.timeline || []).map((s) => s.kind + (s.action ? '/' + s.action : ''))));
check('memory persisted', await evalJs(`JSON.parse(localStorage.getItem('wc.memory')||'[]').length >= 2`));
await sleep(500); // let the debounced memory-file write (250ms) land before reading it back
const memFile = await evalJs(`(async () => (await fetch('/api/memory')).json())()`, true);
check('memory written to server file', Array.isArray(memFile.memory) && memFile.memory.length >= 2,
  `${memFile.memory?.length ?? '?'} facts in ${memFile.file || '?'}`);

// Recall via injected memory.
await evalJs(`__wc.sendMessage('What is my dog called? One word.')`, true);
check('memory injected into next turn', /pixel/i.test(await evalJs(`__wc.activeChat().messages.at(-1).content`)));

// forget_memory tool: the model drops an outdated fact the user names.
await evalJs(`__wc.sendMessage('I am not vegetarian anymore, please forget that i am vegetarian')`, true);
const forgetOut = await evalJs(`__wc.activeChat().messages.at(-1).content`);
const vegLeft = await evalJs(`__wc.state.memory.filter(m=>/vegetarian/i.test(m.text)).length`);
check('forget_memory tool round-trip', vegLeft === 0 && /Forgot/i.test(forgetOut), forgetOut.slice(0, 100));
const forgetTl = await evalJs(`__wc.activeChat().messages.at(-1).timeline || []`);
check('forget_memory shown on timeline',
  forgetTl.some((s) => s.kind === 'tool' && s.family === 'memory' && s.action === 'forget'),
  JSON.stringify(forgetTl.map((s) => s.action || s.kind)));
const memPills = await evalJs(`[...document.querySelectorAll('.msg-process .msg-tool')].map((p) => p.textContent).join(' | ')`);
check('memory tool pills rendered in chat', /memory · save/.test(memPills) && /memory · forget/.test(memPills), memPills.slice(0, 120));

// Trivia must not be saved.
const before = await evalJs(`__wc.state.memory.length`);
await evalJs(`__wc.sendMessage('haha lol ok whatever')`, true);
check('chit-chat ignored', (await evalJs(`__wc.state.memory.length`)) === before);

// ---------- Section: persistence across reload ----------
await reload();
check('chats restored after reload', await evalJs(`__wc.state.chats.size`) >= 1);
const msgs = await evalJs(`__wc.activeChat().messages.map(m=>m.role).join(',')`);
check('messages restored (incl. savedFacts msg)', /assistant/.test(msgs) &&
  await evalJs(`__wc.activeChat().messages.some(m=>m.savedFacts)`));
check('memory restored after reload', (await evalJs(`__wc.state.memory.length`)) >= 2);

// Second chat + open older + delete.
await evalJs(`__wc.newChat()`);
// Empty new chat: ChatGPT-style centred composer that grows around its middle.
const centred = await evalJs(`(() => {
  const main = document.querySelector('.main');
  const r = main.getBoundingClientRect();
  const box = document.querySelector('.composer').getBoundingClientRect();
  const mid = (box.top + box.bottom) / 2;
  const h0 = __wc.input.style.height || __wc.input.getBoundingClientRect().height;
  __wc.input.value = 'a\\nb\\nc\\nd\\ne';
  __wc.input.dispatchEvent(new Event('input'));
  const h1 = parseFloat(__wc.input.style.height);
  __wc.input.value = '';
  __wc.input.dispatchEvent(new Event('input'));
  return { empty: main.classList.contains('empty'),
           offCentre: +(Math.abs(mid - (r.top + r.bottom) / 2)).toFixed(1),
           grew: h1 > parseFloat(h0) };
})()`);
check('empty chat: composer centred and grows', centred.empty && centred.offCentre < 4 && centred.grew, JSON.stringify(centred));
await evalJs(`__wc.sendMessage('second chat probe')`, true);
check('first message docks composer to bottom', await evalJs(`(() => {
  const main = document.querySelector('.main');
  const box = document.querySelector('.composer').getBoundingClientRect();
  return !main.classList.contains('empty') && Math.abs(box.bottom - innerHeight) < 2;
})()`));
// No control column beside the field: the send key sits inside it, and the
// textarea shows no scrollbar (its height fits the text exactly).
const field = await evalJs(`(async () => {
  const i = document.querySelector('#input');
  const r = i.getBoundingClientRect();
  const b = document.querySelector('#btnSend').getBoundingClientRect();
  i.value = Array(6).fill('a line').join('\\n');
  i.dispatchEvent(new Event('input'));
  await new Promise((res) => setTimeout(res, 250)); // let the height transition settle
  const fits = i.scrollHeight <= i.clientHeight + 1;
  i.value = ''; i.dispatchEvent(new Event('input'));
  return { inside: b.left > r.left && b.right <= r.right && b.bottom <= r.bottom,
           noBar: getComputedStyle(i).scrollbarWidth === 'none', fits };
})()`, true);
check('send key inside the field, scrollbar gone', field.inside && field.noBar && field.fits, JSON.stringify(field));
await reload();
check('two chats persisted', await evalJs(`__wc.state.chats.size`) === 2);
const olderId = await evalJs(`[...__wc.state.chats.values()].sort((a,b)=>a.updatedAt-b.updatedAt)[0].id`);
await evalJs(`__wc.openChat(${JSON.stringify(olderId)})`);
check('open older chat', (await evalJs(`__wc.activeChat().messages[0].content`)).includes('Marcin'));
await evalJs(`for (const id of [...__wc.state.chats.keys()].filter(i=>i!==__wc.state.activeId)) __wc.state.chats.delete(id)`);
await evalJs(`window.__wc.state.activeId`); // touch
await reload();
check('deletions persist', (await evalJs(`__wc.state.chats.size`)) <= 2);

// ---------- Section: stop + error handling ----------
await evalJs(`__wc.state.settings.maxTokens='2000';`);
await evalJs(`__wc.sendMessage('Count from 1 to 500, one number per line.'); true`);
await sleep(4000);
await evalJs(`__wc.stopStreaming()`);
await sleep(500);
const stopped = await evalJs(`({streaming: __wc.state.streaming, role: __wc.activeChat().messages.at(-1).role, len: (__wc.activeChat().messages.at(-1).content||'').length})`);
check('stop halts generation, keeps partial text', stopped.streaming === false && stopped.role === 'assistant' && stopped.len > 0, JSON.stringify(stopped));

await evalJs(`__wc.state.settings.baseUrl='http://127.0.0.1:9/x';`);
await evalJs(`__wc.sendMessage('hi')`, true);
const errRole = await evalJs(`__wc.activeChat().messages.at(-1).role`);
check('connection error surfaced inline', errRole === 'error');

// Manual memory button + duplicate rejection.
await evalJs(`__wc.state.settings.baseUrl=${JSON.stringify(MOCK_BASE)};`);
const m0 = await evalJs(`__wc.state.memory.length`);
await evalJs(`document.querySelector('.msg.user .msg-meta .msg-action:last-child').click()`);
check('manual save button works', (await evalJs(`__wc.state.memory.length`)) === m0 + 1);
check('duplicate rejected', !(await evalJs(`__wc.addMemory('The user\\'s name is Marcin','manual')`)));

// ---------- Section: markdown rendering ----------
await evalJs(`__wc.sendMessage('Reply with a markdown list of 3 fruits and a python code block that prints hi. No preamble.')`, true);
const md = await evalJs(`(() => {
  const el = [...document.querySelectorAll('.msg.assistant')].pop();
  return { li: el.querySelectorAll('ul li').length, pre: !!el.querySelector('pre code'), copy: !!el.querySelector('.code-copy') };
})()`);
check('markdown: list + code block + copy button', md.li >= 3 && md.pre && md.copy, JSON.stringify(md));

// ---------- Section: MCP tools (via test/mock-mcp-server.js) ----------
// Boot discovery is async and a server may still be starting; poll a bit.
for (let t = 0; t < 60 && !(await evalJs(`__wc.state.mcpTools.length`)); t++) await sleep(250);
const mcpNames = await evalJs(`__wc.state.mcpTools.map(t=>t.function.name).join(',')`);
check('mcp tools discovered', /__search$/.test(mcpNames), mcpNames);
await evalJs(`__wc.sendMessage('Please search for the meaning of life')`, true);
const searchReply = await evalJs(`__wc.activeChat().messages.at(-1).content`);
check('mcp tool call round-trip', /Mockresult Alpha/i.test(searchReply) && /42/.test(searchReply),
  searchReply.slice(0, 90));

// The tool use must be visible in the chat: a "tool" step on the reply's
// timeline (server · tool) plus its query, drawn as a pill in the process strip.
const searchMsg = await evalJs(`__wc.activeChat().messages.at(-1)`);
const searchTools = (searchMsg.timeline || []).filter((s) => s.kind === 'tool');
check('mcp usage recorded on timeline',
  searchTools.some((t) => t.family === 'mcp' && /__search$/.test(t.name) && t.status === 'ok'),
  JSON.stringify(searchMsg.timeline));
check('mcp query captured on timeline',
  searchTools.some((t) => /meaning of life/i.test(t.arg || '')),
  searchTools.map((t) => t.arg).join(' | '));
const badge = await evalJs(`(() => {
  const pills = [...document.querySelectorAll('.msg-process .msg-tool')];
  return { n: pills.length, text: pills.map((p) => p.textContent).join(' | ') };
})()`);
check('mcp usage pill rendered in chat',
  badge.n >= 1 && /searchtest/.test(badge.text) && /search/i.test(badge.text), JSON.stringify(badge));

// Regression: reasoning streamed after a tool call must open a FRESH think
// block, not merge into the earlier one — thinking and tools stay interleaved
// on the timeline (the bug was one growing "Thinking" blob).
await evalJs(`Object.assign(__wc.state.settings, {thinking:'on'}); __wc.saveSettings();`, true);
await evalJs(`__wc.sendMessage('Please search for cumulus clouds')`, true);
await evalJs(`Object.assign(__wc.state.settings, {thinking:'off'}); __wc.saveSettings();`, true);
const inter = await evalJs(`(() => {
  const t = __wc.activeChat().messages.at(-1).timeline || [];
  return {
    kinds: t.map((s) => s.kind + (s.family ? ':' + s.family + (s.action ? '/' + s.action : '') : '')),
    thinkAfterTool: t.some((s, i) => s.kind === 'think' && i > 0 && t[i - 1].kind === 'tool'),
  };
})()`);
check('thinking opens a fresh block after a tool call',
  inter.kinds.some((k) => k.startsWith('tool:mcp')) && inter.thinkAfterTool,
  JSON.stringify(inter.kinds));

// Disabling via settings: server honors it, the model no longer sees the tool.
const mcpOff = await evalJs(`(async () => {
  const d = await (await fetch('/api/mcp/tools?disabled=searchtest')).json();
  return { tools: d.tools.length, off: d.servers.some(s => s.name === 'searchtest' && s.status === 'disabled') };
})()`, true);
check('mcp disable honored by /api/mcp/tools', mcpOff.tools === 0 && mcpOff.off, JSON.stringify(mcpOff));
await evalJs(`(async () => { __wc.state.settings.mcpDisabled='searchtest'; __wc.saveSettings();
  await __wc.fetchMcpTools(); })()`, true);
await evalJs(`__wc.sendMessage('Please search for something random')`, true);
check('disabled mcp tool not offered to model',
  /Mock echo/i.test(await evalJs(`__wc.activeChat().messages.at(-1).content`)));
await evalJs(`(async () => { __wc.state.settings.mcpDisabled=''; __wc.saveSettings();
  await __wc.fetchMcpTools(); })()`, true);
check('mcp re-enabled', (await evalJs(`__wc.state.mcpTools.length`)) >= 1);

// ---------- Section: regenerate ----------
const beforeLen = await evalJs(`__wc.activeChat().messages.length`);
await evalJs(`document.querySelector('.msg-regen').click(); true`);
async function waitIdle(maxMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    if (!(await evalJs(`__wc.state.streaming`))) return true;
    if (Date.now() - t0 > maxMs) return false;
    await sleep(500);
  }
}
check('regenerate completes', await waitIdle());
const afterLen = await evalJs(`__wc.activeChat().messages.length`);
const roles = await evalJs(`__wc.activeChat().messages.slice(-2).map(m=>m.role).join(',')`);
check('regenerate keeps one reply', afterLen === beforeLen && roles === 'user,assistant', `${afterLen} ${roles}`);

// ---------- Section: import / export ----------
const io = await evalJs(`(async () => {
  const data = { app: 'web_chat', version: 1,
    chats: [{ id: 'imp-1', title: 'Imported chat', createdAt: 1, updatedAt: 1,
              messages: [{ role: 'user', content: 'imported hello' }, { role: 'assistant', content: 'hi' }] }],
    memory: [{ text: 'User plays chess', source: 'manual' }] };
  const before = __wc.state.chats.size;
  await __wc.importData(new File([JSON.stringify(data)], 'b.json', { type: 'application/json' }));
  const c = __wc.state.chats.get('imp-1');
  return { added: __wc.state.chats.size - before, ok: !!c && c.messages.length === 2,
           mem: __wc.state.memory.some(m => /chess/i.test(m.text)) };
})()`, true);
check('import adds chat + memories', io.added === 1 && io.ok && io.mem, JSON.stringify(io));

check('no page errors during run', (await evalJs(`(window.__errs||[]).length`)) === 0,
  await evalJs(`(window.__errs||[]).join(';')`));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail ? 1 : 0);
