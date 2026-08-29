/* ELAND 官网共享脚本：注入统一导航与页脚。
   每个页面设置 <body data-site-page="home|codex|tech|presskit|privacy">。 */
(function () {
  const page = document.body.dataset.sitePage || '';
  const nav = document.createElement('header');
  nav.className = 'site-nav';
  nav.innerHTML = `
    <a class="brand" href="./" aria-label="ELAND 首页">
      <span class="suns" aria-hidden="true"><i></i><i></i><i></i></span>
      ELAND<small>三体文明模拟</small>
    </a>
    <nav class="links" aria-label="官网导航">
      <a href="./" data-nav="home">首页</a>
      <a href="./codex.html" data-nav="codex">世界图鉴</a>
      <a href="./codex.html#rules" data-nav="rules">规则导览</a>
      <a href="./tech.html" data-nav="tech">技术架构</a>
      <a href="./presskit.html" data-nav="presskit">Press Kit</a>
      <a class="cta" href="./presskit.html#wishlist">Steam 愿望单</a>
    </nav>`;
  document.body.prepend(nav);
  const spacer = document.createElement('div');
  spacer.className = 'site-nav-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  nav.after(spacer);
  nav.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === page) link.classList.add('active');
  });

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  if (document.body.hasAttribute('data-site-nofooter')) return;
  footer.innerHTML = `
    <div class="cols">
      <div>
        <div class="brandline">ELAND</div>
        <p class="tagline">规则优先的涌现式文明模拟。文明在恒纪元与乱纪元之间生长，
          每一段历史都由真实模拟产生——没有写好的剧本。</p>
      </div>
      <div>
        <h4>世界</h4>
        <a href="./codex.html#assets">素材图鉴</a>
        <a href="./codex.html#recipes">物质配方</a>
        <a href="./codex.html#rules">规则导览</a>
        <a href="./codex.html#docs">核心文档</a>
      </div>
      <div>
        <h4>开发</h4>
        <a href="./tech.html">技术架构</a>
        <a href="./presskit.html">Press Kit</a>
        <a href="./privacy.html">隐私政策</a>
      </div>
      <div>
        <h4>社区</h4>
        <a href="#" title="筹备中">哔哩哔哩（筹备中）</a>
        <a href="#" title="筹备中">Discord（筹备中）</a>
        <a href="#" title="筹备中">玩家 QQ 群（筹备中）</a>
      </div>
    </div>
    <div class="bottom">
      <span>© 2026 ELAND Team · 开源 · 规则优先</span>
      <span class="seal">图鉴与规则页数据<b>由真实生产代码同步生成</b>，不与游戏实现脱节</span>
    </div>`;
  document.body.append(footer);
})();
