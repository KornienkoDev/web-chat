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
};

export const state = {
  chats: new Map(), // id -> { id, title, createdAt, updatedAt, messages: [{role, content, savedFacts?}] }
  activeId: null,
  streaming: false,
  search: '',
  settings: { ...DEFAULT_SETTINGS },
  models: [],
  controller: null,
  memory: [], // [{id, text, createdAt, source: 'manual'|'auto'|'tool'}]
  extracting: false,
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
