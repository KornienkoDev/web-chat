'use strict';
// Local web chat server: serves the static frontend and proxies requests to a
// local LLM server (OpenAI-compatible). The proxy exists so the browser can
// reach the LLM without CORS issues; only local endpoints are allowed.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Memories are stored in a plain JSON file outside browser storage so they
// survive clearing site data and can be inspected, edited or backed up by hand.
// Override the location with WC_MEMORY_FILE.
const MEMORY_FILE = process.env.WC_MEMORY_FILE
  ? path.resolve(process.env.WC_MEMORY_FILE)
  : path.join(__dirname, 'memories.json');
const MEMORY_MAX_BYTES = 1024 * 1024; // 1 MiB is plenty for a few hundred facts
const MEMORY_MAX_ITEMS = 500;
const MEMORY_SOURCES = new Set(['manual', 'auto', 'tool']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, rel);

  // Prevent path traversal outside the public directory.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleApiChat(req, res);
  if (req.method === 'GET' && url.pathname === '/api/models') return handleApiModels(req, res);
  if (url.pathname === '/api/memory') {
    if (req.method === 'GET') return handleGetMemory(req, res);
    if (req.method === 'PUT' || req.method === 'POST') return handlePutMemory(req, res);
    return send(res, 405, 'Method not allowed');
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
});

// ---------- LLM proxy ----------
// By default only loopback targets are proxied. Set WC_ALLOW_LAN=1 to also
// allow private LAN ranges (useful if the LLM runs on another box at home).
const ALLOW_LAN = process.env.WC_ALLOW_LAN === '1';

function parseAllowedUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return u;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return u;
    if (ALLOW_LAN && (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))) return u;
  }
  return null;
}

// Accepts either a base URL ("http://host:port", ".../v1") or the full
// completions path, and returns the URL to POST chat requests to.
function completionsUrl(u) {
  const nu = new URL(u.href);
  let p = nu.pathname.replace(/\/+$/, '');
  if (!/chat\/completions$/.test(p)) {
    p = /\/v\d+$/.test(p) ? p + '/chat/completions' : p + '/v1/chat/completions';
  }
  nu.pathname = p;
  nu.search = '';
  nu.hash = '';
  return nu;
}

function modelsUrl(u) {
  const nu = new URL(u.href);
  let p = nu.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/\/v\d+$/.test(p)) p += '/v1';
  nu.pathname = p + '/models';
  nu.search = '';
  nu.hash = '';
  return nu;
}

function upstreamRequest(u, options) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, options, (res) => resolve(res));
    req.on('error', reject);
    if (options.payload) req.write(options.payload);
    req.end();
  });
}

function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function upstreamError(res, target, err) {
  sendJson(res, 502, { error: `Cannot reach ${target}: ${err.message}` });
}

async function handleApiChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }
  const u = parseAllowedUrl(body.base);
  if (!u) return sendJson(res, 400, { error: 'Only local LLM endpoints are allowed (start server with WC_ALLOW_LAN=1 to allow LAN).' });
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, 400, { error: 'messages[] is required.' });
  }

  const payloadObj = { model: String(body.model || ''), messages: body.messages, stream: true };
  if (body.temperature != null && body.temperature !== '') payloadObj.temperature = Number(body.temperature);
  if (body.max_tokens != null && body.max_tokens !== '') payloadObj.max_tokens = Number(body.max_tokens);
  // llama.cpp-style thinking control for Qwen-style models; omitted otherwise.
  if (body.thinking === 'on' || body.thinking === 'off') {
    payloadObj.chat_template_kwargs = { enable_thinking: body.thinking === 'on' };
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    payloadObj.tools = body.tools;
    if (body.tool_choice) payloadObj.tool_choice = body.tool_choice;
  }
  const payload = Buffer.from(JSON.stringify(payloadObj));

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
  };
  if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;

  const target = completionsUrl(u);
  let up;
  try {
    up = await upstreamRequest(target, { method: 'POST', headers, payload });
  } catch (e) {
    return upstreamError(res, target.href, e);
  }

  if (up.statusCode >= 400) {
    const parts = [];
    up.on('data', (c) => parts.push(c));
    up.on('end', () => send(res, up.statusCode, Buffer.concat(parts).toString('utf8'),
      up.headers['content-type'] || 'text/plain; charset=utf-8'));
    return;
  }

  res.writeHead(200, {
    'Content-Type': up.headers['content-type'] || 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  up.pipe(res);
  // Stop upstream generation when the browser aborts (Stop button / tab close).
  res.on('close', () => up.destroy());
}

async function handleApiModels(req, res) {
  const q = new URL(req.url, 'http://local').searchParams;
  const u = parseAllowedUrl(q.get('base'));
  if (!u) return sendJson(res, 400, { error: 'Only local LLM endpoints are allowed.' });
  const target = modelsUrl(u);
  const headers = {};
  const key = req.headers['x-upstream-key'];
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const up = await upstreamRequest(target, { method: 'GET', headers });
    const parts = [];
    up.on('data', (c) => parts.push(c));
    up.on('end', () => send(res, up.statusCode, Buffer.concat(parts).toString('utf8'),
      up.headers['content-type'] || 'application/json'));
  } catch (e) {
    upstreamError(res, target.href, e);
  }
}

// ---------- Memory file ----------
// Accepts either a bare array or { memory: [...] } and returns a clean list,
// or null when the shape is wrong. Each fact keeps its id, text and source so
// the browser can match it back to its own copy.
function normalizeMemories(value) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.memory) ? value.memory : null;
  if (!list) return null;
  const out = [];
  for (const m of list.slice(0, MEMORY_MAX_ITEMS)) {
    if (!m || typeof m.text !== 'string') continue;
    const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) continue;
    out.push({
      id: typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : randomUUID(),
      text,
      createdAt: Number.isFinite(m.createdAt) ? m.createdAt : Date.now(),
      source: MEMORY_SOURCES.has(m.source) ? m.source : 'manual',
    });
  }
  return out;
}

async function handleGetMemory(req, res) {
  try {
    const raw = await fs.promises.readFile(MEMORY_FILE, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('memory file is not valid JSON'); }
    sendJson(res, 200, { memory: normalizeMemories(data) || [], file: MEMORY_FILE });
  } catch (e) {
    if (e.code === 'ENOENT') return sendJson(res, 200, { memory: [], file: MEMORY_FILE });
    sendJson(res, 500, { error: `Cannot read memory file: ${e.message}` });
  }
}

async function handlePutMemory(req, res) {
  let body;
  try {
    body = await readJsonBody(req, MEMORY_MAX_BYTES);
  } catch {
    return sendJson(res, 400, { error: 'Invalid or oversized JSON body.' });
  }
  const memory = normalizeMemories(body);
  if (!memory) return sendJson(res, 400, { error: 'memory[] is required.' });
  try {
    await fs.promises.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    // Write to a temp file in the same directory, then rename so readers never
    // see a half-written file.
    const tmp = `${MEMORY_FILE}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(memory, null, 2) + '\n', 'utf8');
    await fs.promises.rename(tmp, MEMORY_FILE);
    sendJson(res, 200, { ok: true, count: memory.length, file: MEMORY_FILE });
  } catch (e) {
    sendJson(res, 500, { error: `Cannot write memory file: ${e.message}` });
  }
}

server.listen(PORT, () => {
  console.log(`Local web chat running at http://localhost:${PORT}`);
});
