// Minimal safe Markdown renderer (no dependencies, no raw HTML allowed).
// Input is escaped first; only the syntax we support becomes markup.
export function mdToHtml(src) {
  // Pull fenced code blocks out so inline rules never touch their contents.
  const blocks = [];
  src = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.push({ lang, code: code.replace(/\n$/, '') }) - 1;
    return `\u0000B${i}\u0000`;
  });

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of esc(src).split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); // h2..h5 under msg title
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList(); out.push('<hr>');
    } else if ((m = line.match(/^\s*&gt;\s?(.*)/))) {
      closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      out.push(line === '' ? '<br>' : `<p>${inline(line)}</p>`);
    }
  }
  closeList();

  // Re-insert code blocks with a copy button.
  return out.join('').replace(/\u0000B(\d+)\u0000/g, (_, i) => {
    const { lang, code } = blocks[Number(i)];
    return `<pre><div class="code-head"><span>${esc(lang || 'code')}</span>`
      + `<button class="code-copy ic ic-copy" type="button" aria-label="Copy code" title="Copy code"></button></div>`
      + `<code>${esc(code)}</code></pre>`;
  });
}
