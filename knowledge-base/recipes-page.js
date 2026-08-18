import { RECIPE_KNOWLEDGE } from './recipes-data.js';

const TYPE_META = {
  combine: { label: '组合制作', eyebrow: 'COMBINE', description: '持有材料按数量组合，产物进入人物库存。' },
  exert: { label: '施力制作', eyebrow: 'EXERT', description: '使用特定工具，对材料与目标位置施力。' },
  expose: { label: '暴露转化', eyebrow: 'EXPOSE', description: '让材料接触火或设施，产生温度与冶炼转化。' },
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function colorOf(material) {
  return `rgb(${material.color.join(',')})`;
}

function materialToken(material, role = '') {
  return `<span class="material-token${role ? ` ${role}` : ''}" title="${escapeHtml(material.tags.join(' · '))}">
    <i style="--material-color:${colorOf(material)}"></i>
    <span>${escapeHtml(material.name)}</span>
    ${material.quantity > 1 ? `<b>× ${material.quantity}</b>` : ''}
  </span>`;
}

function formulaMarkup(recipe) {
  const inputs = recipe.inputs.map((material) => materialToken(material)).join('<span class="recipe-plus">＋</span>');
  const context = recipe.type === 'exert'
    ? `<div class="recipe-context"><span>工具</span>${recipe.tools.map((material) => materialToken(material, 'tool')).join('')}<span>作用于</span>${recipe.targets.map((material) => materialToken(material, 'target')).join('')}</div>`
    : recipe.type === 'expose'
      ? `<div class="recipe-context"><span>暴露于</span>${recipe.targets.map((material) => materialToken(material, 'target')).join('')}</div>`
      : '';
  return `${context}<div class="recipe-equation"><div class="recipe-inputs">${inputs}</div><span class="recipe-arrow" aria-hidden="true">→</span>${materialToken(recipe.output, 'output')}</div>`;
}

function summaryFor(recipe) {
  const inputs = recipe.inputs.map((item) => `${item.name}${item.quantity > 1 ? ` × ${item.quantity}` : ''}`).join('与');
  if (recipe.type === 'combine') return `${inputs}可结合为${recipe.output.name}${recipe.output.quantity > 1 ? ` × ${recipe.output.quantity}` : ''}`;
  if (recipe.type === 'exert') return `用${recipe.tools[0].name}向${recipe.inputs[0].name}施力，在${recipe.targets[0].name}处产生${recipe.output.name}`;
  return `让${recipe.inputs[0].name}暴露于${recipe.targets[0].name}，可得到${recipe.output.name}`;
}

function searchableText(recipe) {
  return [
    recipe.id,
    TYPE_META[recipe.type].label,
    recipe.output.name,
    recipe.output.key,
    ...recipe.inputs.flatMap((item) => [item.name, item.key, ...item.tags]),
    ...recipe.tools.flatMap((item) => [item.name, item.key, ...item.tags]),
    ...recipe.targets.flatMap((item) => [item.name, item.key, ...item.tags]),
    summaryFor(recipe),
  ].join(' ').toLocaleLowerCase('zh-CN');
}

const RECIPE_PAGE_MARKUP = `
  <div class="recipes-shell">
    <header class="recipes-hero">
      <div class="rules-eyebrow"><span></span> DOMAIN RECIPES · 当前可执行配方</div>
      <div class="recipes-hero-copy">
        <div>
          <h2>材料怎样变成<br>文明的下一件工具</h2>
          <p>这里直接展示领域层当前承认的组合、施力与暴露规则。它是代码生成的只读导览，不会向人物泄露隐藏配方；人物仍须通过可感知试验、学习或记录获得技术知识。</p>
        </div>
        <aside class="authority-note" aria-label="配方权威说明">
          <span class="authority-note-label">GENERATED VIEW</span>
          <strong>领域源码是唯一配方权威</strong>
          <p><code>material.ts</code> 定义物质，<code>interaction-rules.ts</code> 定义合法转化；运行同步脚本后，本页才更新。</p>
        </aside>
      </div>
      <div class="recipe-facts" aria-label="配方统计">
        <div><strong>${RECIPE_KNOWLEDGE.counts.recipes}</strong><span>全部配方</span></div>
        <div><strong>${RECIPE_KNOWLEDGE.counts.combine}</strong><span>组合制作</span></div>
        <div><strong>${RECIPE_KNOWLEDGE.counts.exert}</strong><span>施力制作</span></div>
        <div><strong>${RECIPE_KNOWLEDGE.counts.expose}</strong><span>暴露转化</span></div>
      </div>
    </header>

    <section class="recipe-workbench" id="recipeWorkbench" aria-labelledby="recipeWorkbenchTitle">
      <div class="recipe-toolbar">
        <div>
          <span class="section-kicker">RECIPE INDEX</span>
          <h2 id="recipeWorkbenchTitle">配方索引</h2>
        </div>
        <label class="recipe-filter">
          <span aria-hidden="true">⌕</span>
          <input id="recipeFilter" type="search" autocomplete="off" placeholder="筛选材料、产物或规则 ID" aria-label="筛选配方">
          <kbd>/</kbd>
        </label>
      </div>
      <div class="recipe-type-filters" role="group" aria-label="配方类型">
        <button type="button" class="active" data-recipe-type="all">全部</button>
        ${Object.entries(TYPE_META).map(([type, meta]) => `<button type="button" data-recipe-type="${type}">${meta.label}</button>`).join('')}
        <span id="recipeCount" aria-live="polite"></span>
      </div>
      <div class="recipe-grid" id="recipeGrid"></div>
      <div class="recipe-empty" id="recipeEmpty" hidden>
        <strong>没有匹配的配方</strong>
        <p>试试产物名、原料名，或 <code>smelt</code>、<code>assemble</code> 这样的规则 ID。</p>
      </div>
    </section>

    <footer class="rules-footer"><span>ELAND KB · RECIPE MAP</span><p>同步命令：<code>npm run sync:recipes</code> · 数据来自当前领域源码。</p></footer>
  </div>
`;

function cardMarkup(recipe) {
  const meta = TYPE_META[recipe.type];
  return `<article class="recipe-card" id="recipe-${escapeHtml(recipe.id)}" data-recipe-id="${escapeHtml(recipe.id)}" data-recipe-type="${recipe.type}">
    <header>
      <span class="recipe-kind ${recipe.type}">${meta.eyebrow}</span>
      <code>${escapeHtml(recipe.id)}</code>
    </header>
    <h3>${escapeHtml(recipe.output.name)}</h3>
    <p>${escapeHtml(summaryFor(recipe))}</p>
    <div class="recipe-formula">${formulaMarkup(recipe)}</div>
  </article>`;
}

export function recipeSearchRecord(recipe) {
  return {
    id: recipe.id,
    title: recipe.output.name,
    kicker: `配方 · ${TYPE_META[recipe.type].label}`,
    excerpt: summaryFor(recipe),
    searchText: searchableText(recipe),
  };
}

export function mountRecipeLibrary() {
  const page = document.getElementById('recipesPage');
  const nav = document.getElementById('recipeNav');
  if (!page || !nav) return null;

  page.innerHTML = RECIPE_PAGE_MARKUP;
  const grid = document.getElementById('recipeGrid');
  const filter = document.getElementById('recipeFilter');
  const count = document.getElementById('recipeCount');
  const empty = document.getElementById('recipeEmpty');
  const typeButtons = [...document.querySelectorAll('[data-recipe-type]')];
  const navButtons = [...nav.querySelectorAll('[data-recipe-nav]')];
  if (!grid || !filter || !count || !empty) return null;

  grid.innerHTML = RECIPE_KNOWLEDGE.recipes.map(cardMarkup).join('');
  const cards = [...grid.querySelectorAll('.recipe-card')];
  let activeType = 'all';

  const applyFilters = () => {
    const terms = filter.value.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
    let visible = 0;
    RECIPE_KNOWLEDGE.recipes.forEach((recipe, index) => {
      const typeMatch = activeType === 'all' || recipe.type === activeType;
      const queryMatch = terms.every((term) => searchableText(recipe).includes(term));
      const show = typeMatch && queryMatch;
      cards[index].hidden = !show;
      if (show) visible += 1;
    });
    count.textContent = `${visible} / ${RECIPE_KNOWLEDGE.counts.recipes}`;
    empty.hidden = visible !== 0;
  };

  const selectType = (type, scroll = false) => {
    activeType = type in TYPE_META ? type : 'all';
    typeButtons.forEach((button) => {
      const active = button.dataset.recipeType === activeType;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    navButtons.forEach((button) => {
      const active = button.dataset.recipeNav === activeType;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    applyFilters();
    if (scroll) document.getElementById('recipeWorkbench')?.scrollIntoView({ block: 'start' });
  };

  const selectRecipe = (id, updateHash = true) => {
    const recipe = RECIPE_KNOWLEDGE.recipes.find((item) => item.id === id);
    if (!recipe) return false;
    filter.value = '';
    selectType('all');
    const card = document.getElementById(`recipe-${CSS.escape(id)}`);
    requestAnimationFrame(() => {
      card?.scrollIntoView({ block: 'center' });
      card?.classList.remove('spotlight');
      requestAnimationFrame(() => card?.classList.add('spotlight'));
    });
    if (updateHash) history.replaceState(null, '', `#recipe-${id}`);
    return true;
  };

  typeButtons.forEach((button) => button.addEventListener('click', () => selectType(button.dataset.recipeType, true)));
  filter.addEventListener('input', applyFilters);
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && filter.value) {
      filter.value = '';
      applyFilters();
    }
  });
  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-recipe-nav]');
    if (button) selectType(button.dataset.recipeNav, true);
  });
  page.addEventListener('keydown', (event) => {
    if (event.key === '/' && event.target !== filter) {
      event.preventDefault();
      filter.focus();
    }
  });

  selectType('all');
  return { selectRecipe, selectType, recipes: RECIPE_KNOWLEDGE.recipes };
}
