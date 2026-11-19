// Attachment ingestion: turns picked/pasted/dropped File objects into small,
// plain records that ride along on a user message ({id, name, mime, kind,
// text? | dataUrl?}) and survive localStorage. Images are downscaled in a
// canvas first — a phone photo left untouched would eat both the browser
// storage budget and the proxy's 8 MB body limit whole; a ≤1280 px JPEG gives
// any vision model plenty while costing a fraction. Text documents are read as
// UTF-8 and cut at a prompt-friendly cap so one huge file cannot crowd out
// the conversation. Touches no app state and no chat elements — the composer
// stages what this returns.
import { uid } from './state.js';

export const MAX_ATTACHMENTS = 6;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // what we accept picking
const IMAGE_MAX_SIDE = 1280;              // plenty for a vision model's tile grid
const IMAGE_DATA_MAX = 3.5 * 1024 * 1024; // base64 must still fit the proxy beside history
const MAX_TEXT_BYTES = 512 * 1024;        // read budget per document
const MAX_TEXT_CHARS = 8000;              // prompt budget per document

// Extension whitelist for text docs: mime is unreliable (editors label .md as
// octet-stream, browsers label odd files as text/plain), so both paths count.
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ndjson|csv|tsv|log|ya?ml|xml|toml|ini|conf|properties|env|editorconfig|gitignore|html|htm|css|scss|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cc|cs|php|pl|lua|r|sql|sh|bash|zsh|fish|ps1|bat|make|cmake|patch|diff)$/i;

const label = (file) => String(file.name || 'unnamed file');

export function isImageFile(file) {
  // SVG is markup, not pixels: a canvas would rasterise it without a prompt-
  // worthy size, and the model reads the source better than a snapshot.
  return (file.type || '').startsWith('image/') && file.type !== 'image/svg+xml';
}

function isTextFile(file) {
  const t = file.type || '';
  return t.startsWith('text/')
    || t === 'image/svg+xml' // markup after all: hand it over as a document
    || /^application\/(json|xml|x-?yaml)/.test(t)
    || TEXT_EXT.test(label(file));
}

// One File at a time; a broken file only costs itself (error message back to
// the caller, which owns the toast). Returns {items, errors}.
export async function readFiles(files) {
  const items = [];
  const errors = [];
  for (const file of [...files]) {
    try {
      if (isImageFile(file)) items.push(await readImage(file));
      else if (isTextFile(file)) items.push(await readText(file));
      else errors.push(`“${label(file)}”: unsupported — attach images or text documents.`);
    } catch (e) {
      errors.push(`“${label(file)}”: ${e.message}`);
    }
  }
  return { items, errors };
}

// ---------- Text documents ----------
async function readText(file) {
  // Slice before decoding: a runaway file never gets fully loaded into memory.
  const buf = await file.slice(0, MAX_TEXT_BYTES).arrayBuffer();
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // NULs mean we walked into a binary that claimed a text extension.
  if (text.includes('\u0000')) throw new Error('not a text file');
  let truncated = file.size > MAX_TEXT_BYTES;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('the file is empty');
  return { id: uid(), name: label(file), mime: file.type || 'text/plain', kind: 'text', text, truncated };
}

// ---------- Images ----------
// Decoded through createImageBitmap (falls back to <img>), drawn scaled onto a
// canvas, and re-encoded JPEG q0.85. Small PNGs keep their original bytes so
// transparency and lossless detail survive when they cost nothing.
async function readImage(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('image too large (max 10 MB)');
  const bmp = await decodeImage(file);
  try {
    const w = bmp.width;
    const h = bmp.height;
    if (!w || !h) throw new Error('unreadable image');
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
    if (scale < 1 || file.size > 1024 * 1024 || file.type === 'image/jpeg') {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha: paint white so transparent PNG corners go white
      // instead of black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', 0.85);
      return imageRecord(file, out, canvas.width, canvas.height);
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('could not read the image'));
      r.readAsDataURL(file);
    });
    return imageRecord(file, dataUrl, w, h);
  } finally {
    bmp.close?.();
  }
}

function imageRecord(file, dataUrl, w, h) {
  if (!/^data:image\/[a-z+]+;base64,/i.test(dataUrl)) throw new Error('unexpected image data');
  if (dataUrl.length > IMAGE_DATA_MAX) throw new Error('image still too large after resizing');
  // Storing the stored-pixel size lets the bubble's <img> carry width/height
  // attributes, so every engine keeps the aspect ratio before and while the
  // picture decodes (pure CSS caps distorted it in some browsers).
  return { id: uid(), name: label(file), mime: file.type, kind: 'image', dataUrl, w, h };
}

function decodeImage(file) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file).catch(() => decodeViaImg(file));
  }
  return decodeViaImg(file);
}

function decodeViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    img.src = url;
  });
}

// The text a document contributes to the model's prompt. Kept in one place so
// prompt assembly (turn.js) and any future renderer agree on the shape.
export function documentPartText(att) {
  return `[Attached document: ${att.name}]\n${att.text}${att.truncated ? '\n[…document truncated]' : ''}`;
}
