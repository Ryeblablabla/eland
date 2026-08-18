function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalize(value) {
  return String(value).toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(value, terms) {
  if (!terms.length) return escapeHtml(value);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu');
  return String(value).split(pattern).map((part) => (
    terms.some((term) => normalize(part) === term)
      ? `<mark>${escapeHtml(part)}</mark>`
      : escapeHtml(part)
  )).join('');
}

function excerptAround(value, terms) {
  const compact = String(value).replace(/[#*`>|_[\](){}]/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = normalize(compact);
  const first = terms.reduce((best, term) => {
    const found = lower.indexOf(term);
    return found >= 0 && (best < 0 || found < best) ? found : best;
  }, -1);
  const start = Math.max(0, (first < 0 ? 0 : first) - 42);
  const end = Math.min(compact.length, start + 150);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

function scoreEntry(entry, query, terms) {
  const title = normalize(entry.title);
  const text = normalize(`${entry.title} ${entry.kicker} ${entry.excerpt} ${entry.searchText ?? ''}`);
  if (!terms.every((term) => text.includes(term))) return -1;
  let score = 10;
  if (title === query) score += 220;
  else if (title.startsWith(query)) score += 120;
  else if (title.includes(query)) score += 70;
  score += terms.filter((term) => title.includes(term)).length * 28;
  score += Math.max(0, 20 - Math.floor(text.indexOf(terms[0]) / 40));
  return score;
}

const SEARCH_PAGE_MARKUP = `
  <div class="search-shell">
    <header class="search-hero">
      <div class="rules-eyebrow"><span></span> SEARCH · 全库检索</div>
      <h2 id="searchTitle">搜索知识库</h2>
      <p id="searchSummary">可检索素材、领域配方、规则章节与核心文档。</p>
    </header>
    <section class="search-results" id="searchResults" aria-live="polite"></section>
  </div>
`;

function ruleEntries(rulesPage, ruleNav) {
  return [...ruleNav.querySelectorAll('a')].map((link) => {
    const id = link.getAttribute('href')?.slice(1);
    const section = id ? rulesPage.querySelector(`#${CSS.escape(id)}`) : null;
    const title = link.childNodes[0]?.textContent?.trim() || section?.querySelector('h2')?.textContent || id;
    return {
      kind: 'rule',
      id,
      title,
      kicker: `规则 · ${link.querySelector('small')?.textContent ?? 'RULE MAP'}`,
      excerpt: section?.textContent ?? '',
      searchText: section?.textContent ?? '',
    };
  }).filter((entry) => entry.id);
}

function resultMarkup(result, index, terms) {
  return `<button class="search-result" type="button" data-search-result="${index}">
    <span class="search-result-kind ${result.kind}">${escapeHtml(result.kicker)}</span>
    <strong>${highlight(result.title, terms)}</strong>
    <p>${highlight(excerptAround(result.excerpt || result.searchText, terms), terms)}</p>
    <span class="search-result-arrow" aria-hidden="true">↗</span>
  </button>`;
}

export function mountKnowledgeSearch({ assets, recipes, documents, rulesPage, ruleNav, selectPage, navigate }) {
  const input = document.getElementById('knowledgeSearch');
  const clear = document.getElementById('knowledgeSearchClear');
  const page = document.getElementById('searchPage');
  if (!input || !clear || !page || !rulesPage || !ruleNav) return null;

  page.innerHTML = SEARCH_PAGE_MARKUP;
  const title = document.getElementById('searchTitle');
  const summary = document.getElementById('searchSummary');
  const results = document.getElementById('searchResults');
  if (!title || !summary || !results) return null;

  const entries = [
    ...assets.map((asset) => ({
      kind: 'asset',
      id: asset.key,
      title: asset.name,
      kicker: `素材 · ${asset.group || asset.category}`,
      excerpt: asset.note || asset.tags || asset.en,
      searchText: [asset.name, asset.en, asset.key, asset.group, asset.category, asset.tags, asset.note, asset.status].filter(Boolean).join(' '),
    })),
    ...recipes.map((recipe) => ({ kind: 'recipe', ...recipe })),
    ...ruleEntries(rulesPage, ruleNav),
    ...documents.map((document) => ({
      kind: 'document',
      id: document.id,
      title: document.title,
      kicker: `文档 · ${document.eyebrow}`,
      excerpt: `${document.summary} ${document.content}`,
      searchText: [document.title, document.eyebrow, document.summary, document.path, document.content].join(' '),
    })),
  ];
  let previousPage = document.body.dataset.page === 'search' ? 'assets' : document.body.dataset.page;
  let currentResults = [];

  const leaveSearch = () => {
    if (document.body.dataset.page === 'search') selectPage(previousPage || 'assets');
  };

  const render = () => {
    const query = normalize(input.value);
    clear.hidden = !query;
    if (!query) {
      results.innerHTML = '';
      leaveSearch();
      return;
    }
    if (document.body.dataset.page !== 'search') {
      previousPage = document.body.dataset.page;
      selectPage('search');
    }
    const terms = query.split(' ').filter(Boolean);
    currentResults = entries
      .map((entry) => ({ ...entry, score: scoreEntry(entry, query, terms) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, 80);
    title.textContent = `“${input.value.trim()}”`;
    summary.textContent = currentResults.length
      ? `找到 ${currentResults.length} 条结果 · 素材、配方、规则与文档统一检索`
      : '没有找到匹配内容，试试材料名、动作名、规则 ID 或文档主题。';
    results.innerHTML = currentResults.length
      ? currentResults.map((result, index) => resultMarkup(result, index, terms)).join('')
      : `<div class="search-empty"><span>∅</span><strong>没有匹配结果</strong><p>可以缩短关键词，或改用“木材”“工具”“纪元”“照护”等领域词。</p></div>`;
    page.scrollTop = 0;
  };

  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      render();
      input.blur();
    }
    if (event.key === 'Enter' && currentResults[0]) {
      input.value = '';
      clear.hidden = true;
      navigate(currentResults[0]);
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    render();
    input.focus();
  });
  results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-search-result]');
    const selected = button ? currentResults[Number(button.dataset.searchResult)] : null;
    if (!selected) return;
    input.value = '';
    clear.hidden = true;
    navigate(selected);
  });
  addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });

  return { focus: () => input.focus(), entries };
}
