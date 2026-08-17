# Eland 像素世界 v1（空间 · 历史 · 迁移）

状态：空间权威、历史与回放原则的当前汇总文档，由旧《像素世界模型》《历史与回放》《硬切换方案》三份合并而成。当前运行时为 schema 16 的物质体素世界（84×52×12，2.5D）；schema 11 的二维属性层细节和 schema 10 → 11 的硬切换过程压缩为文末迁移档案，不得作为新实现依据。

范围：three-body 人间场景的权威空间模型、历史回放设计与空间迁移档案。

关联：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [月度时间模型](./monthly-time-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [最小物质—人物—动作模型](../three-body/design/minimal-emergent-human-model.md) · [社会演进模型](./social-evolution-model-v0.md)

## 1. 空间决策

three-body 的人间世界采用 84×52 水平网格 × 12 层的 2.5D 物质体素。一个体素只回答一件事：这里是什么物质。高度、水深、肥力、植被、火和冰都由物质柱派生或本身就是物质，不再保存为格子属性包。

本项目需要的是 Minecraft 的因果原则，而不是它的三维表现形式：

- 引擎只提供可组合的物质、构件、运动和相互作用。
- 房子、道路、田地、聚落由组合和使用涌现。
- 名字是人对事实的解释，不是事实本身。

2.5D 是当前动作密度与实现成本之间的折中：世界内部是 12 层物质柱，人物在每列最高可通行表面移动；UI 以俯视为默认表现，缩放后可查看该列纵向组成。核心约束不变：

> 屏幕中的社会性对象必须来自权威世界；前端不能依据名字补造世界事实，人物也不能依据意图声明客观效果。

## 2. 权威、派生与纯显示

| 层级 | 内容 | 能否改变世界 |
| --- | --- | --- |
| 权威事实 | 体素物质、掉落物、动物、人物位置与身体、协议与授权、行动事件 | 能 |
| 引擎派生 | 高度与水深、可通行性、结构效果、道路、涌现区域 | 不能直接写回，只能由事实重算 |
| 人物解释 | 地点命名、用途理解、领地观念、地图知识 | 只改变人物认知与关系 |
| 纯显示 | tile 纹理、波纹帧、粒子、标签排布、3D 场景特效 | 不能 |

同一个事实可以有不同解释。例如一片被反复翻动、灌溉并收获的土地，观察器可以称为"耕作区"，某个人也可以称它为"我的田"；底层只保存体素变化和行动来源。

## 3. 世界边界与编号

```text
width = 84
depth = 52
levels = 12
cellCount = 4368
voxelCount = 52416
topology = orthogonal-4（水平邻接）
renderTileSize = 16px（2D 投影显示）
```

```text
cellId = y * width + x
x = cellId % width
y = floor(cellId / width)
voxelIndex = z * cellCount + cellId
```

对角线可以用于显示，但寻路与邻接先采用四方向，避免穿角和拓扑歧义。未来若世界扩大，应由多个同规格区块组成，不改变体素契约。

事件、人物记忆和历史补丁只引用 cellId / voxelIndex，不引用数组对象或前端坐标。`cellId` 同时是人物位置给地图和区域规则使用的水平投影；人物另保存双脚所在的空气体素高度 `z`。

## 4. 物质、结构与痕迹

体素、掉落物、组装体、活体的完整定义见[最小物质—人物—动作模型](../three-body/design/minimal-emergent-human-model.md)。空间侧只保留以下原则：

- 一个体素同一时刻只有一种物质；人物和掉落物是实体，不占用"格子属性"。
- 道路不再由 `traffic` 数值达到阈值后画出：反复通行事件使地表物质逐步变成压实土；通行计数只作为派生统计保留。
- 结构不是格子上的"房子"物品，也不保存重复的权威建筑模型：防护、围合与可达性由已放置体素的真实拓扑（可站立空气、头顶实体、侧向围护）逐次重算。
- 休息、耕作等活动统计从事件流派生，用于观察页展示，不冒充格子属性。
- 住所的客观条件至少包括：稳定支撑与覆盖、可站立的内部空间、可通行开口、人物实际进入，以及达到阈值的天气防护。人物的建造计划只能表达意图，不能直接赋予 shelter；里程碑必须引用人物进入和跨月休息的真实事件。

## 5. 涌现区域

区域是观察结果，不是模拟底座：

```text
interface EmergentRegion {
  id: string
  kind: "natural" | "residential" | "cultivation" | "exchange" | "care" | "memorial"
  cells: number[]
  confidence: number
  evidenceEventIds: string[]
  firstObservedTick: number
  lastObservedTick: number
  label?: string
}
```

识别顺序：

1. 从相邻格的事实特征找连通分量。
2. 检查跨月持续、不同人物参与和真实使用；不同观察器可以要求不同最低月数。
3. 输出带证据的区域观察。
4. 人物可以知道、误解或重新命名它。

natural 区域可以由地貌直接派生；social 区域必须由历史活动派生。区域消失时不删除历史观察，只降低当前置信度或关闭有效期。区域只是带证据的观察结果：点击区域可以显示来源，但标签不写回底层格子，也不成为行动特权。

## 6. 世界生成

生成器（当前为 `material-world-v2-flat`；旧存档可能为 `material-world-v1`）在模拟端运行，种子只用于产生初始事实：

1. 生成统一高度的初始陆地物质柱；土质仍按种子分布。
2. 在统一地平面内下切河床并生成与陆地齐平的水面。
3. 由水分、坡度和土质生成土壤与植被物质。
4. 在满足生态条件的位置生成植物、石材和动物。
5. 为人物选择可站立的初始 cellId。

生成结果进入 SimulationState 并随存档保存。前端不得凭 seed 再生成另一份地形，也不得为"地点锚点"清理森林或河流。

generator.version 必须随算法变化。旧存档读取自己的已存网格，不用新算法重建。

## 7. 前端渲染契约

- 权威世界状态经 adapter 单向投影为 UI 读取模型；前端只渲染投影，不生成第二套地形、地点或道路。
- 人物、动物、掉落物和可交互对象严格按权威 cellId / z 绘制；路径按真实 pathSegment 与派生道路格绘制。
- 动画只改变同一事实的表现，不改变位置和数量。天气粒子、波纹和阴影可以保留，但不产生可交互事实。
- 当前人间只暴露全屏 3D 体素场景（`SocietyScene3D`）；2D 像素地图（`SocietyMap`）不再从前端入口挂载。

前端禁止：

- 根据地点名字生成农田、小屋、市场或祭坛。
- 把一个位置的物质画到附近随机格，造成错误位置。
- 为视觉效果生成会被理解为真实资源的动物或建筑。
- 将直线连接地点锚点冒充人物走出的道路。

## 8. 历史与回放目标

像素世界的历史必须同时满足：

- 世界保留过去事实；
- 人物只访问自己的有限记忆；
- 任意月份可以精确回放；
- 长期计划在每个月都有可追溯的实际进度；
- 从过去分岔后，旧未来仍可审计；
- 不为每个月永久复制整个世界；
- 回放不重新运行本地规划器，也不重新调用模型任务。

## 9. 当前持久化实现

FileRunStore 按运行保存：

- `state.json`：最新完整 `SimulationState`；
- `meta.json`：轻量摘要与持久化修订号；
- `evolution.json`：长程演化状态、元数据检查点与关键转折；
- `report.json`：由真实事件确定性生成的事实报告。

长程演化按 12 个月一批推进，每批保存一次完整状态并追加元数据检查点（月份、事件数、人口、阶段、里程碑 ID、token 用量）；文明提前结束时立即保存。进程或 API 中断时，演化路径标记 `failed` 并保留最近检查点；恢复以最近保存的完整状态为准。

尚未实现：逐体素稀疏补丁、MonthRecord 持久化、分支历史持久化与服务端 seek/分岔 API。第 10～13 节是这些能力的设计目标，实施时不得绕过第 8 节的目标约束。

## 10. 历史设计：运行记录与检查点

```text
interface PixelWorldRun {
  runId: string
  schemaVersion: 16
  generator: { version: string; seed: number }
  branches: BranchMeta[]
  checkpoints: WorldCheckpoint[]
  months: MonthRecord[]
  yearSummaries: YearSummaryRecord[]
}

interface BranchMeta {
  id: string
  parentBranchId?: string
  forkAtMonth: number
  headAtMonth: number
  createdAt: string
}
```

所有 MonthRecord 都属于 branchId。回溯续演创建新分支，不删除原分支事实。

检查点包含恢复模拟所需的完整权威状态，包括活动与挂起意图、本地规划状态和月度时钟。异步模型任务单独持久化，不影响世界检查点：

```text
interface WorldCheckpoint {
  branchId: string
  atMonth: number
  state: EncodedSimulationState
  stateDigest: string
}
```

策略：

- month 0 总有完整检查点。
- 此后默认每 240 个月生成检查点（20 个显示年）；检查点间隔以月存储，不另设年度计数。
- 文明结束、导出或手动保存时可额外生成。
- generator.version 和初始密集层随 month 0 保存。
- 存档总是读取已保存网格，不依赖当前生成器重建。

体素密集层（Uint16Array）在 JSON 存储中使用明确编码：

```text
interface EncodedDenseLayer {
  type: "u16"
  encoding: "rle"
  length: 52416
  data: number[]
}
```

v1 先用 RLE JSON；若实测数据更大，再换二进制容器，逻辑契约不变。

## 11. 历史设计：月度记录与世界补丁

```text
interface MonthRecord {
  branchId: string
  atMonth: number
  parentMonth: number
  planningTicks: PlanningTickRecord[] // 恰好 15 项
  ruleDecisionAgentIds: AgentId[]
  modelTaskIds: string[] // 月提交后排队，非世界事务
  skySample: MonthlySkySample
  events: WorldEvent[]
  delta: WorldDelta
  observations: ObservationDelta
  summary: FrameEntry[]
}
```

events 至少区分：

- DecisionFact：本地规划器开始、修改、挂起、恢复或放弃意图。
- ActionFact：人物在某个 planning tick 实际移动、工作、阻塞或完成。
- EnvironmentFact：当月天象和环境过程。

月度和年度事实摘要由规则生成。少量模型叙事作为独立异步投影保存，不能改写 MonthRecord 或 WorldDelta。

WorldDelta 只记录当月实际变化。体素世界里一个位置只有 materialId，补丁不再需要旧二维属性层的字段掩码：

```text
interface WorldDelta {
  voxelPatches: VoxelPatch[]       // { voxelIndex, materialId, sourceEventIds }
  dropPatches: EntityPatch<DropState>[]
  animalPatches: EntityPatch<AnimalState>[]
  personPatches: EntityPatch<PersonState>[]
  intentPatches: EntityPatch<Intent>[]
  agreementPatches: EntityPatch<Agreement>[]
  recordPatches: EntityPatch<RecordPayload>[]
  collectivePatches: EntityPatch<CollectiveState>[]
  permissionPatches: EntityPatch<ResourcePermission>[]
  containerPatches: EntityPatch<ContainerState>[]
  civilizationPatch?: EntityPatch<CivilizationState>
  clockPatch: { elapsedMonths: number }
}
```

EntityPatch 使用 create、update、delete。删除也要保留 sourceEventIds，避免物质、构件或计划凭空消失。

事件说明"发生了什么"，补丁说明"权威状态改成什么"：

- 每个补丁必须引用至少一个当月事件。
- 每条 DecisionFact 必须引用创建或改变的 intentId。
- 每个实际执行的原子动作必须标明 planningTick；稳定但本月无动作的意图可以只保留状态。
- 每个 progressed/completed 事实必须引用对应 delta。
- 纯解释和记忆变化只能修改人物，不得伪造世界补丁。
- 环境演化必须产生 EnvironmentFact，不能后台静默改格子。
- 模型任务、实际 token 和建议接受结果属于独立基础设施审计，不影响世界补丁的可恢复性。

回放以补丁恢复状态，以事件解释历史。生产回放不重新运行本地规划，也不重跑任何模型任务。

## 12. 历史设计：恢复、回放与分岔

读取某月：

1. 在同一 branch 找到不晚于目标月的最近检查点。
2. 解码完整状态。
3. 按 atMonth 顺序应用 MonthRecord.delta。
4. 恢复 active/suspended plans 和决策预算账本。
5. 重算可安全派生的视图：可供性、区域、道路分段、前端投影。
6. 返回目标月 GameFrame。

回放不得：

- 调用任何模型任务；
- 重新抽取该月关键决策概率；
- 使用当前版本生成器重建地形；
- 用当前规则重新裁决旧事件；
- 依赖前端随机数。

当用户从第 N 月继续演化：

- 原 branch 保持不变。
- 新 branch 的 parentBranchId 指向原 branch，forkAtMonth = N。
- 新分支复用 N 月前的检查点和 MonthRecord。
- N+1 月开始使用新 branchId 抽取决策机会并写入新记录。

分岔后概率序列可以改变，因为 branchId 是确定性随机输入之一；分岔点以前仍完全一致。

## 13. 模型任务审计

每个模型任务记录：

- taskId、kind、请求月份和 planning tick；
- 主题人物及来源事实；
- queued/running/completed/failed/stale 状态；
- 实际 input/output token；
- 结果是否只是叙事、是否被人物本地规划器接受；
- 被拒绝或过期的原因。

模型预算按文明年和任务类型统计，不再按人物月决定人物是否能行动。回放不重新调用任务；分岔不会自动继承尚未接受的建议。

## 14. 旧档切断策略

- 当前 schemaVersion 15；schema 14 存档可按已有迁移路径升入 15。
- 读取 13 及更早版本时返回明确错误，不自动补造缺失的协议、体素或 planning tick 事实。
- 旧档只允许导出 JSON 或历史摘要，不能导入为可继续演化的像素世界。
- 新文明使用新的 runId，避免两种时空语义混在同一时间线。

这是有意的模型断代：不推测从未发生过的月份、路径、位置或行动进度。

## 15. 迁移档案

### 15.1 schema 沿革

```text
schema 10   六地点空间 + 年度时钟（已断代，不迁移）
schema 11   84×52 二维属性层 + 月度时钟（硬切换完成）
schema 14   物质体素取代二维属性层；Intent + PrimitiveAction 取代 PlanMode
schema 15   当前版本：协议事实文明扩展；14 可迁入
```

### 15.2 schema 10 → 11 硬切换决策

不保留六地点兼容区域，直接删除地点图。切换完成后运行时不再出现：

- `LocationState`、`LocationId`、`RouteState`、`INITIAL_ROUTES`。
- `homes`、`field`、`workshop`、`square`、`kitchen`、`river` 六个语义空间 ID。
- `AgentState.locationId`、`MatterHolder.kind = "space"`。
- 地点 neighbors、地点百分比坐标、地点锚点和地点间直线路径。
- `LegacyRegionView` 或任何从 cellId 反推旧地点的适配层。

schemaVersion 10 存档不迁移、不续演，像素世界以新文明重新开局。

### 15.3 断代原则（仍适用于以后的硬切换）

1. cellId / voxelIndex 是唯一空间权威，没有第二套位置。
2. 新代码不得读取或生成已删除的旧 ID。
3. 不追求第一版立即恢复所有里程碑；允许暂时缩小功能面，但保留下来的行为必须是真实格子行为。
4. 不用占位地点维持旧测试通过；旧地点测试删除或改写。
5. 每个提交阶段都应能构建和运行，但不要求与旧版本功能等价。
6. 先贯通最小纵向切片，再迁回其他社会能力。

### 15.4 已完成的三阶段

1. 删除地点图，建立可运行的网格内核（移动、取水、取食、采木）。
2. 跨格结构与真实住所（材料接入 → 客观防护 → 跨月休息）。
3. 迁回社会能力，形成涌现区域（照护、交换、火与烹饪、农业、记录等按清单逐项改写）。

当时的代价是明确接受的：旧规则建立在错误的空间底座上，维持其运行会迫使新网格继续服从六地点。应保留的是非空间因果规则和证据标准，不是旧空间接口。

## 16. 验收不变量

- 同一个月、同一种子、同一计划与行动历史得到逐格相同的世界。
- 任意屏幕上的可交互对象能追溯到 SimulationState。
- 任意资源消耗能追溯到具体 holder 和事件。
- 任意道路能追溯到实际通行过的 cellId 序列。
- 任意住所能追溯到体素拓扑、材料和使用事件。
- 改变对象名字不会改变其物理效果或里程碑判断。
- 移除前端程序化装饰后，世界事实仍完整存在。
- SimulationState 中不存在 homes、field、workshop、square、kitchen、river 六个语义空间 ID。
- 连续推进超过一个检查点间隔后，可由最近检查点和后续补丁恢复目标月（补丁持久化实现后适用）。
- 从第 N 月分岔不会删除原分支第 N+1 月以后的记录（分支持久化实现后适用）。
- 回放过程中模型调用次数为 0；关闭模型后仍能完整恢复、分岔并继续本地演化。
