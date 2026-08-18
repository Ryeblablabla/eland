import { KNOWLEDGE_DOCUMENTS } from './knowledge-docs.js';

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizePath(path) {
  const result = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return result.join('/');
}

function resolveDocumentHref(href, sourcePath) {
  if (/^(?:https?:|mailto:|#)/.test(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return '#';
  const directory = sourcePath.split('/').slice(0, -1).join('/');
  return `../${normalizePath(`${directory}/${href}`)}`;
}

function renderInline(value, sourcePath) {
  const codeSpans = [];
  let html = escapeHtml(value).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  html = html
    .replace(/\[([^\]]+)]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) => {
      const resolved = escapeHtml(resolveDocumentHref(href, sourcePath));
      const external = /^https?:/.test(href) ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${resolved}"${external}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return html.replace(/@@CODE(\d+)@@/g, (_, index) => codeSpans[Number(index)] ?? '');
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderMarkdown(markdown, sourcePath) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      index += 1;
      output.push(`<pre><code${fence[1] ? ` data-language="${escapeHtml(fence[1])}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2], sourcePath)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      output.push(`<div class="markdown-table-wrap"><table><thead><tr>${header.map((cell) => `<th>${renderInline(cell, sourcePath)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, sourcePath)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      output.push(`<blockquote>${quote.map((item) => renderInline(item, sourcePath)).join('<br>')}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        const continuation = [];
        index += 1;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^(\s*)([-+*]|\d+\.)\s+/.test(lines[index])) {
          continuation.push(lines[index].trim());
          index += 1;
        }
        items.push(`<li>${renderInline([item[3], ...continuation].join(' '), sourcePath)}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim()
      && !/^```/.test(lines[index])
      && !/^(#{1,6})\s+/.test(lines[index])
      && !/^>\s?/.test(lines[index])
      && !/^(\s*)([-+*]|\d+\.)\s+/.test(lines[index])
      && !(lines[index].includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1]))) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(' '), sourcePath)}</p>`);
  }

  return output.join('\n');
}

const DOCS_PAGE_MARKUP = `
  <div class="docs-shell">
    <header class="docs-hero">
      <div class="rules-eyebrow"><span></span> KNOWLEDGE BASE · CORE DOCUMENTS</div>
      <h2>让规则、实现与<br>世界素材彼此可追溯</h2>
      <p>这里收录当前最重要的工程与设计文档。文档说明意图，规则页解释主链，素材页验证表现；发生冲突时，始终以可执行代码和事件历史为准。</p>
      <div class="docs-facts" aria-label="文档库说明">
        <div><strong>${KNOWLEDGE_DOCUMENTS.length}</strong><span>核心文档</span></div>
        <div><strong>FULL</strong><span>原文导入</span></div>
        <div><strong>SYNC</strong><span>由源文件生成</span></div>
      </div>
    </header>
    <section class="document-reader" aria-live="polite">
      <header class="document-header">
        <div>
          <span class="document-eyebrow" id="documentEyebrow"></span>
          <h2 id="documentTitle"></h2>
          <p id="documentSummary"></p>
        </div>
        <a id="documentSource" class="document-source" href="#">查看源文件</a>
      </header>
      <article class="markdown-body" id="documentBody"></article>
    </section>
    <footer class="rules-footer"><span>ELAND KNOWLEDGE BASE</span><p>更新源文档后运行 <code>npm run sync:docs</code>，知识库会重新导入原文。</p></footer>
  </div>
`;

export function mountDocumentLibrary() {
  const docsPage = document.getElementById('docsPage');
  const docsNavList = document.getElementById('docsNavList');
  if (!docsPage || !docsNavList) return null;

  docsPage.innerHTML = DOCS_PAGE_MARKUP;
  docsNavList.innerHTML = KNOWLEDGE_DOCUMENTS.map((document, index) => `
    <button class="doc-nav-item${index === 0 ? ' active' : ''}" type="button" data-doc-id="${document.id}">
      <span>${escapeHtml(document.title)}</span>
      <small>${escapeHtml(document.eyebrow)}</small>
    </button>
  `).join('');

  const title = document.getElementById('documentTitle');
  const eyebrow = document.getElementById('documentEyebrow');
  const summary = document.getElementById('documentSummary');
  const source = document.getElementById('documentSource');
  const body = document.getElementById('documentBody');

  const selectDocument = (id, updateHash = true) => {
    const selected = KNOWLEDGE_DOCUMENTS.find((document) => document.id === id) ?? KNOWLEDGE_DOCUMENTS[0];
    if (!selected || !title || !eyebrow || !summary || !source || !body) return;
    eyebrow.textContent = selected.eyebrow;
    title.textContent = selected.title;
    summary.textContent = selected.summary;
    source.href = `../${selected.path}`;
    source.textContent = selected.path;
    body.innerHTML = renderMarkdown(selected.content, selected.path);
    docsNavList.querySelectorAll('.doc-nav-item').forEach((button) => {
      const active = button.dataset.docId === selected.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    docsPage.scrollTop = 0;
    if (updateHash) history.replaceState(null, '', `#doc-${selected.id}`);
  };

  docsNavList.addEventListener('click', (event) => {
    const button = event.target.closest('.doc-nav-item');
    if (button?.dataset.docId) selectDocument(button.dataset.docId);
  });

  const initialId = window.location.hash.startsWith('#doc-') ? window.location.hash.slice(5) : KNOWLEDGE_DOCUMENTS[0]?.id;
  selectDocument(initialId, false);
  return { selectDocument };
}
