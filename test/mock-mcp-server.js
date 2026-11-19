#!/usr/bin/env node
'use strict';
// Deterministic stand-in for a real MCP stdio server, used by the e2e suite.
// Speaks just enough JSON-RPC (initialize, tools/list, tools/call) to drive
// the whole MCP plumbing — spawn, handshake, tool discovery, tool call —
// with no network access and no runtime dependencies.
const readline = require('node:readline');

const TOOL = {
  name: 'search',
  description: 'Search the web (mock, deterministic results).',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' } },
    required: ['query'],
  },
};

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications need no reply
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0' },
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
  } else if (msg.method === 'tools/call') {
    const query = String(msg.params?.arguments?.query || '');
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text:
        `Mock search results for "${query}":\n`
        + '1. Mockresult Alpha — the definitive answer is 42\n'
        + '2. Mockresult Beta — also mentions 42' }],
    } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
  }
});
