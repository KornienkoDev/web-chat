#!/usr/bin/env node
'use strict';
// Tiny OpenAI-compatible mock LLM server for UI testing without a GPU.
// Speaks just enough of /v1/chat/completions (SSE streaming + save_memory
// tool calls) to exercise the whole frontend.
//
//   node mock-llm.js            # listens on http://127.0.0.1:11435/v1
const http = require('node:http');

const PORT = Number(process.env.PORT || 11435);
let reqId = 0;

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendSseHead(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
}

async function streamText(res, id, text, delay = 15) {
  for (const word of text.match(/\S+\s*/g) || []) {
    res.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta: { content: word }, finish_reason: null }] }));
    await sleep(delay);
  }
  res.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamToolCall(res, id, fact) {
  const args = JSON.stringify({ fact });
  const mk = (delta, finish = null) => res.write(chunk({ id, object: 'chat.completion.chunk',
    created: 0, model: 'mock-llm', choices: [{ index: 0, delta, finish_reason: finish }] }));
  mk({ role: 'assistant' });
  mk({ tool_calls: [{ index: 0, id: 'call_mock_1', function: { name: 'save_memory', arguments: '' } }] });
  for (let i = 0; i < args.length; i += 7) {
    mk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 7) } }] });
  }
  mk({}, 'tool_calls');
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-llm', object: 'model' }] }));
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const parts = [];
    for await (const c of req) parts.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }

    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
    const afterTool = msgs.some((m) => m.role === 'tool');
    const id = `chatcmpl-mock-${++reqId}`;

    // Mimic a memory-aware model: save a fact when asked, then confirm.
    if (body.tools?.length && !afterTool && /\b(remember|my name is|i am|i prefer)\b/i.test(lastUser)) {
      return streamToolCall(res, id, `Mock fact: ${lastUser.slice(0, 80)}`);
    }
    const reply = afterTool
      ? `Noted! (mock reply to: ${lastUser.slice(0, 60)})`
      : `Mock echo: ${lastUser.slice(0, 120)}`;
    return streamText(res, id, reply);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock LLM ready at http://localhost:${PORT}/v1 (use as the API base URL in Settings)`);
});
