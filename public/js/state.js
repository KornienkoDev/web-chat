// mock-llm.js default port — the mock server always runs next to the app,
// this is the only URL the mock toggle uses (keep in sync with start.sh).
export const MOCK_BASE_URL = 'http://127.0.0.1:11435/v1';

export const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:8081/v1',
  apiKey: '',
  model: '',
  temperature: '',
  maxTokens: '1024',
  contextMessages: '20',
  system: '',
  thinking: 'default',
  autoExtract: false, // fallback learner for models without tool support
  mcpDisabled: '', // comma-separated MCP server names unchecked in Settings
  mock: false, // pin all requests to MOCK_BASE_URL; the real baseUrl stays saved
};

export const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content, ts?, attachments?, savedFacts?, reasoning?, timeline?}] }
  activeId: null,
  streaming: false,
  search: '',
  settings: { ...DEFAULT_SETTINGS },
  models: [],
  controller: null,
  memory: [], // [{id, text, createdAt, source: 'manual'|'auto'|'tool'}]
  memoryFile: '', // path of the server-side JSON file, once known
  extracting: false,
  mcpTools: [], // OpenAI function shape from /api/mcp/tools: [{type, function: {...}}]
  mcpStatus: [], // per-server [{name, status: 'ready'|'error'|'disabled', tools, error?}]
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
