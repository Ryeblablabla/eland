# ELAND 文档索引

`docs/` 同时保存当前协议、扩展设计和实验历史。三类文档的权威级别不同；文件日期新不等于运行时更权威。

发生冲突时依次以用户要求、`AGENTS.md`、当前可执行代码和测试为准。实验报告只说明当时冻结版本、种子、配置与矩阵，不自动描述当前行为。

## 当前规范

以下文档需要随代码持续更新，不得保留已被实现取代的伪接口：

| 文档 | 职责 |
| --- | --- |
| [ELAND 模块边界](../three-body/src/game/eland/README.md) | 当前模块、运行链和主要源码入口 |
| [规则优先人物架构](./rule-first-agent-architecture-v1.md) | 因果 BDI、人格 / 记忆 / 结果后验、本地规划器和可选模型的权威边界 |
| [人物特质](./person-traits-v1.md) | 十三种永久特质、固定先民配置、确定性遗传、随机异变与领域效果 |
| [月度时间模型](./monthly-time-model-v1.md) | 固定月份、15 tick、身体、关系、协议与月末提交 |
| [空间行动契约](./spatial-action-contract-v1.md) | 当前候选、意图、原子动作、执行顺序与 ActionFact |
| [体素世界](./pixel-world-v1.md) | 84×52×12 权威空间、v4 生成器、3D 投影、回放与分支 |
| [纪元、预言与生态](./three-body-era-ecology-v1.md) | 恒乱纪元、天气、休眠恢复和生态规则 |
| [文明指数](./civilization-index-v1.md) | 只读文明观察公式与阶段投影 |
| [能力里程碑因果链 v2](./capability-milestone-causal-chains-v2.md) | 当前能力观察器的严格因果链 |
| [能力里程碑观察器 v2](./capability-milestones-causal-observer-v2.md) | 当前里程碑目录、重投影与误报守卫 |
| [SQLite 持久化](./sqlite-persistence-v1.md) | 唯一事实库、表、codec、事务、回收和备份 |
| [玩家存档](./player-save-v1.md) | 手动存档、实时恢复和分支恢复产品语义 |
| [演化迭代协议](./evolution-iteration-loop-v1.md) | 可证伪假设、配对矩阵和实验接受规则 |
| [Agent CLI](./agent-cli-v1.md) | 面向 Agent 的 HTTP 调试、领域检查与实验矩阵命令 |

模型基础设施的当前边界另见 [模型端点路由](../three-body/design/model-endpoint-routing.md) 和 [非权威模型增强](../three-body/design/non-authoritative-model-enhancements.md)。

## 扩展设计

这些文档可以同时含有已实现机制和未来目标，必须在开头明确两者，不得让目标设计冒充运行时事实：

- [有限化身与逐刻度建造技术设计 v1](./limited-embodiment-technical-design-v1.md)：已实现第一人称局部操控、15 tick 暂存月份、真实移动 / 建造、恢复与交还自主；文档同时标明增量协议等后续边界。
- [涌现能力底座](./emergent-capability-substrate-v1.md)：规则扩展原则；冲突时以 `domain/` 和应用用例为准。
- [物质与文明能力演进](./material-era-progression-v1.md)：已实现至“现代文明（含信息能力）”的只读观察门槛；钢、混凝土、信号与计算等作为其内部后续能力设计。
- [一千项能力地图](./human-society-capability-map-1000.md)：观察坐标，不是科技树或人物目标。
- [最小涌现人物模型](../three-body/design/minimal-emergent-human-model.md)：核心物质—人物—动作模型及仍有价值的实现约束。

## 历史证据

以下内容保留是为了复核因果假设、失败样本、守卫和实验结论，不是为了维持旧接口：

- [v8–v33 历史迭代账本](./evolution-20-version-ledger.md)：冻结索引；表内状态是作出决定时的快照。
- [能力里程碑观察器 v1](./capability-milestones-causal-observer-v1.md)：已被 v2 取代，但含独有的旧矩阵和污染审计。
- [文明领地观察实验](./civilization-territory-v2-experiment-2026-08-15.md)。
- [古代文明桥接规则实验](./evolution-ancient-civilization-bridge-experiment-2026-08-22.md)：公共厅堂发起、铸造场承接、青铜工具采用与教学的三种子配对。
- [年轻信任与共同活动实验](./evolution-young-trust-ticks-experiment-2026-08-22.md)：按人格采用 3–5 刻度的定向关系积累和年轻信任加成。
- [生殖自主同意实验](./evolution-autonomous-reproduction-consent-experiment-2026-08-22.md)：移除固定生殖关系分数，以有来源候选、个人 appraisal 和明确可撤回协议取代。
- [BDI 项目满足与家庭准备度实验](./evolution-bdi-family-readiness-experiment-2026-08-22.md)：项目完成 episode、需要缓解、家庭准备度与生殖目标结果的三种子初步审计；结论为 `revise/preliminary`。
- [共同生活归属满足与十代连续性实验](./evolution-social-satiation-generation-10-experiment-2026-08-23.md)：已有共同生活连续满足归属需要、四种子 10/30/50/100 年矩阵与第 10 代权威出生链；十代可达性通过，跨种子稳定性结论为 `revise`。
- [文明高粮食停滞与时代断层修复实验](./evolution-civ61-stagnation-fixes-experiment-2026-08-22.md)：储备动机、动作投影、历史耕作门槛与铁器项目链的四项机制修复，以及三种子 10/30 年初步配对；群体结论为 `revise/preliminary`。
- [搜索耗尽项目重复重开实验](./evolution-project-reopen-churn-experiment-2026-08-22.md)：跨项目终局机会记忆、精确来源续证和建造假说重开约束的三种子 10/30 年配对；结论为 `accept/preliminary`。
- 所有 `evolution-*-experiment-YYYY-MM-DD.md`、`evolution-*-audit-YYYY-MM-DD.md`、带日期的长程报告与端到端复盘。
- `three-body/data/experiments/**/manifest.md` 和 `three-body/exports/**/SUMMARY.md` 等冻结运行旁证。

历史报告中的 `three-body/data/runs/<id>/*.json` 可能是 SQLite 切换前的真实路径。不要把它机械改写成当前接口；若文件已迁入 SQLite，在报告顶部说明迁移即可。

实验报告的状态必须是已经发生的事实，例如“接受”“拒绝”“按门槛停止”“历史矩阵未完成”。不允许永久保留没有负责人和运行任务的“进行中”“以后补跑”。需要复验时，以当前代码新建带日期的实验，不改写旧结论。

## Knowledge Base 镜像与生成数据

`knowledge-base/knowledge-docs.js` 是生成文件，不能手改。源文档清单在 `knowledge-base/scripts/sync-docs.mjs`；修改其中任一源文档后，从 `knowledge-base/` 运行：

```bash
npm run sync:docs
```

知识库“文档”页合订导入上表全部 14 份当前规范，不导入历史实验报告或扩展目标设计。新增、替换或废止当前规范时，应同时更新本索引和同步清单；生成后的页面数量可作为漏同步的快速检查，但不替代源码审计。

`knowledge-base/recipes-data.js` 同样是生成文件。它从 `material.ts`、`interaction-rules.ts` 与 `separation-rules.ts` 汇总组合、施力、暴露和分离四类当前合法物质操作；修改这些领域规则后，从 `knowledge-base/` 运行 `npm run sync:recipes`，不要直接修补生成数据。

`knowledge-base/rules-page.js` 不是生成镜像，而是当前规则树的手写静态导览。月度循环、项目链、模型边界或观察器边界变化时必须同步更新。

## 生命周期规则

- 当前规范与代码冲突：修正文档，不为旧文字回退代码。
- 旧规范被新规范完整覆盖、没有独有实验数据：直接删除，并更新所有引用。
- 重复摘要不含独有证据：删除；保留逐版报告和冻结账本中的唯一一份事实。
- 历史实验含独有种子、矩阵、失败样本或证据路径：保留，明确状态，不当作当前规范。
- 生成文件：只修改源并重新生成。
- 根目录 `README.md` 只保留玩家世界观与体验叙事，工程说明放在本索引、`AGENTS.md` 和对应模块 README。
