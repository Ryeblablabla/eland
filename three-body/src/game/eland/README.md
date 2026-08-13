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

- `domain/model.ts`：人物、计划、物质、结构、事件与 `SimulationState` 聚合根。
- `domain/calendar.ts`：唯一的月历换算规则。
- `domain/decision-budget.ts`：按人物月计算的模型调用配额。
- `domain/structure-policy.ts`：构件蓝图及客观结构效果。
- `world/grid.ts`：84×52 网格、邻接、通行与 A*。
- `world/generator.ts`：只负责生成初始自然事实与出生格。
- `application/monthly-simulation.ts`：创建文明、执行一个月、恢复状态和生成报告。
- `simulation.ts`：供其他层依赖的稳定公共门面。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影。

服务端模型决策器只能返回计划命令，不能直接修改聚合根。前端只能渲染读取投影，不能生成第二套地形、地点或道路。
