# ELAND 文档索引

`docs/` 同时保存当前协议、扩展设计和实验历史。三类文档的权威级别不同；文件日期新不等于运行时更权威。

发生冲突时依次以用户要求、`AGENTS.md`、当前可执行代码和测试为准。实验报告只说明当时冻结版本、种子、配置与矩阵，不自动描述当前行为。

## 当前规范

以下文档需要随代码持续更新，不得保留已被实现取代的伪接口：

| 文档 | 职责 |
| --- | --- |
| [ELAND 模块边界](../three-body/src/game/eland/README.md) | 当前模块、运行链和主要源码入口 |
| [规则优先人物架构](./rule-first-agent-architecture-v1.md) | 因果 BDI、人格 / 记忆 / 结果后验、本地规划器和可选模型的权威边界 |
| [统一人物记忆 v1](./unified-agent-memory-v1.md) | 六类主观记忆、统一决策语言、逐人传播噪声、解释驱动回应与压缩模糊遗忘 |
| [人物 Prompt Contract v2](./agent-prompt-contract-v2.md) | Decision / Voice / Player Conversation 的权威分工、Character Card、Scene Contract 和人工真实感审阅 |
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

- [Steam 桌面发行路线 v1](./steam-desktop-release-roadmap-v1.md)：未来以 Electron / Electron Forge 构建 Windows x64 与 macOS universal 双平台包，接入独立 Steam depot 的目标架构、里程碑和验收标准；当前尚未实现。
- [有限化身与逐刻度建造技术设计 v1](./limited-embodiment-technical-design-v1.md)：已实现第一人称局部操控、15 tick 暂存月份、真实移动 / 建造、恢复与交还自主；文档同时标明增量协议等后续边界。
- [涌现能力底座](./emergent-capability-substrate-v1.md)：规则扩展原则；冲突时以 `domain/` 和应用用例为准。
- [物质与文明能力演进](./material-era-progression-v1.md)：已实现至“现代文明（含信息能力）”的只读观察门槛；钢、混凝土、信号与计算等作为其内部后续能力设计。
- [一千项能力地图](./human-society-capability-map-1000.md)：观察坐标，不是科技树或人物目标。
- [最小涌现人物模型](../three-body/design/minimal-emergent-human-model.md)：核心物质—人物—动作模型及仍有价值的实现约束。

## 历史证据

当前工作树只保留紧凑历史与仍在使用的近期报告，避免旧实验在检索和 Agent 上下文中反复冒充当前事实：

- [v8–v33 历史迭代账本](./evolution-20-version-ledger.md)：冻结结论表；状态是当时的决定快照。
- [2026-09-01 前实验归档索引](./evolution-experiment-archive.md)：列出已从工作树移除的逐轮报告及恢复方法；全文仍在 Git 历史中。
- [能力里程碑观察器 v1](./capability-milestones-causal-observer-v1.md)：已被 v2 取代，但含独有的旧矩阵和污染审计。
- [人物真实对话与长期关切人工审阅](./agent-dialogue-agenda-human-review-2026-08-30.md)：最新 prompt 单世界 60 月人工审阅；结论为 `revise`。
- [耕地扩展、人物行动与关系记忆实验](./evolution-cultivation-and-dialogue-memory-experiment-2026-09-01.md)：当前 v90j 多时长矩阵与因果收口。
- [创世原型人格与经历叠层实验](./evolution-founder-persona-experience-experiment-2026-09-01.md)：当前人格先验、experience 与人格化召回实验。

历史报告中的 `three-body/data/runs/<id>/*.json` 可能是 SQLite 切换前的真实路径。它们是当时的证据标识，不代表当前存储协议。需要复验时，以当前代码新建带日期的实验，不改写旧结论。

## Knowledge Base 镜像与生成数据

`knowledge-base/knowledge-docs.js` 是生成文件，不能手改。源文档清单在 `knowledge-base/scripts/sync-docs.mjs`；修改其中任一源文档后，从 `knowledge-base/` 运行：

```bash
npm run sync:docs
```

知识库“文档”页合订导入上表全部 16 份当前规范，不导入历史实验报告或扩展目标设计。新增、替换或废止当前规范时，应同时更新本索引和同步清单；生成后的页面数量可作为漏同步的快速检查，但不替代源码审计。

`knowledge-base/recipes-data.js` 同样是生成文件。它从 `material.ts`、`interaction-rules.ts` 与 `separation-rules.ts` 汇总组合、施力、暴露和分离四类当前合法物质操作；修改这些领域规则后，从 `knowledge-base/` 运行 `npm run sync:recipes`，不要直接修补生成数据。

`knowledge-base/rules-page.js` 不是生成镜像，而是当前规则树的手写静态导览。月度循环、项目链、模型边界或观察器边界变化时必须同步更新。

## 生命周期规则

- 当前规范与代码冲突：修正文档，不为旧文字回退代码。
- 旧规范被新规范完整覆盖、没有独有实验数据：直接删除，并更新所有引用。
- 重复摘要不含独有证据：删除，只保留一份当前说明。
- 已收口实验：把假设、矩阵、决定、失败样本和证据标识压入冻结账本或归档索引，逐轮全文从工作树删除；需要时从 Git 历史或外部产物库恢复。
- 当前实验：只保留仍参与本轮判断的报告；收口后进入上述压缩流程，不永久积累带日期的逐轮文档。
- 生成文件：只修改源并重新生成。
- 根目录 `README.md` 只保留玩家世界观与体验叙事，工程说明放在本索引、`AGENTS.md` 和对应模块 README。
