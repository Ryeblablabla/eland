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
- `domain/intent-follow-up.ts`：生活对话开场与后续物理行动的共同人物、项目或来源事实校验。
- `domain/action-executor.ts`：原子动作的预演与执行；生殖协议一次只授权一次尝试；亲代移动只携带同处、清醒且未满 1 岁的婴儿，休眠者不会隐式换位。
- `domain/calendar.ts`：唯一的月历换算规则（`PLANNING_TICKS_PER_MONTH = 15`）。
- `domain/era-prediction.ts`：可行动的乱纪元预言窗口、听众信任门槛与休眠 / 唤醒的局部判断。
- `domain/life-stage.ts`：按月龄划分未满 1 岁完全依赖、1–11 岁受限自主、12–15 岁既有项目协作与 16 岁以上完整规划。
- `domain/survival-reflex.ts`：不消耗模型额度的吃、喝与紧急避险反射。
- `domain/shelter-access.ts`：从可见或记得的真实结构中寻找当前仍可达的住所内部。
- `domain/water-access.ts`：真实水体素的可达性与取水规则。
- `domain/separation-rules.ts`：定义体素物质如何通过同一 `separate` 原语被采出或拆回。
- `domain/container.ts`：有体素位置和内部物品堆的空间持有者；本身不预设所有权。
- `domain/dependent-care.ts`：12 岁以下同地儿童的紧急照护、食物转移和脱水保护，并把本人记得的亲生未成年子女与眼前危机编译为生殖责任压力；不替代长期家庭意图，也不赋予同步移动。
- `domain/population-capacity.ts`：50 人软承载附近的受孕概率衰减与超载资源竞争；它是身体 / 生态约束，不进入人物目标或文明指数。
- `domain/structure.ts`：从可站立空气、头顶实体与侧向围护的真实体素拓扑计算结构效果。
- `domain/memory.ts`：固定预算的情节、对话、承诺和失败记忆，负责遗忘与摘要。
- `domain/spatial-knowledge.ts`、`domain/interaction-knowledge.ts`：人物的空间知识与交互/技术知识。
- `domain/interaction-rules.ts`：物质响应原语的数据驱动规则（`InteractionRule`）。
- `domain/monthly-processes.ts`：无人行动也推进的世界过程：气候与纪元、预言结算、妊娠 / 产后恢复等身体结算、动物生态，以及月初月末同处且无直接伤害配对的可追溯关系经验。
- `domain/animal.ts`：动物实体的位置、身体、繁殖与行为。
- `domain/kinship.ts`：由出生事实派生的亲缘距离与遗传风险；只影响结果，不禁止动作。
- `domain/agreement.ts`、`domain/collective.ts`、`domain/permission.ts`、`domain/governance.ts`、`domain/declaration.ts`、`domain/record.ts`、`domain/social-facts.ts`、`domain/relation.ts`：协议、共同体、授权、治理规则、声明、实体记录、社会事实与定向关系账本。
- `domain/civilization-index.ts`：文明指数纯观察投影，不反向解锁能力。
- `domain/decision-budget.ts`：实时关键重选的人月额度与 endpoint / token 审计；不得决定人物是否获得本地规划。
- `domain/event-index.ts`：事件流查询索引。
- `domain/personality.ts`：HEXACO 六维初始化、有效值、行动证据与月末慢速变化；人格只调节已有合法候选。

### application/ —— 用例

- `application/monthly-simulation.ts`：创建文明、执行每月 15 个规划刻度、状态迁移、恢复状态和生成报告；含一部分里程碑观察器。
- `application/rule-planner.ts`：每个规划刻度始终可用的正式本地目标选择器。
- `application/decision-factor-forest.ts`：八棵可解释因果树的投票排序；每棵树输出理由与来源，稳定随机值只破同分。
- `application/age-planning.ts`：按生命周期过滤简单劳动、项目发起、社会协议与繁衍候选。
- `application/action-options.ts`、`construction-options.ts`、`container-options.ts`、`separation-options.ts`、`social-options.ts`：各类合法可供性候选的生成。
- `application/agreement-continuation.ts`：已接受协议的履约推进。

### projection/ —— 只读观察

- `projection/capability-milestones.ts`：v2 纯可回放因果观察器；含 120 个精确地图坐标和 17 个 world-specific 复杂事件，并以 strict/guarded、阶段门槛和完整 episode 隔离误报，事实不反向进入人物决策。
- `projection/core-milestones.ts`：旧 numeric-ID 观察规则，保留作迁移参考；运行时投影已由 capability observer 接管。

### 根级

- `character-profiles.ts`：人物档案池；开局按种子抽取 5–8 位或由配置指定。
- `population.ts`：开局年龄与寿命的确定性采样。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影。
- `kimi-decider.ts`：实时关键决策发送给通用模型端点的局部事实 DTO；历史文件名保留，但不再绑定 Kimi 供应商。
- `simulation.ts`：供其他层依赖的稳定公共门面。

本地规划器是服务端人物行动权威，并在任何模型请求前先生成完整回退决定。模型设置页（`M`）选择模型演进并显式配置 `decision` 路由后，实时会话只把必须回应、生活对话、空闲人物新方向、项目停滞或状态复核等少量上下文交给模型；选择本地演进时直接采用规则决定。开局、生存危险、既定履约和后台快速演化始终只走本地规则。模型只能在当前合法 option 中重选并补充人物话语，领域层会重新验证强制回应、复合对话的后续行动和意图组合；临时 option ID 只留在 DecisionFact 审计中，长期意图保存规则目标而不是模型文本。文明历史先由规则层筛出出生、死亡、关键技术、项目完成等重大事件；选择模型总结时再调用 `narrative` 路由压缩本月纪事，选择本地总结时直接保留规则文本。没有重大事件的月份不产出、不调用模型，请求或校验失败时也保留规则文本。赶路、搬运、吃饭和普通失败只留在人物个人记录。意图的原子动作仍由规则引擎编译、预演、修复和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。

乱纪元与恒纪元的每次真实切换都是文明历史的最高优先级事件，投影必须同时说明哪个纪元结束、哪个纪元开始。这组更迭事实由规则文本直接进入历史，不传给模型；同月其他重大事件的模型概括也会另外保留。

服务端模型配置与 `ollama-chat / openai-chat / openai-responses / anthropic-messages` 路由见 [`../../../design/model-endpoint-routing.md`](../../../design/model-endpoint-routing.md)。
