// Minimal event bus: data modules emit changes, UI modules subscribe.
// This keeps layers decoupled (storage/memory never touch the DOM).
const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}

export function emit(event, data) {
  for (const fn of listeners.get(event) || []) fn(data);
}
