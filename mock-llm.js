#!/usr/bin/env node
'use strict';
// Tiny OpenAI-compatible mock LLM server for UI testing without a GPU.
// Speaks just enough of /v1/chat/completions (SSE streaming + save_memory
// tool calls) to exercise the whole frontend deterministically.
//
//   node mock-llm.js            # listens on http://127.0.0.1:11435/v1
//
// Behaviour the e2e suite (test/cdp-suite.mjs) relies on:
//   * a self-intro ("my name is X, I am Y, my dog NAME is Z") triggers one
//     save_memory tool call PER fact, phrased in third person so manual and
//     automatic saves collide on the duplicate detector;
//   * after tool results, it confirms and, on later turns, echoes the memory
//     facts that were injected into the system prompt (proves recall wiring);
//   * "list of ... fruits"/"code block" returns real Markdown (list + fenced
//     code) so the renderer's copy button path is covered;
//   * "count from A to B" streams A..B one per line so the Stop button has a
//     long enough stream to actually interrupt.
const http = require('node:http');

const PORT = Number(process.env.PORT || 11435);
let reqId = 0;

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A writer that silently stops once the client has hung up (Stop button / tab
// close), so an aborted stream can never crash the server with EPIPE.
function safeWriter(res) {
  let open = true;
  res.on('close', () => { open = false; });
  res.on('error', () => { open = false; });
  return {
    get live() { return open && !res.writableEnded && !res.destroyed; },
    write(s) { if (this.live) { try { res.write(s); } catch { open = false; } } },
  };
}

async function streamText(res, id, text, delay = 15) {
  const w = safeWriter(res);
  for (const word of text.match(/\S+\s*/g) || []) {
    if (!w.live) break;
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta: { content: word }, finish_reason: null }] }));
    await sleep(delay);
  }
  w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  w.write('data: [DONE]\n\n');
  if (w.live) res.end();
}

// Streams the requested range one number per line, slowly enough (~12ms each)
// that the suite can interrupt mid-count and still have plenty of partial text.
async function streamCount(res, id, start, end, delay = 12) {
  const w = safeWriter(res);
  for (let n = start; n <= end && w.live; n++) {
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta: { content: `${n}\n` }, finish_reason: null }] }));
    await sleep(delay);
  }
  w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  w.write('data: [DONE]\n\n');
  if (w.live) res.end();
}

// Emits one save_memory tool call per fact, each with its own index so the
// client's per-index assembler collects them all, and streams the JSON args in
// small pieces to mimic how a real model dribbles tool arguments over SSE.
function streamToolCalls(res, id, facts) {
  const w = safeWriter(res);
  const mk = (delta, finish = null) =>
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta, finish_reason: finish }] }));
  mk({ role: 'assistant' });
  facts.forEach((fact, i) => {
    if (!w.live) return;
    const args = JSON.stringify({ fact });
    mk({ tool_calls: [{ index: i, id: `call_mock_${i + 1}`, type: 'function',
      function: { name: 'save_memory', arguments: '' } }] });
    for (let p = 0; p < args.length; p += 7) {
      mk({ tool_calls: [{ index: i, function: { arguments: args.slice(p, p + 7) } }] });
    }
  });
  mk({}, 'tool_calls');
  w.write('data: [DONE]\n\n');
  if (w.live) res.end();
}

// Pulls the memory facts the app injects into the system prompt ("## Long-term
// memory" list) so replies can show that recall reached the model.
function knownFacts(msgs) {
  const sys = msgs.find((m) => m.role === 'system');
  const c = typeof sys?.content === 'string' ? sys.content : '';
  const block = c.match(/## Long-term memory[\s\S]*?(?:\nUse these|\n\n|$)/);
  if (!block) return [];
  return [...block[0].matchAll(/^\s*-\s+(.+)$/gm)].map((m) => m[1].trim());
}

// Turns a first-person self-intro into third-person durable facts. Phrasing and
// the uppercase-name/` is` guards keep chit-chat and questions from matching.
function extractFacts(text) {
  const facts = [];
  let m;
  if ((m = text.match(/\bmy name is\s+([A-Za-z][\w'-]+)/i)))
    facts.push(`User's name is ${m[1]}`);
  if ((m = text.match(/\b(?:i am|i'm)\s+([a-z][a-z'-]+)/i)))
    facts.push(`User is ${m[1]}`);
  if ((m = text.match(/\bi prefer\s+([^.,;]+)/i)))
    facts.push(`User prefers ${m[1].trim()}`);
  if ((m = text.match(/\bmy (dog|cat|pet|wife|husband|partner)\s+([A-Z][\w'-]+)\s+is\s+([^.,;]+)/i)))
    facts.push(`User's ${m[1]} ${m[2]} is ${m[3].trim()}`);
  if (!facts.length && /\bremember\b/i.test(text)) {
    const rest = text.replace(/^\s*(?:please\s+)?remember\s+(?:that\s+)?/i, '').trim();
    if (rest) facts.push(`User: ${rest.slice(0, 120)}`);
  }
  return facts.slice(0, 4);
}

const MARKDOWN_REPLY =
  'Here is a list of fruits and a small Python program:\n\n'
  + '- Apple\n- Banana\n- Cherry\n\n'
  + '```python\nprint("hi")\n```\n';

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

    // 1) Memory tool: save each durable fact, one tool call each.
    const facts = extractFacts(lastUser);
    if (body.tools?.length && !afterTool && facts.length) {
      return streamToolCalls(res, id, facts);
    }
    // 2) The model's spoken reply after its tool calls ran.
    if (afterTool) {
      return streamText(res, id, `Noted! (mock reply to: ${lastUser.slice(0, 60)})`);
    }
    // 3) Counting: a long, interruptible stream for the Stop button.
    let m;
    if ((m = lastUser.match(/count\s+from\s+(\d+)\s+to\s+(\d+)/i))) {
      return streamCount(res, id, Number(m[1]), Number(m[2]));
    }
    if ((m = lastUser.match(/count\s+to\s+(\d+)/i))) {
      return streamCount(res, id, 1, Number(m[1]));
    }
    // 4) Markdown demo.
    if (/\b(markdown|code block)\b/i.test(lastUser) || /\blist of\b.*\b(fruit|fruits)\b/i.test(lastUser)) {
      return streamText(res, id, MARKDOWN_REPLY);
    }
    // 5) Default echo; surface the injected memory so recall is observable.
    const known = knownFacts(msgs);
    const memory = known.length ? `  (I remember: ${known.slice(0, 3).join('; ')})` : '';
    return streamText(res, id, `Mock echo: ${lastUser.slice(0, 120)}${memory}`);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock LLM ready at http://localhost:${PORT}/v1 (use as the API base URL in Settings)`);
});
