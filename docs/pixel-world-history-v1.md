# Eland 像素世界历史与回放 v1

状态：月度事件、帧、快照、模型账本与进程内非破坏分支已实现；持久化稀疏补丁仍待实现
前置：[像素世界模型](./pixel-world-model-v1.md) · [月度时间模型](./monthly-time-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md)

## 1. 目标

像素世界的历史必须同时满足：

- 世界保留过去事实；
- 人物只访问自己的有限记忆；
- 任意月份可以精确回放；
- 长期计划在每个月都有可追溯的实际进度；
- 从过去分岔后，旧未来仍可审计；
- 不为每个月永久复制整个 84×52 世界；
- 回放不重新调用决策模型。

## 2. 当前问题

当前 ElandSession 每年保存一份 GameFrame 和一份完整 SimulationState，最多 600 年，且主要驻留内存。FileRunStore 保存最新完整 state.json，但没有逐格补丁、长期计划记录或分支历史。

月度网格引入后改为：

    初始快照
    + 每月决策与计划进度事实
    + 每月稀疏补丁
    + 每 240 个月完整检查点
    + 每 12 个月聚合摘要

240 个月等于 20 个显示年。检查点间隔以月存储，不另设年度计数。

## 3. 运行记录

    interface PixelWorldRun {
      runId: string
      schemaVersion: 11
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

所有 MonthRecord 都属于 branchId。回溯续演创建新分支，不删除原分支事实。

## 4. 初始快照与检查点

检查点包含恢复模拟所需的完整权威状态，包括活动与挂起计划、决策预算账本和月度时钟：

    interface WorldCheckpoint {
      branchId: string
      atMonth: number
      state: EncodedSimulationState
      stateDigest: string
    }

策略：

- month 0 总有完整检查点。
- 此后默认每 240 个月生成检查点。
- 文明结束、导出或手动保存时可额外生成。
- generator.version 和初始密集层随 month 0 保存。
- schemaVersion 11 存档总是读取已保存网格，不依赖当前生成器重建。

TypedArray 在 JSON 存储中使用明确编码：

    interface EncodedDenseLayer {
      type: "u8" | "u16" | "i16"
      encoding: "rle"
      length: 4368
      data: number[]
    }

v1 先用 RLE JSON；若实测数据更大，再换二进制容器，逻辑契约不变。

## 5. 月度记录

    interface MonthRecord {
      branchId: string
      atMonth: number
      parentMonth: number
      executionOrder: AgentId[]
      decisionCandidates: AgentId[]
      llmDecisionAgentIds: AgentId[]
      decisionBudget: DecisionBudgetLedger
      skySample: MonthlySkySample
      events: WorldEvent[]
      delta: WorldDelta
      observations: ObservationDelta
      summary: FrameEntry[]
    }

events 至少区分：

- DecisionOpportunityFact：确定性抽样及触发原因。
- DecisionFact：人物开始、继续、修改、挂起、恢复或放弃计划。
- PlanProgressFact：既有计划当月实际移动、工作、阻塞或完成。
- EnvironmentFact：当月天象和环境过程。

月度规则摘要不调用 LLM。每完成 12 个月，YearSummaryRecord 聚合对应月份；年度总结模型最多调用一次。

## 6. 世界补丁

WorldDelta 只记录当月实际变化：

    interface WorldDelta {
      cellPatches: CellPatch[]
      matterPatches: EntityPatch<MatterStack>[]
      componentPatches: EntityPatch<StructureComponent>[]
      structurePatches: EntityPatch<StructureState>[]
      agentPatches: EntityPatch<AgentState>[]
      planPatches: EntityPatch<AgentPlan>[]
      tracePatches: TracePatch[]
      civilizationPatch?: EntityPatch<CivilizationState>
      clockPatch: { elapsedMonths: number }
    }

CellPatch 使用字段掩码：

    interface CellPatch {
      cellId: number
      fields: Partial<{
        terrainKind: number
        elevation: number
        fertility: number
        waterDepth: number
        surfaceCover: number
        moisture: number
        temperature: number
        vegetation: number
        fire: number
        ice: number
        contamination: number
      }>
      sourceEventIds: string[]
    }

EntityPatch 使用 create、update、delete。删除也要保留 sourceEventIds，避免物质、构件或计划凭空消失。

## 7. 事件与补丁

事件说明“发生了什么”，补丁说明“权威状态改成什么”。

- 每个补丁必须引用至少一个当月事件。
- 每条 DecisionFact 必须引用创建或改变的 planId。
- 每个 active plan 每月至少有一条 PlanProgressFact，即使进度为零。
- 每个 progressed/completed 事实必须引用对应 delta。
- 纯解释和记忆变化只能修改人物，不得伪造世界补丁。
- 环境演化必须产生 EnvironmentFact，不能后台静默改格子。
- 决策预算的 credit 和 token usage 是权威账本的一部分，保证分岔后可审计。

回放以补丁恢复状态，以事件解释历史。生产回放不重新抽取决策机会、不重跑 LLM。

## 8. 恢复与回放

读取某月：

1. 在同一 branch 找到不晚于目标月的最近检查点。
2. 解码完整状态。
3. 按 atMonth 顺序应用 MonthRecord.delta。
4. 恢复 active/suspended plans 和决策预算账本。
5. 重算可安全派生的视图：可供性、区域、道路分段、SocietyWorldView。
6. 返回目标月 GameFrame。

回放不得：

- 调用 LLM；
- 重新抽取该月关键决策概率；
- 使用当前版本生成器重建地形；
- 用当前规则重新裁决旧事件；
- 依赖前端随机数。

## 9. 分岔

当用户从第 N 月继续演化：

- 原 branch 保持不变。
- 新 branch 的 parentBranchId 指向原 branch。
- forkAtMonth = N。
- 新分支复用 N 月前的检查点和 MonthRecord。
- N+1 月开始使用新 branchId 抽取决策机会并写入新记录。

分岔后概率序列可以改变，因为 branchId 是确定性随机输入之一；分岔点以前仍完全一致。

## 10. API 与播放

保留 begin、step、history、frame、seek 的基本语义，但单位改为月：

- begin 返回 month 0 的完整 SocietyWorldView。
- stepMonth 返回一个月的 GameFrame 与 WorldViewPatch。
- step 可以接受 months 数量；服务端按月顺序执行，不能跳过中间计划推进。
- frame(atMonth, branchId) 返回该月完整视图。
- history 返回月份摘要、年度聚合和分支元数据。
- seek(atMonth) 创建并切换新分支，不截断原数组。

前端实时推进只应用 revision 连续的补丁。若缺失月份或 revision 跳号，重新请求完整 frame。

播放速度只影响多快请求或展示月帧，不改变模拟时间。人物在两个相邻月帧之间沿当月 pathSegment 插值。

## 11. 模型用量审计

每个 MonthRecord 保存：

- 本月所有 decisionCandidates。
- 交给 LLM 的 agentIds。
- Mock 处理或保持原计划的 agentIds。
- 月初、月末 decisionCredits。
- 本月估算 token、实际 input/output token。
- 滚动 12 月预算余额。
- 是否生成年度模型摘要。

验收时按任意连续 12 个 MonthRecord 求和，人物决策上下文和实际 token 都不得超过配置的旧年度预算。

## 12. 内存与持久化

- 活动会话缓存当前状态、最近检查点和少量月帧。
- MonthRecord 按运行持久化，不依赖进程内 Map。
- 缓存上限不是历史删除策略。
- state.json 可以保存最新检查点作为快速入口，但不是唯一历史来源。
- 月度 GameFrame 可以比完整 MonthRecord 更早淘汰，因为可从检查点和补丁恢复。

## 13. 旧档切断策略

schemaVersion 10 使用年度时钟和六地点空间，没有逐月或逐格事实，不能可靠映射到新模型。

- schemaVersion 11 只创建新文明，不接续 schemaVersion 10 运行。
- 读取 schemaVersion 10 时返回明确的版本不支持错误。
- 旧档只允许导出 JSON 或历史摘要，不能导入为可继续演化的像素世界。
- 新文明使用新的 runId，避免两种时空语义混在同一时间线。

这是有意的模型断代：不推测从未发生过的月份、路径、位置或行动进度。

## 14. 最小验证

- 连续推进 245 个月，可由 month 240 检查点和 5 份补丁恢复 month 245。
- 同一目标月的直接状态与恢复状态权威字段一致。
- 一个持续三个月的计划有三条 PlanProgressFact。
- 从第 10 月分岔不会删除原分支第 11 月以后的记录。
- 回放过程中模型调用次数为 0。
- 任意连续 12 月的决策上下文数和实际 token 不超过预算。
