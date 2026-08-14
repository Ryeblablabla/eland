# Eland 空间行动契约 v1

状态：当前空间执行原则；旧 `PlanMode / LLM-or-Mock` 接口已经由规则优先的 `Intent + PrimitiveAction` 取代。感知、决策边界、预算、寻路、交互距离与冲突处理仍然有效；§8、§11 中涉及二维属性层字段、`MatterStack` 与 `ComponentKind` 构件的细节已由物质体素模型取代，物质与结构的当前规则以[最小物质—人物—动作模型](../three-body/design/minimal-emergent-human-model.md)和 `domain/` 为准。
前置：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [像素世界](./pixel-world-v1.md) · [月度时间模型](./monthly-time-model-v1.md)

## 1. 目标

人物按“需要 → 局部认知 → 本地规划”选择目标；引擎把目标落实为受距离、地形、身体、物质和规划刻度预算约束的长期空间过程。

    世界与身体的当前事实
    → 每月 15 个规划刻度
    → 本地规划器创建、继续、修复或修改意图
    → 引擎预演并执行下一原子动作
    → 写入真实路径、进度和后果
    → 新事实进入后续刻度的局部感知与有限记忆

一个规划刻度不是固定一格，一次决定也不是一次完成行动。人物可以数月不更换长期目标，却在每月 15 个刻度中持续迁行、建造、耕作或照护。

## 2. 决策边界

正式本地规划器可以决定：

- 追求哪项需要；
- 从已知目标中选择哪个；
- 采用哪种本人已知的方法；
- 开始、继续、修改、挂起、恢复或放弃计划；
- 记录由事实支持的本地理由。

异步模型只能提出稳定语义的长期建议、玩家交互文本或创造性表达。建议必须在未来规划刻度重新进入本地规划与合法性校验，不能直接成为计划或动作。

引擎独占：

- 每个规划刻度的执行顺序与是否需要重评；
- 可见范围、目标是否已知；
- 格子可通行性与路径；
- 每月移动和工作预算；
- 材料是否存在及能否触及；
- 计划进度、完成、阻塞或失败；
- 结构、农业、身体和环境的客观效果；
- 事件与补丁的写入。

模型不接收完整世界，也不提交临时 option ID、路径数组、原子动作、持续月数或效果数值。

## 3. 局部感知

每个规划刻度由引擎为当前人物生成最新 PerceptionBundle：

    interface PerceptionBundle {
      atMonth: number
      originCellId: number
      visibleCells: VisibleCell[]
      visibleAgents: VisibleAgent[]
      visibleMatter: VisibleMatter[]
      visibleStructures: VisibleStructure[]
      rememberedTargets: RememberedTarget[]
      affordances: Affordance[]
      bodyConstraints: BodyConstraints
      activePlan?: PlanView
      recentActionFacts: ActionFact[]
    }

可见范围由 observe 能力、地形遮挡、当月天象、火、冰和身体状态共同决定。v1 可以先用半径与阻挡线近似，但必须在引擎内计算。

rememberedTargets 只来自人物亲历、带来源的传授或真实记录。记忆可以过时；到达后发现目标不存在，应产生阻塞和认知修正，不能静默替换目标。

## 4. 可供性

Affordance 是引擎根据眼前和有来源记忆生成的可选计划入口：

    interface Affordance {
      id: string
      goalDomain: "survival" | "production" | "social" | "inquiry"
      target:
        | { kind: "cell"; cellId: number }
        | { kind: "matter"; matterId: string; cellId: number }
        | { kind: "agent"; agentId: string; cellId: number }
        | { kind: "structure"; structureId: string; cellId: number }
      requiredRange: 0 | 1
      knownMethodIds: string[]
      visibleReason: string
      estimatedDurationBand: "one-month" | "several-months" | "long" | "unknown"
      estimatedCostBand: "low" | "medium" | "high" | "unknown"
      sourceFactIds: string[]
    }

可供性只表示人物有理由尝试，不承诺成功。durationBand 也是人物基于经验的粗略判断，不是引擎承诺。

## 5. 本地目标选择

以下 `PlanDecision` 是 schema 11 的过渡接口。当前本地规划器可以继续在内部使用 `ActionOption`，但持久化语义必须是稳定 `Intent.goal`，不能把临时 option ID 当成长期目标：

    type PlanDecision =
      | { kind: "start"; affordanceId?: string; exploration?: ExplorationIntent; methodId?: string; reason: string }
      | { kind: "continue"; planId: string; reason: string }
      | { kind: "revise"; planId: string; affordanceId: string; methodId?: string; reason: string }
      | { kind: "suspend"; planId: string; reason: string }
      | { kind: "resume"; planId: string; reason: string }
      | { kind: "abandon"; planId: string; reason: string }

规则：

- 已知目标可以在本地选择阶段引用 affordanceId，但提交后保存目标事实而非临时 ID。
- 未知世界只能选择 exploration，不能指定从未见过的远端 cellId。
- reason 是本地可审计理由，不是第二套执行指令；人物口吻可由异步模型补充。
- methodId 必须来自本人知识或眼前可模仿行动。
- 决策不能声明“完成建造”“治愈”或“成功取得”等客观结果。

## 6. 计划编译

引擎把本地选择编译为 Intent 和可执行阶段：

    interface Intent {
      id: string
      ownerId: AgentId
      domain: "strategic" | "social"
      goal: FactPredicate
      nextAction: PrimitiveAction
      target?: SpatialTarget
      status: IntentStatus
      createdAtMonth: number
      lastProgressAtMonth: number
      stateGoalUntilMonth?: number
      sourceFactIds: string[]
    }

常见阶段：

    approach target
    → acquire or prepare materials
    → perform bounded work
    → verify objective outcome
    → complete or remain active

一个建造意图可以先走到木材、搬运数月、再到工地逐构件施工。它仍是同一个目标下的长期意图，每一步都有独立事实。

## 7. 规划刻度预算

每个 planning tick 有受身体和环境约束的行动预算；一月最多执行 15 次：

    tickBudget =
      baseTickBudget
      × moveAbility
      × healthModifier
      × hydrationModifier
      × nutritionModifier
      × fatigueModifier
      × climateModifier
      × carryingModifier

移动与交互共享或分别占用预算，由计划编译器给出。预算不足时人物停在真实中间格，计划保持 active，下一个规划刻度从当前位置继续。

地形成本至少考虑坡度、水深、植被、冰、火、污染、结构阻挡和已有道路。数值在实现阶段校准，不写入模型提示词。

## 8. 寻路

v1 使用确定性 A*：

- 四方向邻接；
- 相同总代价时按 cellId 排序；
- 深水、火场和完整墙体默认阻挡；
- 人物知识决定能否选择远端目标，引擎事实决定路径是否真实可走；
- path 缓存失效时从当前位置重算；无法重算则计划 blocked；
- 计划路径本身不成为道路。

人物每实际跨入一个格：

- 通行痕迹按 `cellId:z` 计数（仅作派生统计，不再是格子属性层）；
- 当前 ActionFact 记录 planning tick 与压缩 path segment；
- 身体消耗更新；
- 必要时产生暴露、受伤或发现事件。

反复通行同时使地表物质逐步压实成路；观察器据此把连续格识别为 trail 或 road，前端直接绘制这些格。

## 9. 逐刻度推进

每个规划刻度中，active intent 按以下过程推进：

1. 再次确认目标和前置物存在。
2. 确认人物仍可行动。
3. 必要时计算或修复 path。
4. 在 monthlyBudget 内移动。
5. 到达 requiredRange 后执行本刻度可完成的工作量。
6. 保存剩余工作与当前位置。
7. 标记 active、completed、blocked 或 failed。

计划只在客观终止条件满足时 completed。例如 gather 达到目标数量、travel 到达目标、结构目标构件真实完成。

## 10. 交互距离

| 类型 | 距离要求 |
| --- | --- |
| 取、放、食用、饮水、点火、加工 | 与对象同格 |
| 照护、交换、表达、亲密 | 与目标同格 |
| 挖掘、清理、耕作、放置构件 | 同格或正交相邻，按动作定义 |
| 进入、休息 | 人物位于结构可达内部格 |
| 观察 | 由视线与 observe 能力决定 |

每月执行时重新检查距离。target 只说明计划对象，不能绕过空间限制。

## 11. 空间交互

### 11.1 采集与搬运

- take 从目标位置的掉落物堆扣减并写入人物私有背包。
- 采树作用于树木体素或树木实体，产生木材掉落物并改变该列物质组成。
- 放下物质时在人物当前格产生掉落物。
- 超过负重时只能部分取得或计划 blocked。
- 多月搬运保留每月底实际位置，不能在完成月瞬间跨图。

### 11.2 地面劳动

所有地面劳动都体现为体素物质变化，不再修改格子属性字段：

- clear 移除目标位置的植物体素，必要时产出植物掉落物。
- dig 改变土壤、岩石等物质柱构成，并连带改变派生的高度与水深。
- irrigate 必须形成与水体素连通且具有有效坡降的沟渠。
- cultivate 通过种子、水分与土壤物质的组合推进作物物质阶段（发芽、成熟、收获后土壤退化）。

### 11.3 建造

建造是把真实建筑物质放置为体素；不再存在 `ComponentKind` 构件清单或独立的 `PlaceComponentWork` 接口：

- 人物把木材、石、纤维等材料经加工后放入目标体素位置；
- 引擎逐月检查材料、承重、占用、邻接和可达性；
- 防护、围合与可达内部格由已放置体素的拓扑逐次重算（`domain/structure.ts`）；
- 工程可以在一个月内完成，也可以跨多月施工。人物声称造房子不会直接产生 shelter。

### 11.4 休息与持续使用

recover/rest 计划只在人物当前格执行。若位于有效结构内部，每个月记录一次真实 useEventId，并按客观防护改善暴露与恢复；否则就地休息。

居住、照护、交换等区域用途由跨月 useEventId 和事件流派生的活动统计派生，不由名称或 purpose 派生。

## 12. 同月冲突

所有人物先基于月初快照形成或保留计划，再按稳定顺序推进：

- 两人争取同一耗尽物质：先执行者取得，后执行者 blocked。
- 两人向同一格放置互斥构件：第一项成功，第二项 blocked。
- 交换、照护等双人行动要求双方执行时仍同格且可行动。
- 死亡、脱水或环境封锁可以中断当月计划。
- 同格允许多人存在；封闭结构容量影响防护、休息和拥挤效果。

冲突结果进入历史与局部感知，不做静默修正。

## 13. 规划刻度事实

每个实际动作生成一条可审计事实；无动作的稳定意图不需要生成“继续生活”文本：

    interface ActionFact {
      id: string
      kind: "action"
      atMonth: number
      planningTick: number
      orderInTick: number
      who: AgentId
      intentId?: string
      fromCellId: number
      toCellId: number
      pathSegment: CompressedCellPath
      targetCellId?: number
      status: "progressed" | "completed" | "blocked" | "failed"
      progressBefore: number
      progressAfter: number
      cost: { movement: number; interaction: number }
      diff: WorldDeltaRef
      result: string
    }

pathSegment 只记录本规划刻度实际走过的格。失败也记录最后位置、已付成本和原因。

意图改变另存 DecisionFact，引用其创建或修改的 intentId。这样历史能区分“人物改变主意”和“既有决定继续产生后果”。

## 14. 首个纵向样例

1. 权威树木格产生可采集木材。
2. 人物在局部感知中发现 gather affordance。
3. 某月的关键决策创建取得木材的计划。
4. 引擎连续数月移动、采集和搬运，每月留下 path 与 traffic。
5. 后续关键决策创建建造计划。
6. 人物逐月放置支撑、墙、屋顶和开口。
7. 引擎从拓扑和材料算出住所效果。
8. 人物实际进入并在不同月份休息。
9. 观察器从构件、休息和返回痕迹识别居住区域。
10. 前端按月显示全过程。

## 15. 验收不变量

- 决策器无法引用不可见且无记忆来源的目标。
- 人物不能在未到达时作用于远处格子。
- 没有新决策时，active plan 仍逐月推进。
- 预算不足留下中间位置和剩余工作。
- 每段道路都有实际 path 事实。
- 每个结构效果都能由构件重算。
- 同一月计划执行顺序确定且可回放。
- 失败不会被人物的自然语言解释改写为成功。
