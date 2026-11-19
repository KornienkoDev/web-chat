// Send-flow service: owns one user turn end-to-end (push messages, stream,
// handle stop/errors). UI hooks are injected at init so this module stays
// independent of concrete DOM elements.
import { state } from './state.js';
import { activeChat, newChat, touchChat } from './chats.js';
import { runChatTurn } from './turn.js';
import { autoExtract } from './memory.js';

let hooks = null;

// hooks: { renderAll, appendMessage(msg) -> {el, textEl}, renderText(textEl, text),
//          updateSavedFacts(el, msg), clearInput, setStreaming(on),
//          scrollToBottom, atBottom }
export function initSession(h) {
  hooks = h;
}

export async function sendMessage(text) {
  text = (text || '').trim();
  if (!text || state.streaming) return;

  const chat = activeChat() || newChat();
  chat.messages.push({ role: 'user', content: text });
  if (chat.title === 'New chat') chat.title = text.slice(0, 40);
  hooks.clearInput();
  hooks.renderAll();

  hooks.setStreaming(true);
  state.streaming = true;
  state.controller = new AbortController();
  const asst = { role: 'assistant', content: '' };
  chat.messages.push(asst);
  const { el, textEl } = hooks.appendMessage(asst);

  // Coalesce bursts of streamed tokens into one Markdown repaint per animation
  // frame, and only follow the stream while the user hasn't scrolled up.
  let frame = 0;
  const repaint = () => {
    frame = 0;
    if (hooks.renderText) hooks.renderText(textEl, asst.content);
    else textEl.textContent = asst.content;
    if (hooks.atBottom()) hooks.scrollToBottom();
  };
  const onText = (delta) => {
    asst.content += delta;
    if (!frame) frame = requestAnimationFrame(repaint);
  };
  const onSaved = () => hooks.updateSavedFacts(el, asst);

  try {
    await runChatTurn(chat, asst, onText, onSaved, state.controller.signal);
    if (!asst.content && !asst.savedFacts?.length) asst.content = '(empty response)';
    autoExtract(chat);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!asst.content && !asst.savedFacts?.length) chat.messages.pop();
    } else {
      chat.messages.pop();
      chat.messages.push({ role: 'error', content: e.message });
    }
  }
  if (frame) cancelAnimationFrame(frame); // drop any queued repaint; renderAll is authoritative
  state.controller = null;
  state.streaming = false;
  touchChat(chat);
  hooks.setStreaming(false);
  hooks.renderAll();
}

export function stopStreaming() {
  state.controller?.abort();
}

// Re-run the last user message: drop it and everything after, then send it again.
export async function regenerate() {
  if (state.streaming) return;
  const chat = activeChat();
  if (!chat) return;
  let i = chat.messages.length - 1;
  while (i >= 0 && chat.messages[i].role !== 'user') i--;
  if (i < 0) return;
  const text = chat.messages[i].content;
  chat.messages.length = i;
  await sendMessage(text);
}
