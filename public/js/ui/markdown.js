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
  const link = (href, text) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  const inline = (s) => s
    // Images demote to plain links: rendering <img> would load off-machine
    // assets, which the privacy stance says no to; without this a stray "!" leaks.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '[$1]($2)')
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // Underscore emphasis is word-anchored so snake_case identifiers survive.
    .replace(/(^|[\s(])__([^_\n]+)__/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => link(u, t))
    .replace(/&lt;(https?:\/\/[^\s<>]+)&gt;/g, (_, u) => link(u, u))
    .replace(/(^|[\s(])(https?:\/\/[^\s<>"'`|]+)/g, (_, pre, url) => {
      // Sentence punctuation stays outside the link (a href must be clean).
      const tail = url.match(/[.,;:!?)\]]+$/);
      const href = tail ? url.slice(0, -tail[0].length) : url;
      return href ? pre + link(href, href) + (tail ? tail[0] : '') : pre + url;
    });

  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  const lines = esc(src).split('\n');

  // Split a table row into trimmed cells. A `\|` inside a cell is a literal
  // pipe: park it behind a placeholder so the split never cuts through it.
  const cells = (line) => line.trim()
    .replace(/\\\|/g, '\u0000P\u0000')
    .replace(/^\|(.*)\|$/, '$1')
    .split('|')
    .map((c) => c.trim().replace(/\u0000P\u0000/g, '|'));

  // GFM pipe table at `start`: header row + |---|:-:| delimiter row + body.
  // Returns { html, next } or null when the line does not open a table.
  const tableAt = (start) => {
    const head = lines[start];
    const delim = lines[start + 1];
    if (!head.includes('|') || !delim || !/^[|\s:-]+$/.test(delim)) return null;
    const hCells = cells(head);
    const dCells = cells(delim);
    if (!dCells.length || hCells.length !== dCells.length
      || !dCells.every((c) => /^:?-+:?$/.test(c))) return null;
    const aligns = dCells.map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center'
        : c.endsWith(':') ? 'right'
          : c.startsWith(':') ? 'left' : ''); // closed set — safe in style=""
    const row = (cs, tag) => {
      const pad = Array.from({ length: hCells.length }, (_, i) => cs[i] ?? '');
      return `<tr>${pad.map((c, i) =>
        `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(c)}</${tag}>`)
        .join('')}</tr>`;
    };
    const body = [];
    let i = start + 2;
    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
      body.push(row(cells(lines[i]), 'td'));
      i++;
    }
    return {
      html: `<div class="table-wrap"><table><thead>${row(hCells, 'th')}</thead>`
        + `<tbody>${body.join('')}</tbody></table></div>`,
      next: i,
    };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); // h2..h5 under msg title
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList(); out.push('<hr>');
    } else if ((m = line.match(/^\s*&gt;\s?(.*)/))) {
      closeList();
      // Consecutive quote lines belong to ONE blockquote, not one per line.
      const q = [m[1]];
      while (i + 1 < lines.length && /^\s*&gt;/.test(lines[i + 1])) {
        q.push(lines[++i].replace(/^\s*&gt;\s?/, ''));
      }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (/^\s*\|/.test(line) && (m = tableAt(i))) {
      closeList(); out.push(m.html); i = m.next - 1; // for-loop does the rest
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
