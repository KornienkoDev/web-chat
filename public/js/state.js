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
};

export const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content, ts?, savedFacts?, reasoning?, timeline?}] }
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
