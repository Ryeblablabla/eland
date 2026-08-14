# ELAND 模块边界

这里采用单一领域内的分层结构，依赖方向始终朝向领域模型：

```text
UI / HTTP / optional model infrastructure
              ↓
adapter / application use case
              ↓
domain model and policies
              ↓
world grid primitives
```

## 目录地图

### world/ —— 世界基元

- `world/grid.ts`：84×52×12 体素世界、cellId/voxelIndex 索引、邻接、通行与 A*。
- `world/generator.ts`：只负责生成初始自然事实与出生格。

### domain/ —— 领域模型与规则

- `domain/model.ts`：`SimulationState` 聚合根（体素世界、掉落物、动物、人物、意图、协议、共同体、权限、容器、纪元预言、文明指数与派生观察）。
- `domain/person.ts`：人物权威状态（三项身体储备、过程状态、体素位置、私有背包、知识）。
- `domain/material.ts`：物质定义与调色板。
- `domain/action.ts`：五种原子动作、九种 `SourceOperation`、`WorldRef` 与 `Intent` 类型。
- `domain/intent.ts`：意图选择的组装与校验。
- `domain/action-executor.ts`：原子动作的预演与执行。
- `domain/calendar.ts`：唯一的月历换算规则（`PLANNING_TICKS_PER_MONTH = 15`）。
- `domain/survival-reflex.ts`：不消耗模型额度的吃、喝与紧急避险反射。
- `domain/shelter-access.ts`：从可见或记得的真实结构中寻找当前仍可达的住所内部。
- `domain/water-access.ts`：真实水体素的可达性与取水规则。
- `domain/separation-rules.ts`：定义体素物质如何通过同一 `separate` 原语被采出或拆回。
- `domain/container.ts`：有体素位置和内部物品堆的空间持有者；本身不预设所有权。
- `domain/dependent-care.ts`：幼儿不能独立完成的紧急携带与食物转移，不替代长期家庭意图。
- `domain/structure.ts`：从可站立空气、头顶实体与侧向围护的真实体素拓扑计算结构效果。
- `domain/memory.ts`：固定预算的情节、对话、承诺和失败记忆，负责遗忘与摘要。
- `domain/spatial-knowledge.ts`、`domain/interaction-knowledge.ts`：人物的空间知识与交互/技术知识。
- `domain/interaction-rules.ts`：物质响应原语的数据驱动规则（`InteractionRule`）。
- `domain/monthly-processes.ts`：无人行动也推进的世界过程：气候与纪元、预言结算、身体结算、动物生态。
- `domain/animal.ts`：动物实体的位置、身体、繁殖与行为。
- `domain/kinship.ts`：由出生事实派生的亲缘距离与遗传风险；只影响结果，不禁止动作。
- `domain/agreement.ts`、`domain/collective.ts`、`domain/permission.ts`、`domain/governance.ts`、`domain/declaration.ts`、`domain/record.ts`、`domain/social-facts.ts`、`domain/relation.ts`：协议、共同体、授权、治理规则、声明、实体记录、社会事实与定向关系账本。
- `domain/civilization-index.ts`：文明指数纯观察投影，不反向解锁能力。
- `domain/decision-budget.ts`：迁移期模型用量兼容结构；不得决定人物是否获得本地规划。
- `domain/event-index.ts`：事件流查询索引。

### application/ —— 用例

- `application/monthly-simulation.ts`：创建文明、执行每月 15 个规划刻度、状态迁移、恢复状态和生成报告；含一部分里程碑观察器。
- `application/rule-planner.ts`：每个规划刻度始终可用的正式本地目标选择器。
- `application/action-options.ts`、`construction-options.ts`、`container-options.ts`、`separation-options.ts`、`social-options.ts`：各类合法可供性候选的生成。
- `application/agreement-continuation.ts`：已接受协议的履约推进。

### projection/ —— 只读观察

- `projection/core-milestones.ts`：纯可回放的能力里程碑观察器；事实不反向进入人物决策。

### 根级

- `character-profiles.ts`：人物档案池；开局按种子抽取 5–8 位或由配置指定。
- `population.ts`：开局年龄与寿命的确定性采样。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影。
- `kimi-decider.ts`：前端既有 Kimi 交互路径（暂留，后续迁移为异步模型任务）。
- `simulation.ts`：供其他层依赖的稳定公共门面。

本地规划器是服务端人物行动权威。模型只能异步提出稳定语义的长期建议、玩家交互或创造性/叙事文本，不能选择临时 option ID 或直接修改聚合根。意图的原子动作由规则引擎编译、预演、修复和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。
