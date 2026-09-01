# ELAND 体素世界 v1

状态：当前空间、渲染与回放契约。本文只记录当前实现；已经移除的六地点、二维属性层、`PixelWorldRun / MonthRecord / WorldDelta` 伪接口和旧 checkpoint 方案不再保留。

范围：`three-body` 人间场景的权威空间模型、初始生成、前端投影、实时回放与分支语义。

关联：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [月度时间模型](./monthly-time-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [SQLite 持久化](./sqlite-persistence-v1.md) · [最小物质—人物—动作模型](../three-body/design/minimal-emergent-human-model.md)

代码入口：`three-body/src/game/eland/world/grid.ts`、`world/generator.ts`、`adapter.ts`、`society-patch.ts`、`three-body/server/elandSession.ts`。

## 1. 权威空间

人间世界是 `84 × 52 × 12` 的 2.5D 物质体素：

```text
width = 84
depth = 52
levels = 12
cellCount = 4368
voxelCount = 52416
horizontalTopology = orthogonal-4
```

```text
cellId = y * width + x
x = cellId % width
y = floor(cellId / width)
voxelIndex = z * cellCount + cellId
```

- 一个体素同一时刻只有一种 `MaterialId`。
- 人物、动物、掉落物和容器都带稳定体素位置：人物、动物和掉落物使用 `cellId / z`，容器使用 `x / y / z`；它们不占用第二套格子属性。
- 人物站在真实可容身的空气体素中；寻路和交互读取同一网格。
- 邻接和寻路使用四方向，不能穿角。
- 事件、记忆、行动目标和投影引用稳定 ID 或体素坐标，不引用前端对象。

当前权威聚合是 schema 17 的 `SimulationState`；其中 `world.grid.version = 2` 是体素网格自身的格式版本，两者不是同一个版本号。

## 2. 权威、派生与显示

| 层级 | 内容 | 约束 |
| --- | --- | --- |
| 权威事实 | 体素、掉落物、动物、人物位置和身体、容器、意图、协议、项目、行动事件 | 只能由领域规则或应用用例提交 |
| 可重建物理派生 | 站立面、路径、结构防护、道路痕迹、可达空间 | 可以参与物理合法性，但不能成为第二套事实源 |
| 观察投影 | 实践、制度、里程碑、文明指数、涌现区域 | 事后读取事实，不为人物解锁能力 |
| 纯显示 | 微体素过渡、波纹、粒子、阴影、标签与动画 | 不写回模拟，不制造可交互对象 |

结构效果来自已放置体素的拓扑：支撑、头顶覆盖、侧向围护、可站立内部空间和真实入口。计划名、项目名或前端模型都不能直接产生住所、道路、田地或设施。

反复通行会留下权威交通计数，并可把草地逐步压成土路；区域名称、用途和道路连通仍是有证据的观察结果，不是格子上的标签字段。

## 3. 当前生成器

新文明使用 `material-world-v4-regional-geology`。生成器只在创建初始状态时运行：

1. 按种子和局部生物群系生成沙、肥沃土与草地表面。
2. 生成两格宽、带稳定走向的河道，河床下切，水面与初始陆面齐平，岸边形成湿土。
3. 按种子生成树木、浆果、灌木和自然石材。
4. 生成黏土、铁矿、铜矿和锡矿；铜、锡在距出生区的有界距离带中保证最低来源数量，仍需真实探索与运输。
5. 保留出生净空并选择真实可站立的开局位置。

生成结果随 `SimulationState` 保存。恢复旧运行时读取已保存网格，绝不使用当前生成器和 seed 重建。前端也不得根据 seed 再生成一份地形。

`generator.version` 是存档事实；生成算法发生语义变化时必须换版本。

## 4. 空间变化与行动

空间只能经五类 `PrimitiveAction` 及无人行动时仍会发生的世界过程改变：

- `move`：一个规划刻度最多跨越一条真实相邻边；路径和最终高度进入 `ActionFact`。
- `transfer`：物质在人物、地面和容器之间按精确来源移动。
- `act`：对真实目标执行 `exert / separate / combine / expose / ingest / reproduce / hunt / dehydrate / rehydrate`。
- `attend`：观察、阅读或验证真实目标。
- `talk`：提交有来源的手势、口头或实体记录沟通。

每个动作都在提交时重新检查位置、距离、材料、授权、身体与目标状态。人物的意图只表达持续目标；客观完成必须由真实动作和后果证明。

详细顺序和事实字段见[空间行动契约](./spatial-action-contract-v1.md)。

## 5. 前端投影

当前产品只挂载全屏 `SocietyScene3D`：

- `adapter.ts` 把权威状态单向转换为 `SocietyState`。
- 人物、动物、掉落物、建筑体素、道路和环境效果都从该读取模型产生。
- 材质交界、水岸、火焰和微体素细节可以确定性重建，但不能写回领域状态。
- 连续同分支月份可以传输 `SocietyPatch`；它只是对上一权威帧的网络差量，不是世界历史或第二套状态。
- 客户端 patch 基线不匹配时必须重新读取完整 `state`，不能自行补算。

前端禁止根据名称、意图、里程碑或随机装饰补造已完成建筑、资源、道路、动物、植物或人物行动。

## 6. SQLite、检查点与回放

`three-body/data/eland.sqlite3` 是唯一持久化事实源，完整表、codec、事务与备份规则见[SQLite 持久化](./sqlite-persistence-v1.md)。空间文档不再复制物理表协议。

当前恢复语义：

- 长程 `/api/runs/*` 每批最多推进 12 个月，并提交当前 root、历史分段和检查点元数据。
- 长程状态拆为 root、state shell、history node 和 event segment 内容块；不再把整个历史当作一个永久增长的单块。
- 实时会话在首帧及每 12 个月保存完整 checkpoint，中间月份保存相对上一个基线的 delta。
- 手动存档与实时恢复保存会话 shell、分支图、时间线块和最近权威帧。
- `seek` 从目标月权威快照创建新 `branchId`；原分支的未来仍保留。

回放读取已提交的 checkpoint/delta 和帧，不重新运行规划器、不重新调用模型、不用当前生成器重建地形，也不用当前规则重新裁决旧事件。

## 7. 版本边界

当前开发状态以 schema 17 为准。无法证明等价迁移的旧 schema 不得被静默补字段后继续演化；导入必须明确拒绝，或由专门迁移器产生可审计的新状态。

运行时代码不得重新引入已删除的六地点语义 ID、前端地点锚点或与 `cellId / voxelIndex` 并存的第二套位置权威。

## 8. 验收不变量

- 同一种子与同一已提交历史得到逐体素一致的权威世界。
- 任意屏幕中的可交互对象都能追溯到 `SimulationState`。
- 任意资源消耗都能追溯到具体 holder 和事件。
- 任意道路都能追溯到真实通行与地表变化。
- 任意住所都能从体素拓扑、材料和使用事件重算。
- 名称、叙事和观察指标不会改变物理效果。
- 连续推进超过 12 个月后，实时会话能由 checkpoint 与后续 delta 恢复。
- 从第 N 月分岔不会删除原分支 N+1 月以后的记录。
- 关闭模型后仍能恢复、分岔并继续本地演化。
