# ELAND 模块边界

这里采用单一领域内的分层结构，依赖方向始终朝向领域模型：

```text
UI / HTTP / LLM infrastructure
              ↓
adapter / application use case
              ↓
domain model and policies
              ↓
world grid primitives
```

- `domain/model.ts`：人物、意图、物质、结构、事件与 `SimulationState` 聚合根。
- `domain/survival-reflex.ts`：不消耗模型额度的吃、喝与紧急求生反射。
- `domain/dependent-care.ts`：幼儿不能独立完成的紧急携带与食物转移，不替代长期家庭意图。
- `domain/memory.ts`：固定预算的情节、对话、承诺和失败记忆，负责遗忘与摘要。
- `application/social-options.ts`：会合、求助、结伴和对话响应候选。
- `domain/calendar.ts`：唯一的月历换算规则。
- `domain/decision-budget.ts`：按人物月计算的模型调用配额。
- `domain/structure.ts`：从可站立空气、头顶实体与侧向围护的真实体素拓扑计算结构效果。
- `world/grid.ts`：84×52 网格、邻接、通行与 A*。
- `world/generator.ts`：只负责生成初始自然事实与出生格。
- `application/monthly-simulation.ts`：创建文明、执行一个月、恢复状态和生成报告。
- `simulation.ts`：供其他层依赖的稳定公共门面。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影。

服务端模型决策器只能选择战略/社会意图并生成受约束的对话文本，不能直接修改聚合根。意图的原子动作由规则引擎编译和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。
