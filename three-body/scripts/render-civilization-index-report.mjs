#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [baselineArg, candidateArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !candidateArg || !outputArg) {
  throw new Error('usage: render-civilization-index-report BASELINE_JSON CANDIDATE_JSON OUTPUT_HTML');
}

const [baseline, candidate] = await Promise.all([
  readFile(resolve(baselineArg), 'utf8').then(JSON.parse),
  readFile(resolve(candidateArg), 'utf8').then(JSON.parse),
]);

const horizons = candidate.experiment.years;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const fixed = (value, digits = 2) => Number(value).toFixed(digits);
const group = (matrix, years) => matrix.runs.filter((run) => run.years === years);
const componentMean = (matrix, years, key) => mean(group(matrix, years).map((run) => Number(run.civilizationComponents[key] ?? 0)));
const evidenceMean = (years, component, key) => mean(group(candidate, years)
  .map((run) => Number(run.civilizationEvidence?.[component]?.[key] ?? 0)));
const count = (years, predicate) => group(candidate, years).filter(predicate).length;

const stageCounts = Object.fromEntries(horizons.map((years) => [years,
  group(candidate, years).reduce((counts, run) => {
    const stage = run.civilizationStage ?? '未知';
    counts[stage] = (counts[stage] ?? 0) + 1;
    return counts;
  }, {}),
]));

const aggregateRows = horizons.map((years) => ({
  years,
  baselineTotal: mean(group(baseline, years).map((run) => Number(run.civilizationIndex ?? 0))),
  candidateTotal: mean(group(candidate, years).map((run) => Number(run.civilizationIndex ?? 0))),
  baselineT: componentMean(baseline, years, 'territory'),
  candidateT: componentMean(candidate, years, 'territory'),
  baselineS: componentMean(baseline, years, 'social'),
  candidateS: componentMean(candidate, years, 'social'),
  capped25: count(years, (run) => run.civilizationEvidence?.territory?.territoryCap === 25),
  capped55: count(years, (run) => run.civilizationEvidence?.territory?.territoryCap === 55),
  stages: stageCounts[years],
}));

const evidenceRows = horizons.map((years) => ({
  years,
  cognitive: evidenceMean(years, 'territory', 'cognitiveCells'),
  trace: evidenceMean(years, 'territory', 'traceCells'),
  incomplete: evidenceMean(years, 'territory', 'incompleteStructureCells'),
  structures: evidenceMean(years, 'territory', 'functionalStructures'),
  capacity: evidenceMean(years, 'territory', 'functionalCapacityScore'),
  sites: evidenceMean(years, 'territory', 'functionalSites'),
  sustained: evidenceMean(years, 'territory', 'sustainedFunctionalSites'),
  routes: evidenceMean(years, 'territory', 'logisticsRoutes'),
}));

const selfDyadRows = horizons.map((years) => ({
  years,
  relations: evidenceMean(years, 'social', 'relationDyads'),
  interactions: evidenceMean(years, 'social', 'interactionDyads'),
  oldS: componentMean(baseline, years, 'social'),
  newS: componentMean(candidate, years, 'social'),
}));

const stageText = (stages) => Object.entries(stages).map(([stage, total]) => `${stage} ${total}`).join(' / ');
const bars = (key, oldKey, color) => aggregateRows.map((row) => {
  const oldValue = row[oldKey];
  const value = row[key];
  return `<div class="bar-row"><span>${row.years} 年</span><div class="tracks"><i class="old" style="width:${oldValue}%"></i><i style="width:${value}%;background:${color}"></i></div><b>${fixed(oldValue, 1)} → ${fixed(value, 1)}</b></div>`;
}).join('');

const aggregateTable = aggregateRows.map((row) => `<tr>
  <td>${row.years} 年</td><td>${fixed(row.baselineTotal)} → ${fixed(row.candidateTotal)}</td>
  <td>${fixed(row.baselineT)} → ${fixed(row.candidateT)}</td>
  <td>${fixed(row.baselineS)} → ${fixed(row.candidateS)}</td>
  <td>${row.capped25} / ${row.capped55}</td><td>${stageText(row.stages)}</td>
</tr>`).join('');

const evidenceTable = evidenceRows.map((row) => `<tr><td>${row.years} 年</td><td>${fixed(row.cognitive, 1)}</td><td>${fixed(row.trace, 1)}</td><td>${fixed(row.incomplete, 1)}</td><td>${fixed(row.structures, 1)}</td><td>${fixed(row.capacity, 1)}</td><td>${fixed(row.sites, 1)}</td><td>${fixed(row.sustained, 1)}</td><td>${fixed(row.routes, 1)}</td></tr>`).join('');
const socialTable = selfDyadRows.map((row) => `<tr><td>${row.years} 年</td><td>${fixed(row.relations, 1)}</td><td>${fixed(row.interactions, 1)}</td><td>${fixed(row.oldS)} → ${fixed(row.newS)}</td></tr>`).join('');
const endedEarly = candidate.runs.filter((run) => run.endedEarly).length;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ELAND 文明指数 · 功能疆域校准</title>
<style>
:root{color-scheme:dark;--bg:#090b0a;--panel:#121512;--line:#2b312b;--text:#eef2e9;--muted:#a2aa9e;--green:#9fce72;--amber:#e6b968;--blue:#78adca}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#1a2519 0,transparent 34rem),var(--bg);color:var(--text);font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.shell{width:min(1120px,calc(100% - 36px));margin:auto}header{padding:64px 0 34px;border-bottom:1px solid var(--line)}.eyebrow{color:var(--green);font-size:12px;font-weight:800;letter-spacing:.15em}h1{max-width:850px;margin:10px 0 18px;font:500 clamp(38px,7vw,72px)/1.03 ui-serif,Georgia,"Songti SC",serif;letter-spacing:-.045em}header p{max-width:780px;color:#c7cec2;font-size:18px}.meta,.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.meta{margin-top:28px}.card,section{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:16px}.card{padding:18px}.card strong{display:block;font-size:28px;color:var(--green)}.card span,.note{color:var(--muted)}main{padding:34px 0 80px}section{padding:24px;margin:0 0 18px}h2{margin:0 0 8px;font-size:22px}h3{font-size:14px;color:var(--muted);font-weight:600}.charts{display:grid;grid-template-columns:1fr 1fr;gap:22px}.bar-row{display:grid;grid-template-columns:42px 1fr 105px;gap:10px;align-items:center;margin:11px 0}.bar-row b{font-size:12px;text-align:right}.tracks{position:relative;height:13px;background:#202520;border-radius:999px;overflow:hidden}.tracks i{position:absolute;inset:0 auto 0 0;border-radius:999px}.tracks .old{height:3px;top:5px;background:#737b72;z-index:2}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{padding:11px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}.callout{border-left:3px solid var(--green);padding-left:16px;color:#d7ddd3}.rules{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.rule{padding:14px;background:#171b17;border-radius:12px}.rule b{display:block;color:var(--amber);margin-bottom:4px}@media(max-width:760px){.meta,.grid,.charts,.rules{grid-template-columns:1fr}.table-wrap{overflow:auto}header{padding-top:42px}}
</style></head><body><header><div class="shell"><div class="eyebrow">MATCHED MATRIX · 2026-08-15</div><h1>从“走过多少”改成“真正拥有多少”</h1><p>同一组 6101–6110 seeds、10/20/30 年终点的新矩阵。候选指数从刚跑出的权威状态重新投影；没有读取旧报告，也没有让指数反向影响人物行为。</p><div class="meta"><div class="card"><strong>${candidate.runs.length}</strong><span>个新终局 · 10 seeds × 3 时长</span></div><div class="card"><strong>逐项一致</strong><span>代表 seed 的世界与历史对照</span></div><div class="card"><strong>${endedEarly}</strong><span>个真实提前终止样本</span></div></div></div></header>
<main class="shell"><section><h2>结果先看</h2><p class="callout">新 T 不再奖励历史遗迹永久累计。完整功能容量成为主分，脚印、土路和未完工结构只留低权重；没有功能据点或成熟网络时会被阶段封顶。社会分同时剔除了自我互动对。</p><div class="charts"><div><h3>T · 旧探索改造 → 新功能疆域</h3>${bars('candidateT','baselineT','var(--green)')}</div><div><h3>S · 原统计 → 过滤自我互动</h3>${bars('candidateS','baselineS','var(--blue)')}</div></div></section>
<section><h2>10 / 20 / 30 年聚合</h2><div class="table-wrap"><table><thead><tr><th>终点</th><th>总分 均值</th><th>T 均值</th><th>S 均值</th><th>T 封顶 25 / 55</th><th>候选阶段分布</th></tr></thead><tbody>${aggregateTable}</tbody></table></div><p class="note">箭头左侧为同批新历史上的旧观察器，右侧为功能疆域观察器。其他引擎指标不变。</p></section>
<section><h2>T 到底在看什么</h2><div class="table-wrap"><table><thead><tr><th>终点</th><th>认知格</th><th>低级痕迹</th><th>未完工格</th><th>功能结构</th><th>容量分</th><th>功能据点</th><th>持续据点</th><th>物流线</th></tr></thead><tbody>${evidenceTable}</tbody></table></div></section>
<section><h2>阶段门槛</h2><div class="rules"><div class="rule"><b>没有功能据点</b>T 最多 25；不能仅靠行走和遗迹成为技术聚落。</div><div class="rule"><b>没有成熟疆域网络</b>只有一个未持续使用的据点且无物流路线时，T 最多 55。</div><div class="rule"><b>持续据点</b>至少存在 12 个月，并有跨 6 个月的两个使用月份。</div><div class="rule"><b>物流路线</b>当前仍有至少 4 格相连夯土，连接至少两个功能据点，并在近 36 月的 3 个不同月份被使用。</div></div></section>
<section><h2>社会统计修正</h2><div class="table-wrap"><table><thead><tr><th>终点</th><th>有效关系对</th><th>有效互动对</th><th>S 均值</th></tr></thead><tbody>${socialTable}</tbody></table></div><p class="note">关系、定向沟通、对人行动均排除行动者与自身形成的 pair；繁衍关系不因此变成制度分。</p></section>
<section><h2>实验边界</h2><p>这是观察器校准，不是行为规则实验。基准端确实重新运行了全部 30 个终局；代表性候选复跑确认事件、人物、项目、协议、记录、共同体、权限、容器、体素世界、掉落物、动物、派生观察和时钟完全一致。因此剩余候选使用刚生成终局做确定性重投影，避免重复计算同一段历史。</p><p class="note">基准：${baseline.experiment.prefix}<br>候选：${candidate.experiment.prefix}<br>生成：${candidate.generatedAt}</p></section></main></body></html>`;

const outputPath = resolve(outputArg);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, 'utf8');
process.stdout.write(`wrote ${outputPath}\n`);
