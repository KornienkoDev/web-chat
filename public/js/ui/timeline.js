// The "process" strip of a reply: an ordered list of what the model did this
// turn — its thinking blocks and tool-use pills (MCP + memory) interleaved in
// the order they happened (think → tool → think → tool). Read from
// `asst.timeline`; older messages that only carry `reasoning`/`mcpUsed` are
// folded into an equivalent timeline on the fly so they still render.
//
// Two entry points: buildProcess(m) for the final (post-stream) render, and
// updateProcess(el, m) for the live view, which appends steps as they arrive
// and only ever mutates the newest one (its text grows, or a tool flips from
// running to done).

// Fold a message into the step list, synthesising one from legacy fields.
function stepsOf(m) {
  if (Array.isArray(m.timeline)) return m.timeline;
  const out = [];
  if (m.reasoning) out.push({ kind: 'think', text: m.reasoning });
  for (const t of m.mcpUsed || []) {
    out.push({ kind: 'tool', family: 'mcp', name: t.name, arg: t.arg, status: t.status, error: t.error });
  }
  return out;
}

const exposedSplit = (name) => {
  const i = name.indexOf('__');
  return i < 0 ? { server: '', tool: name } : { server: name.slice(0, i), tool: name.slice(i + 2) };
};

function toolIcon(s) {
  if (s.family === 'memory') return s.action === 'forget' ? 'ic-close' : 'ic-brain';
  return 'ic-wrench';
}
function toolLabel(s) {
  if (s.family === 'memory') return s.action === 'forget' ? 'memory · forget' : 'memory · save';
  const { server, tool } = exposedSplit(s.name);
  return `${server ? server + ' · ' : ''}${tool}`;
}
// A memory save is already summarised by the "Remembered" note below the reply,
// so its fact stays in the tooltip; the forget target and MCP query show inline.
function toolInlineArg(s) {
  if (!s.arg) return '';
  if (s.family === 'memory' && s.action === 'save') return '';
  return s.arg;
}
function toolTitle(s) {
  if (s.status === 'error') return `${toolLabel(s)} failed: ${s.error || s.name}`;
  return s.arg ? `${s.name}: ${s.arg}` : s.name;
}

function paintTool(chip, s) {
  chip.textContent = '';
  chip.className = 'msg-tool';
  if (s.status === 'running') chip.classList.add('is-running');
  else if (s.status === 'error') chip.classList.add('is-error');
  const icon = document.createElement('span');
  icon.className = 'ic ' + toolIcon(s);
  icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'msg-tool-name';
  name.textContent = toolLabel(s) + (s.status === 'running' ? '\u2026' : '');
  chip.append(icon, name);
  const arg = toolInlineArg(s);
  if (arg) {
    const argEl = document.createElement('span');
    argEl.className = 'msg-tool-arg';
    argEl.textContent = `\u201C${arg}\u201D`;
    chip.appendChild(argEl);
  }
  chip.title = toolTitle(s);
}

function thinkNode(step, live) {
  const box = document.createElement('details');
  box.className = 'msg-think';
  box.open = live; // open only while the model is still writing this block
  const sum = document.createElement('summary');
  const label = document.createElement('span');
  label.textContent = live ? 'Thinking\u2026' : 'Thinking';
  if (live) {
    box.classList.add('msg-think-live');
    label.className = 'msg-think-label';
    sum.appendChild(label);
  } else {
    sum.textContent = 'Thinking';
  }
  const body = document.createElement('div');
  body.className = 'msg-think-text';
  body.textContent = step.text || '';
  box.append(sum, body);
  return {
    kind: 'think',
    el: box,
    refresh(s) { body.textContent = s.text || ''; },
    // A finished block loses the shimmer and collapses to save room.
    close() {
      box.open = false;
      box.classList.remove('msg-think-live');
      label.textContent = 'Thinking';
    },
  };
}

function toolNode(step) {
  const chip = document.createElement('span');
  paintTool(chip, step);
  return { kind: 'tool', el: chip, refresh(s) { paintTool(chip, s); } };
}

function makeNode(step, live) {
  return step.kind === 'think' ? thinkNode(step, live) : toolNode(step);
}

// Final render: every step static and collapsed. Returns null when there is
// nothing to show so the caller can skip the wrapper.
export function buildProcess(m) {
  const steps = stepsOf(m);
  if (!steps.length) return null;
  const box = document.createElement('div');
  box.className = 'msg-process';
  for (const s of steps) box.appendChild(makeNode(s, false).el);
  return box;
}

// ---------- live view ----------
// Maps a message element to the process strip we mounted and the node views we
// created, so streaming can append/patch instead of rebuilding on every token.
const views = new WeakMap();

export function updateProcess(el, m) {
  const steps = stepsOf(m);
  if (!steps.length) {
    el.querySelector('.msg-process')?.remove();
    el.classList.remove('msg-live');
    views.delete(el);
    return;
  }
  let view = views.get(el);
  if (!view) {
    // First real output — retire the prefill "Processing…" stand-in (owned by
    // ui/messages.js) and mark the bubble live so it can grow to the full
    // column instead of hugging the "Thinking…" word.
    el.querySelector('.msg-processing')?.remove();
    el.classList.add('msg-live');
    const process = document.createElement('div');
    process.className = 'msg-process';
    const textEl = el.querySelector('.msg-text');
    if (textEl) el.insertBefore(process, textEl); else el.appendChild(process);
    view = { process, nodes: [] };
    views.set(el, view);
  }
  // Append the steps that appeared since the last tick; the step before a new
  // one is finished, so freeze its think block (collapse + stop shimmering).
  while (view.nodes.length < steps.length) {
    view.nodes[view.nodes.length - 1]?.close?.();
    const node = makeNode(steps[view.nodes.length], true);
    view.process.appendChild(node.el);
    view.nodes.push(node);
  }
  // Only the newest step can still change (its text grew, or a tool resolved).
  view.nodes[view.nodes.length - 1]?.refresh?.(steps[steps.length - 1]);
}
