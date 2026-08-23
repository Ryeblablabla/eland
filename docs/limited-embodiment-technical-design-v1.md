# ELAND 有限化身与逐刻度建造技术设计 v1

状态：目标技术设计，尚未实现。本文描述未来实时游戏中的单玩家有限化身；其中“当前事实”以 2026-08-24 的可执行代码为准，“目标设计”不能当作已经存在的接口或行为。

范围：人间体素世界、单个在世人物、单玩家实时会话、一个自然月内的 15 个规划刻度，以及移动、近身交互和真实体素建造。多人化身、战斗、自由飞行、全局文明指令和工业以后内容不在 v1 范围内。

前置文档：[月度时间模型](./monthly-time-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [规则优先人物架构](./rule-first-agent-architecture-v1.md) · [SQLite 持久化](./sqlite-persistence-v1.md)

视觉基准：[有限化身 UI 概念 v2](./assets/eland-limited-embodiment-ui-concept-v2.png)

## 1. 结论与核心取舍

有限化身不创建一套独立的第一人称沙盒。它把玩家临时接到一个真实人物的局部感知和合法行动候选上：自由观察不推进世界；移动、建造、给予、等待和有事实意义的沟通各消耗一个规划刻度；其他人物仍由同一规则在同一刻度行动。

目标体验是：

```text
快速观察文明
→ 在月度边界进入一名人物
→ 冻结自动月度推进并展开本月 15 刻
→ 观察、移动、搬运、交谈或建造
→ 第 15 刻提交现有月度权威帧
→ 继续化身，或交还自主并恢复快速演化
→ 从长期历史观察本月行动的真实回响
```

本设计采用四项关键决策：

1. **仍以月份作为公开历史和分支的提交单位。** 第 15 刻完成前，不生成普通 `GameFrame`，不把半个月写成可 seek 的月份。
2. **逐刻度状态是服务器持有的“暂存月份”。** 每次玩家命令成功后持久化命令收据和暂存哈希；崩溃恢复时从上一个已提交月确定性重放，不能依赖前端缓存。
3. **玩家提交合法候选，不提交原始世界修改。** 客户端只能发送服务端给出的 `optionId + choiceKey`；不能直接发送“把某体素改成木板”或“让人物掌握冶炼”。
4. **退出不回滚。** 已经发生的刻度继续属于本月历史；玩家交还自主后，本地规则接管该人物并完成剩余刻度，再按既有月末流程提交。

## 2. 目标与非目标

### 2.1 v1 目标

- 只能在已提交月份的边界进入化身，不介入一段已经算完的 `tickPath` 回放。
- 进入后停止前端自动调用普通 `/step`。
- 第一人称镜头锚定人物真实站立位置，鼠标自由观察，`WASD` 只请求合法相邻移动。
- 每刻玩家最多提交一个会改变世界的合法行动；“等待”也是显式行动，“转头 / 查看”不是行动。
- 服务器在一个命令中执行该刻全部人物，并返回当前暂存投影与下一刻候选。
- 建造消耗真实背包物质、修改权威体素、产生 `ActionFact`，并由真实结构拓扑计算住所功能。
- 刷新或后端重启后可以恢复到同一个待操作刻度。
- 无模型端点时，移动、建造、项目和 NPC 自主规则仍完整运行。
- `Tab` 交还自主后，规则确定性完成剩余刻度并恢复自动演化。

### 2.2 v1 非目标

- 不把整个人间场景永久改成第一人称；观察视角仍是默认文明体验。
- 不实现 FPS 物理、跳跃、冲刺、武器、命中判定或自由体素破坏。
- 不提供全知小地图、科技树、全局蓝图库或直接“文明升级”按钮。
- 不允许玩家读取隐藏配方、远方资源、他人背包、文明指数或观察器里程碑。
- 不允许前端预测并提前提交人物位置、材料数量或结构完成。
- 不在每个刻度调用模型替玩家或所有 NPC 决策。
- 不在 v1 同时处理多人争用同一人物；协议预留修订号，但多人所有权另行设计。

## 3. 当前实现基线

以下是已经存在的事实，不是目标伪接口：

| 能力 | 当前实现 | 有限化身需要补充 |
| --- | --- | --- |
| 月度演化 | `executePrepared` 在一次调用内依次执行 15 tick，再完成月末提交 | 把同一执行器拆成“准备月份 / 执行一刻 / 完成月份”，不复制规则 |
| 实时会话 | `/api/eland/step` 以完整权威身份和 `stepId` 原子推进一个月 | 新增暂存月份协调器、逐刻命令收据和普通 step 互斥 |
| 前端场景 | `SocietyScene3D` 使用 `OrbitControls`，已有 WASD 镜头平移和人物 / 结构射线选择 | 在同一 Three.js 场景增加化身相机控制器，不创建第二套世界 |
| 月度播放 | `RULE_TICKS = 15`，人物 `tickPath` 在约 3 秒内回放 | 化身模式改读暂存 tick 投影；普通观察模式保留原回放 |
| 玩家影响 | 主动人物对话只能把模型明确接受的方向绑定到最新合法候选 | 增加不依赖模型的直接候选命令；复用稳定语义重验原则 |
| 建造 | `buildConstructionOptions` 从背包材料和近身合法空气生成候选 | 把候选目标投影成准星可选的体素虚影 |
| 结构功能 | 住所由真实顶部覆盖、侧向围护、入口、材料和可站立空间重算 | 每刻提交后投影新结构或结构质量变化 |
| 持久化 | `live_sessions` 保存内容寻址的实时会话恢复快照 | 在恢复快照中加入可重放的暂存月份，不增加第二个事实库 |

现有建造候选最多读取人物背包中两类可用材料，并在本人或四邻格内编译少量有支撑的目标；`combine` 成功后扣减堆栈并修改体素。结构索引只从已提交建造事实和当前体素重建。v1 应扩展候选投影与交互入口，不应绕开这些约束另写“建造模式”。

## 4. 权威边界

```text
鼠标 / 键盘 / 触控
        ↓ 方向与目标选择，不是世界修改
第一人称 HUD + Scene raycast
        ↓ optionId + choiceKey + expected identity
embodiment HTTP adapter
        ↓
EmbodimentCoordinator
        ↓
application: month execution + local legal options
        ↓
domain action executor ↔ voxel world / materials
        ↓
暂存 tick 事实与投影
        ↓ 第 15 刻
既有 SimulationState + WorldEvent + GameFrame + timeline
```

权威规则：

- 第一人称相机的 yaw / pitch、准星位置和 UI 展开状态只属于前端。
- 人物站立位置、背包、身体、意图、项目、体素和关系只属于服务器状态。
- 前端可以平滑插值上一个和下一个权威站位，但插值位置不能用于下一次规则校验。
- 绿色建造虚影只表示当前返回候选中存在该目标；它不是预放置体素。
- `EmbodimentFrame` 是当前暂存月份的权威只读投影，但不是公开历史中的普通 `GameFrame`。
- 观察器、历史纪事、文明指数和模型台词在第 15 刻普通提交后更新；不得用暂存投影反向决定人物候选。

## 5. 产品流程

### 5.1 进入

1. 玩家在观察视角聚焦一名存活人物并选择“进入化身”。
2. 如果普通月度 `/step` 已在执行，客户端等待它提交，不能中断执行中的原子月份。
3. 客户端停止自动 step，冻结下一月的 `SkySample` 与可选 `CosmosSnapshot`。
4. 客户端以当前完整权威身份请求开始化身。
5. 服务端确认人物、分支、月份和会话租约仍一致，准备 `elapsedMonths + 1`。
6. 服务端排除玩家人物的自主初始选择，冻结其他人物本月需要的 tick-1 决策输入，持久化暂存月份。
7. 镜头从观察视角过渡到人物眼部锚点，返回第 1 刻局部投影和合法候选。

只允许在月度边界进入，避免把已经算完的第 6 刻回放伪装成可修改的第 6 刻。

### 5.2 每刻循环

```text
等待玩家命令
→ 用 expected revision 重验候选
→ 处理人物求生 / 照护 / 履约等强制优先级
→ 按既有稳定顺序执行全体人物本刻动作
→ 写入本刻 ActionFact / DecisionFact
→ 记录人物 tickPath 当前节点
→ 持久化命令收据与暂存状态哈希
→ 返回暂存投影、可见反馈和下一刻候选
```

如果人物处于脱水休眠、严重求生反射或其他没有真实选择的强制状态，服务端不暴露虚假的自由候选。该刻可由规则自动执行，并返回“身体自行寻找水源”等来源明确的结果；UI 可以短暂停留展示，但不要求玩家选择一个必然被覆盖的按钮。

### 5.3 第 15 刻

第 15 刻完成后继续执行现有月末身体、关系、项目、共同体、观察器、命名、台词和纪事流程，生成普通 `GameFrame`，写入分支 timeline，清除暂存月份，并持久化新的实时会话根。

前端随后提供两个选择：

- **继续化身**：以刚提交的月份作为新边界，准备下一个月。
- **交还自主**：返回观察视角并恢复之前的自动演化速度。

### 5.4 中途交还自主

`Tab` 触发 `release`：

1. 服务端保留已经完成的所有刻度。
2. 从 `nextTick` 开始，玩家人物恢复本地规则规划。
3. 服务器在同一释放请求内完成剩余刻度和月末提交。
4. 返回普通 `GameFrame`，清除暂存月份。
5. 前端拉远镜头并恢复自动演化。

中途交还不是撤销，也不创建分支。玩家若要改写历史，应使用现有 seek / fork 语义，而不是让化身接口暗中回滚。

### 5.5 断线与刷新

- 浏览器关闭、网络中断或页面刷新不会自动交还自主；世界保持在同一待操作刻度。
- 每次成功的 tick 命令必须在响应前写入 `live_sessions` 恢复根。
- 恢复时从最后已提交 `latestState`、冻结的月份输入、其他人物冻结选择和已完成玩家命令重放到 `completedTick`，并校验暂存哈希。
- 哈希不一致时拒绝继续该暂存月份，保留上一个已提交月并给出恢复错误；不能静默采用不一致的半月状态。

## 6. 暂存月份状态机

```text
inactive
  └─ begin ─→ preparing
                 ├─ forced terminal climate ─→ finalizing ─→ inactive
                 └─ prepared ─→ awaiting-command
                                    ├─ command ─→ executing-tick
                                    │                ├─ tick < 15 ─→ awaiting-command
                                    │                └─ tick = 15 ─→ finalizing ─→ inactive
                                    └─ release ─→ releasing ─→ finalizing ─→ inactive
```

`preparing / executing-tick / releasing / finalizing` 都是服务端互斥临界区。客户端读到这些状态时只显示等待，不得再提交并发命令。

目标恢复数据：

```ts
interface ActiveEmbodimentSnapshot {
  schemaVersion: 1
  id: string
  actorId: PersonId
  status: 'awaiting-command' | 'executing-tick' | 'releasing' | 'finalizing'

  authorityRevision: string
  civilizationId: number
  branchId: string
  baseElapsedMonths: number
  atMonth: number

  skySample: SkySample
  cosmosSnapshot?: CosmosSnapshot

  completedTick: number       // 0..15
  nextTick: number            // 1..15；finalizing 时可省略
  revision: number            // 每次成功 tick / release 单调递增

  frozenInitialDecisions: FrozenDecisionInput[]
  decisionUsage: TokenUsage
  decisionAttempts: ModelAttemptSummary
  commands: EmbodimentCommandReceipt[]
  completedCommandReceipts: EmbodimentRequestReceipt[]
  stagedStateHash: string

  createdAt: number
  updatedAt: number
}
```

不直接序列化 planner、函数闭包或 Three.js 对象。`frozenInitialDecisions` 保存本月开始时已经接受的非玩家候选选择和必要模型审计；tick 2..15 的本地重规划仍从逐刻重放状态确定性产生。

`ActiveEmbodimentSnapshot` 应作为 `ElandSessionRecoverySnapshot` 的可选字段进入现有内容寻址 session root。`live_sessions.elapsed_months` 仍表示最后已提交月份；暂存 tick 只存在于 snapshot 内容中，因此 v1 不要求新增 SQLite 表或第二个状态库。

## 7. 月度执行器改造

不能在服务器里复制一份“玩家月度循环”。先把当前 `executePrepared` 拆成共享生命周期：

```ts
prepareMonthExecution(state, inputs): MonthExecution

executePlanningTick(
  execution,
  tick,
  actorDecisionProvider,
): TickExecutionResult

finishMonthExecution(execution): SimulationState
```

`MonthExecution` 是仅含数据的应用层状态，至少保存：

- `state / events / atMonth`
- 月初候选与已冻结决定
- `reviewedPeople / plannedAtTickOne`
- 模型用量和尝试统计
- 当前完成 tick
- 投影所需的本刻事实

两条调用路径必须使用同一实现：

- 普通快速演化：`prepare → for 1..15 execute → finish`，行为和历史保持不变。
- 有限化身：`prepare → 每个 HTTP 命令 execute 一次 → finish`。

重构阶段先做相同种子、相同输入的历史 hash 对照，确认普通路径没有行为变化，再接入玩家命令。该重构属于执行粒度调整，不应顺便修改文明规则或候选优先级。

## 8. 玩家命令与候选

### 8.1 命令不是原始动作

客户端提交：

```ts
type EmbodimentCommand =
  | {
      kind: 'choose-option'
      optionId: string
      choiceKey: string
    }
  | {
      kind: 'wait'
    }
```

`wait` 明确消耗本刻；仅仅看向一个对象、打开“更多”或检查身体不发送命令。

服务端返回只读候选：

```ts
interface EmbodimentOptionView {
  optionId: string
  choiceKey: string
  label: string
  category: 'move' | 'build' | 'transfer' | 'attend' | 'communicate' | 'survival' | 'project'
  tickCost: 1
  target?: EmbodimentTargetView
  materialCost?: Array<{ materialId: MaterialId; quantity: number }>
  observableReason?: string
  risks?: string[]
  primary: boolean
}
```

`choiceKey` 复用当前玩家交互中的稳定语义原则，排除月份戳和临时 option ID，但应为化身命令建立独立验证入口，不能把直接操控伪装成一次模型对话。

### 8.2 候选来源

`buildEmbodimentOptions` 只组合现有应用层候选和一个新的相邻移动候选编译器：

- 当前 `DecisionContext` 中对人物合法的建造、项目、转移、观察和沟通方向；
- 当前体素网格上可站立的四向相邻位置；
- 当前可见、可达且符合动作距离的目标；
- 紧急、履约和必须回应优先级过滤后的结果。

它不能增加“玩家专用远程取得”“忽略知识建造”“任意放置”或“无材料施工”等特权。

### 8.3 失效与重验

命令执行前使用当前暂存状态重新编译并匹配：

- `revision` 陈旧：返回 `409` 和最新 `EmbodimentView`，不消耗 tick。
- `optionId` 已失效但 `choiceKey` 唯一匹配同一语义：采用最新 option 并在收据中记录重配。
- 语义候选消失或匹配不唯一：返回 `422`，附人物可观察的阻塞原因，不消耗 tick。
- 动作在稳定人物顺序中被前一人物改变世界后阻塞：提交真实 blocked `ActionFact`，该刻已经发生并正常推进。

前两类发生在 tick 开始前；最后一类是世界内真实冲突，不能为了玩家体验回滚其他人物的合法行动。

## 9. 移动与第一人称相机

### 9.1 输入语义

- 鼠标 / 触控拖动：只修改本地 yaw / pitch，不消耗 tick。
- `WASD`：根据相机水平朝向选择最接近的一个合法四向相邻移动候选。
- 单次按键只提交一步；按住按键必须等上一 tick 响应和移动动画结束后才能提交下一步。
- v1 不提供跳跃、冲刺和斜向移动。
- 没有合法相邻站位时只播放轻微阻挡反馈，不发送虚假 move。

### 9.2 服务端移动

移动仍走现有站立路径和 `PrimitiveAction.move`：

- 每 tick 最多跨一条相邻边；
- 重新检查高度、体素、拘束、休眠、身体和携婴规则；
- 写入真实 `pathSegment`、位置与身体消耗；
- 道路痕迹仍由真实通行次数产生。

不引入浏览器物理引擎作为规则来源。镜头碰撞只用于避免视觉穿模，不能让人物进入服务器判定不可站立的位置。

### 9.3 相机控制器

在同一个 `SocietyScene3D` 场景中增加模式分支：

```ts
type SocietyCameraMode =
  | { kind: 'overview' }
  | { kind: 'embodiment'; agentId: string; yaw: number; pitch: number }
```

- `overview` 保留当前 `OrbitControls`、连续缩放进出和 WASD 平移。
- `embodiment` 禁用 `OrbitControls`，启用 Pointer Lock 或等价的拖拽视角。
- 相机位置来自人物站立体素高度加人物视觉身高；人物本人 mesh 隐藏，手臂只在搬运、给予或施工动画中短暂出现。
- 服务端返回新位置后，镜头用 300–500ms 插值；插值期间锁定下一命令。
- 第一次 `Escape` 只释放 Pointer Lock；`Tab` 才是交还自主。无 Pointer Lock 环境保留拖拽和键盘替代路径。

## 10. 建造与文明发展

### 10.1 体素施工

准星指向当前候选中的体素目标时，前端显示半透明构件：

```text
绿色：当前候选仍合法
灰色：可观察但本人没有可用材料或知识
不显示：目标不可见、不可达或属于隐藏事实
```

`E 放置木板 · 1刻` 提交该建造 option。服务器仍通过 `combine`：

1. 检查材料堆仍在本人背包且数量足够；
2. 检查目标在近身范围、仍为空气、有真实支撑且没有身体占据；
3. 扣减材料；
4. 修改体素；
5. 写入建造 `ActionFact` 和物质知识后验；
6. 重建暂存结构投影。

房屋没有单独的“完成按钮”。当真实体素形成屋顶、至少一个有效入口和足够侧向围护时，`shelterGeometryAt` 才产生防雨与隔热；完全封死的空腔仍不可居住。

### 10.2 较大设施

粮仓、蓄水、农田、工坊、冶炼和机械设施通过现有物质操作与项目链推进：

- 玩家可以选择一个本人当前有理由提出的项目；
- 项目保存真实场地、材料缺口、尝试和参与者；
- 玩家可以亲自搬运、施工、实验、沟通或请求协作；
- 其他人物是否加入仍由关系、承诺、需要和合法候选决定；
- 知识必须经本人实验、观察、记录或真实教学获得；
- 设施能力只能由体素、物质、容器、项目和使用事实重算。

因此玩家能够推动文明，但不能直接操纵文明指数或点击时代升级。长期效果来自这名人物留下的住所、储备、工具、知识、关系、协议和制度是否被他人继续使用与传播。

### 10.3 推荐首个完整切片

```text
化身一名持有木材的人物
→ 走到施工位置
→ 放置屋顶与侧向围护
→ 形成一处真实可用住所
→ 请求附近人物搬运一份材料
→ 交还自主
→ 快进到下一次乱纪元
→ 观察住所是否真实降低暴露并被共同体使用
```

第一版不需要工坊和科技树。这个切片已经同时验证镜头、逐刻度、移动、材料、建造、结构功能、社交协作、退出和长期回响。

## 11. HTTP 协议目标

沿用当前 `/api/eland/<route>` 风格，不引入第二个服务。

### 11.1 开始化身

```http
POST /api/eland/embodiment-begin
```

```ts
interface BeginEmbodimentRequest {
  runId: string
  embodimentId: string
  agentId: string
  expectedAuthorityRevision: string
  expectedCivilizationId: number
  expectedBranchId: string
  expectedElapsedMonths: number
  skySample: SkySample
  cosmosSnapshot?: CosmosSnapshot
}
```

相同 `embodimentId + fingerprint` 重试返回同一暂存月份；相同 ID 用于不同人物、分支、月份或天象时返回 `409`。

### 11.2 读取 / 恢复

```http
GET /api/eland/embodiment-state?runId=<runId>
```

无活动化身返回 `404`；有活动化身时返回当前修订、暂存投影、人物局部视图和下一刻合法候选。

### 11.3 提交一刻

```http
POST /api/eland/embodiment-step
```

```ts
interface EmbodimentStepRequest {
  runId: string
  embodimentId: string
  commandId: string
  expectedRevision: number
  expectedTick: number
  command: EmbodimentCommand
}
```

响应：

```ts
interface EmbodimentStepResponse {
  receipt: EmbodimentCommandReceipt
  embodiment?: EmbodimentView   // tick 1..14
  committedFrame?: GameFrame    // tick 15
  history?: EvolutionEntry[]
}
```

`commandId` 必须幂等：同一 ID 和同一 fingerprint 返回原收据；同一 ID 用于不同命令返回 `409`。

### 11.4 交还自主

```http
POST /api/eland/embodiment-release
```

请求携带 `embodimentId / releaseId / expectedRevision`。成功后返回规则完成剩余 tick 所提交的普通 `GameFrame`。重复 release 返回同一最终帧；释放期间普通 `/step` 仍返回忙冲突。

### 11.5 暂存投影

```ts
interface EmbodimentView {
  id: string
  actorId: string
  status: 'awaiting-command' | 'executing-tick' | 'releasing' | 'finalizing'
  authorityRevision: string
  civilizationId: number
  branchId: string
  baseElapsedMonths: number
  atMonth: number
  completedTick: number
  nextTick?: number
  revision: number

  society: SocietyState
  actor: EmbodiedActorView
  options: EmbodimentOptionView[]
  tickEvents: TickEventView[]
}
```

v1 可以为正确性每刻返回完整 `SocietyState`；后续再复用 society patch 降低传输。无论使用全量还是 patch，客户端都不得把它写回服务端。

## 12. 会话互斥、持久化和分支

### 12.1 互斥

活动暂存月份期间：

- 普通 `/step`、`seek`、`load`、`settle-civilization` 和替换会话操作返回 `409`；
- 手动存档只接受已提交月份，要求先完成或交还自主；
- `checkpoint` 必须保存当前暂存月份恢复数据；
- 历史和 frame 查询仍只返回已提交月份，可额外返回 `hasActiveEmbodiment: true`；
- 旧人物对话写入口暂不与暂存月份并发，避免它依据上一个已提交月排队一个已经陈旧的行动选择。

服务端应把普通月度 `SessionStepCoordinator` 和新的 `EmbodimentCoordinator` 放在同一会话写锁下，不能只依靠前端暂停按钮避免并发。

### 12.2 持久化

每个成功 begin、tick 和 release 都调用现有 `persistIfCurrent`，更新同一 `live_sessions` root。tick 只有在恢复根持久化成功后才向客户端确认；失败时不返回成功收据，客户端可用相同 `commandId` 重试。

不为暂存状态添加独立 SQLite 事实表。已有 `chunks + live_sessions` 负责原子替换和内容校验；暂存命令日志作为会话恢复内容，最终动作事实仍只进入提交后的 `SimulationState.world.past` 与 timeline。

### 12.3 分支

- 开始化身冻结 `authorityRevision + civilizationId + branchId + elapsedMonths`。
- 活动期间不能 seek 或 fork。
- 第 15 刻提交沿当前分支增加一个普通月份。
- 玩家想重做该月时，应在提交后使用现有 seek 生成新分支；化身 API 不提供隐式 undo。

## 13. 模型与对话

有限化身的动作主链不依赖模型：

- 玩家自己在本地合法候选中选择，玩家人物不需要模型替选。
- 其他人物仍沿当前本地 / 可选模型月初决策边界；任何非确定模型选择在 begin 时冻结并进入恢复快照。
- tick 2..15 的本地修复和重规划不新增逐刻模型调用。
- 动作完成后的自然台词仍是投影，不能修改 `communicate` 的参与者、立场、来源或后果。

v1 的 `E 交谈` 只展示当前合法的结构化沟通候选，例如询问、请求材料、回应协议或提出协作；确认后消耗一刻。现有自由文本人物对话可以保留在观察模式，但在逐刻暂存月份内先禁用。后续若把自由文本接入化身，仍须先映射并重验唯一合法 `communicate` 候选，模型失败时不能消耗 tick 或伪造对话事实。

## 14. 前端结构

建议新增：

```text
three-body/src/game/eland/application/simulation/month-execution.ts
three-body/src/game/eland/application/embodiment-options.ts
three-body/src/game/eland/application/player-embodiment-command.ts
three-body/src/game/eland/projection/embodiment.ts
three-body/server/eland-session/embodiment-coordinator.ts
three-body/src/game/embodimentContract.ts
three-body/src/components/LimitedEmbodimentHud.tsx
three-body/src/components/society-scene/EmbodimentCameraController.ts
```

并修改：

```text
three-body/src/pages/ImmersiveGame.tsx
three-body/src/components/SocietyScene3D.tsx
three-body/src/game/elandClient.ts
```

`ImmersiveGame` 负责产品模式和网络状态：

```ts
type ExperienceMode =
  | { kind: 'observing' }
  | { kind: 'entering-embodiment'; agentId: string }
  | { kind: 'embodied'; view: EmbodimentView }
  | { kind: 'releasing-embodiment' }
```

自动演化条件从当前 `uiPaused` 扩展为显式 `worldAdvancePaused`，活动化身期间绝不能调用普通 `stepOnce`。

`SocietyScene3D` 继续拥有唯一 Three.js world；它只根据 `cameraMode` 切换相机控制，并把准星命中的已有 `agentId / structureId / voxel position` 回传给 HUD。HUD 从服务器 option 列表中匹配目标，不在 React 中重新判断建造合法性。

## 15. HUD 规范

常驻信息保持克制：

```text
顶部：第13年 · 5月    ⏸    第6/15刻
      ● ● ● ● ● ◉ ○ ○ ○ ○ ○ ○ ○ ○ ○

左上：王昭君 · 17岁
      意图：帮助共同体准备乱纪元

中央：小准星；命中目标时显示姓名 / 可观察动作
底部：E 当前主操作 · 1刻    F 更多
右下：Tab 交还自主
```

- 不常驻显示“自动演化已暂停”“本刻可执行一个行动”或 1–15 的全部数字。
- 身体正常时不显示健康、饮水、营养条；出现可感知异常时才显示“口渴 / 寒冷 / 负伤”。
- “观察”不是按钮，第一人称注视本身就是观察。
- 给予、请求帮助和建造只有在目标与候选都存在时出现。
- 行动提交后按钮锁定，直到收到 tick 收据并完成镜头插值。
- 规则覆盖玩家意图时，显示具体世界原因，不显示抽象的“操作失败”。

## 16. 交付阶段

### 阶段 A：意图化身原型

- 增加第一人称相机、暂停自动 step 和 v2 HUD。
- 只在月初选择一个现有合法意图和空间目标。
- 后端仍原子执行完整月份，前端第一人称回放真实 15 tick。
- 时间条必须标注为回放，不能宣称逐刻操控。

目的：低成本验证“进入人物—选择—看回响”是否好玩。

### 阶段 B：无行为变化地拆分月度执行器

- 提取 `prepareMonthExecution / executePlanningTick / finishMonthExecution`。
- 普通演化仍一次循环 15 tick。
- 用少量固定种子做前后完整历史 hash 对照，不跑无关长程实验。

目的：建立逐刻执行基础，同时守住当前规则行为。

### 阶段 C：暂存月份与移动

- 增加恢复 snapshot、coordinator、begin/state/step/release API。
- 支持自由观察、相邻移动、等待、刷新恢复和中途交还。
- 普通 step 与暂存月份服务端互斥。

目的：完成第一个真正可操控的 15 tick 月份。

### 阶段 D：真实建造切片

- 投影体素目标和建造材料候选。
- 提交 `combine`，显示构件虚影和建造动画。
- 逐刻重算结构，完成住所形成与乱纪元效果验证。

目的：证明第一人称行动会改变长期文明生存事实。

### 阶段 E：人物协作与项目

- 接入给予、材料请求、结构化沟通和项目参与。
- 保持自由文本模型对话非权威，并逐步评估是否接入 grounded `communicate`。

目的：让一个人物的局部行动能够通过他人和制度扩散，而不是变成单人沙盒。

## 17. 最小验证

只运行与改造风险直接相关的验证：

1. **执行器等价测试**：相同种子与输入，旧原子路径和新 `1..15` 循环得到相同最终状态 hash 与事件顺序。
2. **一步移动测试**：一次命令只跨一条相邻边；非法高度不消耗 tick。
3. **建造事实测试**：放置消耗一份真实材料，产生一条带正确 tick 的 ActionFact，并修改目标体素。
4. **住所拓扑测试**：只有真实屋顶、入口和围护形成后才投影可用住所；封死空间无效。
5. **冲突测试**：NPC 先占用目标体素后，玩家动作产生真实 blocked 事实且 tick 正常推进。
6. **幂等测试**：重复 `commandId` 不重复行动、扣料或推进 tick。
7. **恢复测试**：第 6 刻持久化并恢复后，视图、候选和重放 hash 一致。
8. **释放测试**：第 6 刻交还自主后恰好完成剩余 9 刻并提交一个月。
9. **无模型测试**：没有端点时完整完成逐刻移动与建造。
10. **前端模式测试**：活动化身期间不会触发普通自动 `/step`。

文档阶段不需要运行构建或模拟实验。

## 18. 验收不变量

- 玩家只能进入在世且当前分支存在的人物。
- 开始化身时没有另一个普通 step 或会话写操作在执行。
- 一个暂存月份始终绑定唯一文明、权威修订、分支、基础月份、人物和天象输入。
- 每个完成月份仍恰好执行 15 tick；有限化身不改变时间尺度。
- 玩家每 tick 最多提交一个合法世界行动，移动最多一条相邻边。
- 转头、查看目标和展开 HUD 不改变服务器状态。
- 所有材料、体素、结构、身体、关系和项目变化仍由领域动作产生。
- 前端从不维护第二套位置、库存、结构完成或文明发展事实。
- 其他人物在同一 tick 仍按现有稳定顺序行动，并能看到更早动作的结果。
- 紧急生存、照护、履约和必须回应仍可覆盖普通玩家意图。
- 模型缺席、失败或越界不阻止规则主链。
- 第 15 刻以前没有普通月度 `GameFrame`；第 15 刻只提交一次。
- 刷新恢复不重复行动；中途交还不回滚已经发生的刻度。
- 相同种子、分支、天象、冻结模型选择和玩家命令日志得到相同最终规则历史。

## 19. 主要风险与暂缓决策

| 风险 | 处理 |
| --- | --- |
| 把逐刻投影误当成已提交历史 | 使用独立 `EmbodimentView`，普通 history / frame 只读已提交月 |
| 为玩家另写一套动作规则 | 所有命令必须绑定应用层合法候选并走同一领域执行器 |
| 每刻持久化成本过高 | 持久化基础月 + 冻结输入 + 命令日志 + 哈希，恢复时最多重放 15 tick |
| 第一人称位置和体素视觉穿模 | 视觉碰撞只修相机；人物位置仍完全读取站立网格 |
| 建造退化为无约束 Minecraft | 近身、支撑、材料、知识、身体和项目约束不放宽 |
| 玩家一个人替代整个文明 | 高级能力仍要求知识传播、他人协作、项目和制度留下真实事实 |
| 对话等待模型拖慢逐刻体验 | v1 使用结构化沟通候选；自然台词在事实后投影或回退 |
| 暂存月份与 seek / save 冲突 | 服务端写锁互斥；先完成或 release，再执行分支与存档操作 |

暂缓到实现原型后再决定：

- 一次建造 action 是严格一体素，还是允许规则编译的“小构件”消耗一刻；v1 默认一体素。
- 是否允许点击较远地面创建自动行走意图；v1 默认仅 WASD 相邻一步。
- 断线超过实时会话恢复窗口后是否自动 release；v1 默认不自动推进，优先保留最后已提交月和可审计恢复错误。
- 自由文本对话何时成为真实 `communicate` 动作；必须先保证回复、候选选择和 tick 消耗的原子语义。
