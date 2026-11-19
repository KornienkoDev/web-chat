'use strict';
// Minimal zero-dependency MCP (Model Context Protocol) client. Spawns the
// stdio servers listed in mcp.json (override the path with WC_MCP_CONFIG),
// speaks line-delimited JSON-RPC 2.0, and hands their tools to the browser in
// OpenAI function-call shape. A server starts lazily on first use and stays
// warm until the app exits; failures are isolated per server.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = process.env.WC_MCP_CONFIG
  ? path.resolve(process.env.WC_MCP_CONFIG)
  : path.join(__dirname, 'mcp.json');

const INIT_TIMEOUT_MS = 180000; // a first uvx run may download the package
const CALL_TIMEOUT_MS = 90000;
const FAIL_COOLDOWN_MS = 30000; // don't respawn a just-failed server every request
const RESULT_MAX = 20000;       // cap tool output so one page can't eat the context

const servers = new Map(); // config name -> live server record

function config() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[mcp] cannot read ${CONFIG_FILE}: ${e.message}`);
    return {};
  }
  try {
    const cfg = JSON.parse(raw);
    return cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  } catch (e) {
    console.warn(`[mcp] ${CONFIG_FILE} is not valid JSON: ${e.message}`);
    return {};
  }
}

function getServer(name) {
  const existing = servers.get(name);
  if (existing) return existing;
  const c = config()[name];
  if (!c || typeof c.command !== 'string') return null;
  const srv = {
    name,
    cmd: c.command,
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    env: c.env && typeof c.env === 'object' ? c.env : {},
    proc: null,
    ready: null, // shared handshake promise
    pending: new Map(), // rpc id -> {resolve, reject}
    nextId: 1,
    line: '', // stdout fragment between newlines
    tools: null, // [{name, tool, description, parameters}] once listed
    lastFail: 0,
  };
  servers.set(name, srv);
  return srv;
}

// Exposed tool name must satisfy ^[a-zA-Z0-9_-]{1,64}$ for OpenAI-style calls.
const exposedName = (srvName, toolName) =>
  `${srvName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

function rejectPending(srv, why) {
  for (const { reject } of srv.pending.values()) reject(new Error(why));
  srv.pending.clear();
}

function rpc(srv, method, params, ms) {
  return new Promise((resolve, reject) => {
    const id = srv.nextId++;
    const timer = setTimeout(() => {
      srv.pending.delete(id);
      reject(new Error(`timeout waiting for ${method} from ${srv.name}`));
    }, ms);
    const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
    srv.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    try {
      srv.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    } catch (e) {
      srv.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function notify(srv, method, params) {
  try {
    srv.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n');
  } catch { /* the close/error handler reports the real failure */ }
}

function ensureReady(srv) {
  if (srv.ready) return srv.ready;
  const start = (async () => {
    if (srv.lastFail && Date.now() - srv.lastFail < FAIL_COOLDOWN_MS) {
      throw new Error(`${srv.name} failed to start recently, retrying in a moment`);
    }
    // detached: the child becomes a process-group leader, so uvx and the
    // Python interpreter it execs die together with one kill(-pid) signal.
    const proc = spawn(srv.cmd, srv.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...srv.env },
      detached: true,
    });
    srv.proc = proc;
    proc.on('error', (e) => { // spawn itself failed (command not found, ...)
      srv.lastFail = Date.now();
      if (srv.proc === proc) { srv.proc = null; srv.ready = null; srv.tools = null; }
      rejectPending(srv, `${srv.name}: ${e.message}`);
    });
    proc.on('close', () => {
      if (srv.proc === proc) {
        rejectPending(srv, `MCP server ${srv.name} exited`);
        srv.proc = null; srv.ready = null; srv.tools = null;
      }
    });
    proc.stderr.on('data', (c) => console.error(`[mcp:${srv.name}]`, String(c).trimEnd()));
    proc.stdout.on('data', (c) => {
      srv.line += c;
      let nl;
      while ((nl = srv.line.indexOf('\n')) >= 0) {
        const text = srv.line.slice(0, nl).trim();
        srv.line = srv.line.slice(nl + 1);
        if (!text) continue;
        let msg;
        try { msg = JSON.parse(text); } catch { continue; } // tolerate stray log lines
        if (msg.id && srv.pending.has(msg.id)) {
          const { resolve, reject } = srv.pending.get(msg.id);
          srv.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${srv.name}: ${msg.error.message || 'JSON-RPC error'}`));
          else resolve(msg.result);
        }
      }
    });
    const init = await rpc(srv, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'webchat', version: '1.0' },
    }, INIT_TIMEOUT_MS);
    notify(srv, 'notifications/initialized');
    const listed = await rpc(srv, 'tools/list', {}, CALL_TIMEOUT_MS);
    srv.tools = (Array.isArray(listed?.tools) ? listed.tools : [])
      .filter((t) => t && typeof t.name === 'string')
      .map((t) => ({
        name: exposedName(srv.name, t.name),
        tool: t.name, // name inside the server, used for tools/call
        description: String(t.description || ''),
        parameters: t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {} },
      }));
    console.log(`[mcp] ${srv.name} ready: ${srv.tools.length} tool(s)${init?.serverInfo?.name ? ` (${init.serverInfo.name})` : ''}`);
    return srv;
  })().catch((e) => {
    srv.lastFail = Date.now();
    if (srv.proc) {
      try { process.kill(-srv.proc.pid, 'SIGKILL'); } catch { srv.proc.kill('SIGKILL'); }
    }
    srv.proc = null; srv.ready = null; srv.tools = null;
    throw e;
  });
  srv.ready = start;
  return start;
}

// -> { tools, servers, errors }
// `disabledNames` (from the browser's settings) are reported without spawning,
// so disabling a server also saves its cold-start cost. `servers` feeds the
// Settings dialog (one checkbox row per server); `tools` is the ready-to-send
// OpenAI function-call shape.
async function listTools(disabledNames = []) {
  const disabled = new Set(disabledNames.filter((n) => typeof n === 'string' && n));
  const srvs = Object.keys(config()).map(getServer).filter(Boolean);
  const results = await Promise.all(srvs.map(async (s) => {
    if (disabled.has(s.name)) return { name: s.name, status: 'disabled', tools: [] };
    try {
      await ensureReady(s);
      return {
        name: s.name,
        status: 'ready',
        tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
      };
    } catch (e) {
      return { name: s.name, status: 'error', tools: [], error: e.message || String(e) };
    }
  }));
  const tools = [];
  const errors = {};
  for (const r of results) {
    if (r.status !== 'ready') {
      if (r.status === 'error') errors[r.name] = r.error;
      continue;
    }
    for (const t of srvs.find((s) => s.name === r.name).tools) {
      tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } });
    }
  }
  return { tools, servers: results, errors };
}

// Runs one tool by its exposed name; returns the text content.
async function callTool(exposed, args) {
  const srvs = Object.keys(config()).map(getServer).filter(Boolean);
  if (!srvs.length) throw new Error('no MCP servers configured');
  await Promise.all(srvs.map((s) => ensureReady(s).catch(() => null)));
  const srv = srvs.find((s) => s.tools?.some((t) => t.name === exposed));
  if (!srv) throw new Error(`unknown tool: ${exposed}`);
  const tool = srv.tools.find((t) => t.name === exposed);
  const result = await rpc(srv, 'tools/call', {
    name: tool.tool,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
  }, CALL_TIMEOUT_MS);
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
  if (result?.isError) throw new Error(text.slice(0, 500) || 'tool reported an error');
  const out = text || '[tool returned no text content]';
  return out.length > RESULT_MAX ? out.slice(0, RESULT_MAX) + '\n[truncated]' : out;
}

function shutdown() {
  for (const srv of servers.values()) {
    if (!srv.proc) continue;
    try { srv.proc.stdin.end(); } catch { /* already gone */ }
    try { process.kill(-srv.proc.pid, 'SIGTERM'); }
    catch { try { srv.proc.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

module.exports = { listTools, callTool, shutdown, CONFIG_FILE };
