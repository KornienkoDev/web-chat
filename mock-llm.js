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
//     code + pipe table with alignments and an escaped \| cell + strike/em +
//     bare URL + merged blockquote + image syntax) so the renderer's copy
//     button, table and inline-markup paths are all covered;
//   * "count from A to B" streams A..B one per line so the Stop button has a
//     long enough stream to actually interrupt;
//   * multimodal user messages (attachment parts) are flattened back to text,
//     images become "[image]" markers, and the default echo counts them as
//     "(saw N image(s))" so the attachment tests can prove they reached the API;
//   * prompt caching: with a cache_key, the mock remembers the previous
//     request's messages for that key and reports the shared message prefix
//     as cached_tokens in a final usage chunk (when stream_options.include_usage
//     is set) — "tokens" are words, only the ratios matter for the tests;
//   * upstream failure modes: "empty probe" answers with an immediate stop
//     right after a tool result (the client must nudge once to recover),
//     "search N times for X" keeps calling the search tool for N rounds past
//     the client's tool-round cap (the turn must still end with a conclusion),
//     and "die mid stream" drops the socket without finish_reason or [DONE]
//     (the proxy and client must surface an error instead of going silent);
//   * GET /mock/last returns the latest request's cache metadata (cache key,
//     stream_options, roles, clock-at-end) for the suite to assert against.
const http = require('node:http');

const PORT = Number(process.env.PORT || 11435);
let reqId = 0;

// Per-cache_key prompt-cache emulation: the messages of the last request seen
// for a key, and a small log for the /mock/last introspection endpoint.
const lastMsgsByKey = new Map();
const reqLog = [];

function usageChunk(id, body, msgs) {
  if (!body.stream_options?.include_usage) return null;
  const key = typeof body.cache_key === 'string' ? body.cache_key : '';
  const prev = key ? lastMsgsByKey.get(key) : undefined;
  if (key) lastMsgsByKey.set(key, msgs);
  const prompt = promptTokens(msgs);
  const cached = prev ? sharedPrefixWords(prev, msgs) : 0;
  return { id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
    choices: [], usage: {
      prompt_tokens: prompt, completion_tokens: 0, total_tokens: prompt,
      prompt_tokens_details: { cached_tokens: cached },
    } };
}

const wc = (s) => (s.match(/\S+/g) || []).length;

// Word counts over the message contents stand in for tokens.
function promptTokens(msgs) {
  return msgs.reduce((n, m) => n + wc(flattenContent(m.content)), 0);
}

// Words covered by the longest shared message-array prefix — the part a real
// KV cache would reuse without re-prefilling.
function sharedPrefixWords(prevMsgs, msgs) {
  let n = 0;
  for (let i = 0; i < Math.min(prevMsgs.length, msgs.length); i++) {
    if (JSON.stringify(prevMsgs[i]) !== JSON.stringify(msgs[i])) break;
    n += wc(flattenContent(msgs[i].content));
  }
  return n;
}

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

// Appends the usage chunk a server emits after the last token when the client
// asked for it; `words` is the streamed output length so completion totals add up.
function writeUsage(w, u, words) {
  if (!u) return;
  const usage = { ...u.usage, completion_tokens: words, total_tokens: u.usage.prompt_tokens + words };
  w.write(chunk({ ...u, usage }));
}

async function streamText(res, id, text, delay = 15, reasoning = '', usage = null) {
  const w = safeWriter(res);
  for (const word of reasoning.match(/\S+\s*/g) || []) {
    if (!w.live) break;
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta: { reasoning_content: word }, finish_reason: null }] }));
    await sleep(delay);
  }
  for (const word of text.match(/\S+\s*/g) || []) {
    if (!w.live) break;
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta: { content: word }, finish_reason: null }] }));
    await sleep(delay);
  }
  w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  writeUsage(w, usage, wc(reasoning) + wc(text));
  w.write('data: [DONE]\n\n');
  if (w.live) res.end();
}

// Streams the requested range one number per line, slowly enough (~12ms each)
// that the suite can interrupt mid-count and still have plenty of partial text.
async function streamCount(res, id, start, end, delay = 12, usage = null) {
  const w = safeWriter(res);
  for (let n = start; n <= end && w.live; n++) {
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta: { content: `${n}\n` }, finish_reason: null }] }));
    await sleep(delay);
  }
  w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  writeUsage(w, usage, end - start + 1);
  w.write('data: [DONE]\n\n');
  if (w.live) res.end();
}

// Emits one save_memory tool call per fact, each with its own index so the
// client's per-index assembler collects them all, and streams the JSON args in
// small pieces to mimic how a real model dribbles tool arguments over SSE.
function streamToolCalls(res, id, facts, usage = null) {
  const w = safeWriter(res);
  const mk = (delta, finish = null) =>
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta, finish_reason: finish }] }));
  mk({ role: 'assistant' });
  let argWords = 0;
  facts.forEach((fact, i) => {
    if (!w.live) return;
    const args = JSON.stringify({ fact });
    argWords += wc(args);
    mk({ tool_calls: [{ index: i, id: `call_mock_${i + 1}`, type: 'function',
      function: { name: 'save_memory', arguments: '' } }] });
    for (let p = 0; p < args.length; p += 7) {
      mk({ tool_calls: [{ index: i, function: { arguments: args.slice(p, p + 7) } }] });
    }
  });
  mk({}, 'tool_calls');
  writeUsage(w, usage, argWords);
  w.write('data: [DONE]\n\n');
  if (w.live) res.end();
}

// Emits a single tool call with streamed JSON args, used for the search
// emulation below.
function streamOneToolCall(res, id, name, argsObj, usage = null) {
  const w = safeWriter(res);
  const mk = (delta, finish = null) =>
    w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
      choices: [{ index: 0, delta, finish_reason: finish }] }));
  mk({ role: 'assistant' });
  const args = JSON.stringify(argsObj);
  mk({ tool_calls: [{ index: 0, id: 'call_mock_search', type: 'function',
    function: { name, arguments: '' } }] });
  for (let p = 0; p < args.length; p += 7) {
    mk({ tool_calls: [{ index: 0, function: { arguments: args.slice(p, p + 7) } }] });
  }
  mk({}, 'tool_calls');
  writeUsage(w, usage, wc(args));
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

// Flattens an OpenAI message content — a plain string, or the multimodal parts
// array webchat builds for messages with attachments — into plain text. Image
// parts become a visible marker so replies can echo that they "saw" them.
function flattenContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((p) => (p.type === 'text' ? (p.text || '') : p.type === 'image_url' ? '[image]' : '')).join(' ').trim();
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
  + '| Fruit | Color | Qty |\n| --- | :---: | ---: |\n'
  + 'Apple | Red | 3\n| Banana \\| baby | Yellow | 12 |\n\n'
  + '~~Mango~~ is _out_; details at https://example.com/fruits.\n\n'
  + '> Note: seasonal.\n> Pick firm fruit.\n\n'
  + '![bananas](https://example.com/bananas.png)\n\n'
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
    // The trailing clock line and the forced-conclusion budget line are user
    // messages too (Qwen3's template rejects system messages after the first),
    // so skip them when finding the user's actual ask.
    const meta = (m) => m.role === 'user'
      && /current date and time|tool budget for this turn is used up/i.test(flattenContent(m.content));
    const lastUser = flattenContent([...msgs].reverse().find((m) => m.role === 'user' && !meta(m))?.content);
    const afterTool = msgs.some((m) => m.role === 'tool');
    const id = `chatcmpl-mock-${++reqId}`;

    // Prompt-cache bookkeeping (see header): compute the usage chunk once per
    // request — it also records the message array as the next request's
    // prefix baseline — and log the cache metadata for /mock/last.
    const usage = usageChunk(id, body, msgs);
    reqLog.push({
      n: reqLog.length,
      cacheKey: (typeof body.cache_key === 'string' && body.cache_key) || null,
      streamOptions: body.stream_options || null,
      roles: msgs.map((msg) => msg.role),
      clockAtEnd: msgs.at(-1)?.role === 'user'
        && /current date and time/i.test(flattenContent(msgs.at(-1)?.content)),
    });

    // With thinking enabled the mock first streams a fake chain of thought as
    // reasoning_content deltas, like llama.cpp does for Qwen-style models.
    const thinking = body.chat_template_kwargs?.enable_thinking === true;
    const think = `The user wrote: "${lastUser.slice(0, 60)}". `
      + 'Let me pick a short, friendly reply that also shows I parsed the request. ';

    // 0) MCP search emulation: webchat offers every MCP tool as
    // "<server>__<tool>". When such a tool is present, a "search for X" ask
    // calls it — the result then comes back as a tool message for branch 2.
    const searchTool = (body.tools || []).find((t) => t.function?.name?.endsWith('__search'));
    let sm;
    // 0a) Deep-research emulation: "search N times for X" keeps calling the
    // search tool once per round for N rounds — the way a real model chains
    // search -> read -> search — even past the client's tool-round cap. With
    // the cap reached (or no tools offered, the client's tool-less wrap-up
    // call) it delivers the conclusion instead.
    if ((sm = lastUser.match(/search (\d+) times (?:for|about) (.+)/i))) {
      const need = Number(sm[1]);
      const done = msgs.filter((m) => m.role === 'tool').length;
      if (searchTool && done < need) {
        return streamOneToolCall(res, id, searchTool.function.name,
          { query: `${sm[2].trim()} (round ${done + 1})` }, usage);
      }
      return streamText(res, id,
        `Research done after ${done} searches on ${sm[2].trim()}: the answer is 42.`,
        undefined, '', usage);
    }
    if (searchTool && !afterTool && (sm = lastUser.match(/search for (.+)/i))) {
      return streamOneToolCall(res, id, searchTool.function.name, { query: sm[1].trim() }, usage);
    }
    // 0b) forget_memory emulation: any "forget that X" ask names the fact to
    // drop; the real client resolves the wording against the live list.
    const forgetTool = (body.tools || []).find((t) => t.function?.name === 'forget_memory');
    let fm;
    if (forgetTool && !afterTool && (fm = lastUser.match(/(?:forget|delete the memory about|remove the memory about)\s+(?:that\s+)?(.+)/i))) {
      return streamOneToolCall(res, id, 'forget_memory', { memory_id_or_text: fm[1].trim() }, usage);
    }
    // 1) Memory tool: save each durable fact, one tool call each.
    const facts = extractFacts(lastUser);
    if (body.tools?.length && !afterTool && facts.length) {
      return streamToolCalls(res, id, facts, usage);
    }
    // 2) The model's spoken reply after its tool calls ran; echo the tool
    // output so tests can prove results round-tripped through the executor.
    if (afterTool) {
      // 2a) Empty-answer simulation for the nudge test: "empty probe" saves a
      // fact (branch 1) and then EOSes with no text right after the tool
      // result — just like a small model quitting after a long search dump.
      // The client's nudge (a user message) then coaxes the recovery reply.
      if (/no answer received/i.test(lastUser)) {
        return streamText(res, id, 'Recovered: the probe is done and the answer is ready.',
          undefined, '', usage);
      }
      if (msgs.some((x) => x.role === 'user' && /empty probe/i.test(flattenContent(x.content)))) {
        return streamText(res, id, '', undefined, '', usage);
      }
      const toolOut = msgs.filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join(' | ');
      return streamText(res, id, `Noted! (mock reply to: ${lastUser.slice(0, 60)}) ${toolOut.slice(0, 120)}`,
        undefined, thinking ? think : '', usage);
    }
    // 2b) Mid-stream death: stream a few tokens, then drop the socket without
    // finish_reason or [DONE] — the proxy must tear the browser response down
    // and the client must surface an error instead of stopping silently.
    if (/die mid stream/i.test(lastUser)) {
      const w = safeWriter(res);
      for (const word of 'Streaming normally until I die. '.match(/\S+\s*/g) || []) {
        if (!w.live) break;
        w.write(chunk({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-llm',
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }] }));
        await sleep(20);
      }
      res.destroy();
      return;
    }
    // 3) Counting: a long, interruptible stream for the Stop button.
    let m;
    if ((m = lastUser.match(/count\s+from\s+(\d+)\s+to\s+(\d+)/i))) {
      return streamCount(res, id, Number(m[1]), Number(m[2]), 12, usage);
    }
    if ((m = lastUser.match(/count\s+to\s+(\d+)/i))) {
      return streamCount(res, id, 1, Number(m[1]), 12, usage);
    }
    // 4) Markdown demo.
    if (/\b(markdown|code block)\b/i.test(lastUser) || /\blist of\b.*\b(fruit|fruits)\b/i.test(lastUser)) {
      return streamText(res, id, MARKDOWN_REPLY, undefined, thinking ? think : '', usage);
    }
    // 5) Default echo; surface the injected memory so recall is observable,
    // and count any [image] markers so attachment tests can prove the vision
    // parts actually reached the model.
    const known = knownFacts(msgs);
    const memory = known.length ? `  (I remember: ${known.slice(0, 3).join('; ')})` : '';
    const imgs = (lastUser.match(/\[image\]/g) || []).length;
    const vision = imgs ? `  (saw ${imgs} image${imgs > 1 ? 's' : ''})` : '';
    return streamText(res, id, `Mock echo: ${lastUser.slice(0, 120)}${memory}${vision}`,
      undefined, thinking ? think : '', usage);
  }

  // Introspection for the e2e suite: what the latest chat request looked like.
  // CORS-open so the page (different origin) can fetch it via window eval.
  if (req.method === 'GET' && url.pathname === '/mock/last') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(reqLog.at(-1) || null));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock LLM ready at http://localhost:${PORT}/v1 (use as the API base URL in Settings)`);
});
