# Eland 月度时间模型 v1

状态：核心纵向切片已实现（schema 11、月度时钟、概率决策、长期计划、滚动模型预算）
范围：three-body 人间世界的时间、决策触发、长期行动和播放节奏  
关联：[像素世界模型](./pixel-world-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [历史与回放](./pixel-world-history-v1.md) · [硬切换方案](./pixel-world-migration-v1.md)

## 1. 决策

世界的最小模拟步从“一年”改为“一个月”。

人物不再每年固定重新决定一次。每个人在每个月都有非零概率作出关键决策；如果没有重新决策，其既有计划由规则引擎继续推进。一个计划可以持续数月或数年，每个月留下位置、进度、身体消耗和世界变化。

关键分离：

    月度世界推进 ≠ 模型调用
    关键决策 ≠ 一次完成行动
    没有新决策 ≠ 人物没有行动

因此播放可以每月连续变化，而模型只在人物真正需要选择时参与。

## 2. 权威时钟

schemaVersion 11 使用明确的月度时钟：

    interface WorldClock {
      unit: "month"
      elapsedMonths: number
      monthsPerYear: 12
    }

`elapsedMonths = 0` 是文明初始态，尚未完成第一个月。每执行一次 `stepMonth`，完成一个月并加一。

显示纪年由 elapsedMonths 派生：

    completedYears = floor(elapsedMonths / 12)
    monthOfYear = elapsedMonths === 0 ? 1 : ((elapsedMonths - 1) % 12) + 1
    displayYear = elapsedMonths === 0 ? 1 : floor((elapsedMonths - 1) / 12) + 1

初始态显示“文明第 1 年 · 1 月 · 月初”；第一次推进完成后显示“文明第 1 年 · 1 月”。UI 可以选择显示“第 N 月”，但不能另存一套年计数。

SimulationState 不再以 `tick` 或 `civilizationYear` 作为时间权威。事件统一记录：

    interface EventTime {
      atMonth: number
      orderInMonth: number
    }

年龄、妊娠、疾病、记忆期限、预测期限和制度持续时间都保存月数。需要展示年数时除以 12，不做双份累计。

## 3. 月不是地球季节

“月”是文明内部的等长时间刻度，每 12 月构成一年；它不预设春夏秋冬。

三体世界的温度、光照、降水、冻结和火灾风险仍由当月 `SkySample` 与地表状态决定。不能因为 monthOfYear 是 7 就自动进入夏季。

每月有独立天象采样：

    interface MonthlySkySample extends SkySample {
      atMonth: number
      durationYears: 1 / 12
    }

宇宙时间继续连续推进；人间层只把对应区间聚合成当月可用的平均、极值和命运状态。

## 4. 人物长期计划

关键决策的结果不是立即修改世界，而是创建、继续、修改或放弃一个计划：

    type PlanStatus =
      | "active"
      | "suspended"
      | "completed"
      | "blocked"
      | "abandoned"
      | "failed"

    interface AgentPlan {
      id: string
      ownerId: AgentId
      objective: string
      mode:
        | "explore"
        | "travel"
        | "gather"
        | "carry"
        | "build"
        | "cultivate"
        | "care"
        | "trade"
        | "observe"
        | "record"
        | "recover"
      target: SpatialTarget
      methodId?: string
      status: PlanStatus
      createdAtMonth: number
      lastProgressAtMonth: number
      progress: number
      workRemaining?: number
      path?: number[]
      pathCursor?: number
      sourceDecisionEventId: string
      progressEventIds: string[]
      blockedReason?: string
    }

每个人最多有一个 active plan，可以保留少量 suspended plans。紧急生理需要可能挂起长期建造；危机解除后，人物可以重新选择恢复原计划。引擎不能自动把 suspended 计划解释成仍被本人认同，只能把它作为有来源的记忆目标再次提供。

## 5. 每月计划推进

没有新关键决策时，引擎按现有计划推进：

- travel：沿真实 path 消耗当月移动预算。
- gather：到达目标后逐月采集，直到数量满足、资源耗尽或身体不能继续。
- carry：负重会降低移动量，途中位置每月更新。
- build：每月只完成预算允许的构件运输或施工量。
- cultivate：按月进行清理、播种、照料、灌溉或收获。
- care：持续照护要求人物每月仍能接近对象并付出时间或物质。
- observe/record：累积足够观测月和真实载体后才形成成果。
- recover：休息位置和住所效果每月参与身体恢复。

每月推进都生成 `PlanProgressFact`。即使进度为零，也要记录阻塞原因；连续阻塞会提高下个月重新决策的概率。

## 6. 关键决策机会

每个月开始时，每个仍能行动的人都得到一个确定性抽样机会。概率不是统一常数，而由当前处境决定：

    decisionWeight =
      baseline
      + idleWeight
      + completedWeight
      + blockedWeight
      + urgentNeedWeight
      + surpriseWeight
      + socialRequestWeight
      - stableProgressWeight
      - recentDecisionWeight

所有存活且可认知的人 baseline 必须大于 0，因此即使计划进展稳定，也有小概率重新考虑。

建议语义：

- active 且稳定推进：低概率复核。
- idle 或计划刚完成：较高概率选择下一目标。
- blocked 多月：高概率改换手段或目标。
- 新出现的饥渴、疾病、火灾、死亡、求助或目标消失：强触发。
- 刚作出决策：短期降权，避免月月反复改主意。

抽样使用 `seed + branchId + elapsedMonths + agentId` 的确定性随机数。回放读取已存决策，不重新抽样；从过去分岔后在新 branchId 下形成新的机会序列。

## 7. 概率归一化

月度候选的期望数量维持在旧模型的年度量级：

    expectedDecisionSlotsThisMonth = livingAgentsThisMonth / 12

先计算每人的正权重，再归一化为个人入选概率：

    p_i = min(
      1,
      expectedDecisionSlotsThisMonth * weight_i / sum(allWeights)
    )

紧急触发可以把人物直接加入关键决策候选，但不自动突破模型预算。未被模型处理的紧急反应由确定性生存规则执行，例如逃离火格、饮用眼前水或停止无法继续的行动。

这个公式控制的是长期期望；实际某月可能无人决策，也可能多人同时决策。

人口变化时，任意连续 12 月的基准上下文数为：

    annualContextBaseline =
      sum(livingAgentsInMonth[m] for m in rolling12Months) / 12

因此预算随实际“人物月”变化，不会因为某个月恰好人口较多或较少而错误放大。

## 8. 决策内容

被选中的人物接收其局部 PerceptionBundle 和当前计划，返回：

    type PlanDecision =
      | { kind: "start"; intent: PlanIntent }
      | { kind: "continue"; planId: string; reason: string }
      | { kind: "revise"; planId: string; intent: PlanIntent }
      | { kind: "suspend"; planId: string; reason: string }
      | { kind: "resume"; planId: string; reason: string }
      | { kind: "abandon"; planId: string; reason: string }

决策器不能直接返回完成进度、成功结果、格子补丁或身体变化。引擎把 PlanDecision 编译为计划并在本月预算内开始执行。

## 9. 模型 token 预算

月度推进不能把模型用量放大 12 倍。预算以“人物决策上下文”和实际 token 双重约束。

### 9.1 决策槽

系统每月累积：

    decisionCredits += livingAgentsThisMonth / 12

每提交一个人物上下文给 LLM 消耗 1 credit。credit 上限建议不超过当前存活人数，避免长期无人决策后集中爆发。由此，连续 12 个月提交给 LLM 的人物上下文总量以同期人物月折算，不高于旧模型“大约每人每年一次”的量级。

候选超过 credit 时按紧迫度、等待月数和确定性次序选择；其余候选必须由 Mock 决策器处理，不得吞掉已经发生的关键决策机会。Mock 可以明确返回 continue 或暂时 idle，但这仍是一条带理由的 DecisionFact。

### 9.2 token 硬上限

仅限制上下文数量仍不能消除多批调用的提示词开销，所以还要设置滚动 12 月 token 上限：

    llmDecisionTokenBudget12Months =
      annualContextBaseline × configuredTokensPerDecisionContext

    llmSummaryTokenBudget12Months =
      configuredAnnualSummaryTokenBudget

调用前按载荷估算；余额不足则使用 Mock。调用后用 provider 返回的实际 usage 扣账。除非用户明确提高配置，月度系统不能突破这两个上限。

### 9.3 批处理与总结

- 同月所有候选合并成一次 batch decision 请求。
- 请求只包含候选人物的局部状态，不重复发送完整世界。
- 月度史册由规则模板生成，不调用总结模型。
- 每完成 12 个月最多调用一次年度总结模型，保持当前年度总结频率。
- 计划推进、寻路、身体结算、结构效果和观察器均不调用 LLM。

因此更细的播放来自更多引擎状态，而不是更多自然语言推理。

“不增加 token”是硬约束，不只是期望值：即使概率抽中了更多人物或月度请求产生了更多固定提示开销，滚动预算耗尽后也必须回退 Mock。计划是否延续由这次 Mock 决策明确给出，不能由预算系统替人物决定。

## 10. 月度执行顺序

同一个月严格按以下顺序：

1. 取得当月天象并更新地表环境。
2. 更新人物月初身体、需要和眼前感知。
3. 检查 active plan 是否完成、失效或受阻。
4. 为每个人计算关键决策概率并确定候选。
5. 在模型预算内批量决策，其余使用规则回退。
6. 编译新计划或更新旧计划。
7. 按稳定顺序推进所有 active plans 的一个月工作量。
8. 结算冲突、资源、身体、关系和环境后果。
9. 写入事件、世界补丁、人物记忆和观察结果。
10. 生成月度 GameFrame；每 12 月再生成年度聚合。

稳定顺序由 seed、branchId、elapsedMonths 和 agentId 产生并写入 MonthRecord。需要同月协作的计划引用共同 projectId，但每个人的真实投入分别结算。

## 11. 中断与失败

以下情况可以中断计划：

- 身体失去行动能力；
- 目标资源消失；
- path 被火、水、冰或结构阻断；
- 所需材料被他人取走；
- 当月出现更迫切的生理或安全危机；
- 人物在关键决策中主动挂起或放弃。

中断不抹掉已发生的路径和工作。已放置构件、已挖地面和已消耗物质继续留在世界中。

blocked 计划连续两个月无进展后，下一月显著提高决策权重；但引擎不擅自替人物改目标。

## 12. 时间尺度换算

月度化后，所有旧年度参数必须显式换算，不能原值照搬：

| 旧年度概念 | 月度规则 |
| --- | --- |
| 年龄 +1 | ageMonths +1，显示时除以 12 |
| 一年身体消耗 | 分为 12 次月度消耗，并重新校准非线性风险 |
| 妊娠一年内结算 | 用 gestationMonths 和 dueAtMonth |
| 疾病持续年数 | durationMonths |
| 预测 dueTick | dueAtMonth |
| 跨年实践 | 至少跨多个不同月份，并按目标另设最低月数 |
| 每年一次行动 | 概率关键决策 + 每月计划推进 |

概率不能简单除以 12。若旧年度事件概率为 P，对应独立月概率为：

    p_month = 1 - (1 - P)^(1/12)

身体、生态和人口规则应按过程重新校准，而不是机械套用所有旧常数。

## 13. GameFrame 与播放

GameFrame 的权威时间字段改为：

    interface GameFrame {
      elapsedMonths: number
      calendar: {
        year: number
        month: number
      }
      skySample: MonthlySkySample
      ...
    }

`civilizationYear` 不再是权威字段。年度数由 elapsedMonths 派生。

为了连续播放，SocietyWorldView 还应暴露：

- 人物本月起点、终点和实际 path segment。
- active plan 的短标签、状态和客观 progress。
- 本月新增或改变的格子与构件。
- 本月交通、休息、照护等痕迹增量。

前端在两个权威月帧之间插值人物移动和施工表现；插值不能越过实际 path，也不能提前显示月底才完成的结果。

### 13.1 连续播放缓冲

自动播放采用小型月帧缓冲：

- 后端始终按月串行推进并产出每个月的 MonthFrame。
- 客户端预取建议 3–6 个月，但按顺序消费，不能越过未展示的中间月。
- 普通速度下每个月至少展示一次人物移动、施工或环境过渡。
- 快进可以缩短每月展示时间，但仍应用每个月的 patch。
- 某月需要模型而后端尚未完成时，前端停留在最后权威帧；不得在等待期间伪造移动。
- 缓冲恢复后继续播放，不改变模拟结果。

批量推进接口必须返回有序的 MonthFrame 或 MonthPatch 数组，不能只返回批次最后状态，否则长期行动又会在画面上瞬间完成。

## 14. 验收不变量

- 推进 12 个月才使年龄增加一岁。
- 没有新模型决策时，active plan 仍能逐月产生进度。
- 一个三个月计划在历史中有三份独立进度事实。
- 每个人每月都有非零关键决策概率，确定性回放结果一致。
- 连续 12 月的 LLM 人物上下文与实际 token 均不超过配置的旧年度预算。
- 月度总结不调用 LLM；年度总结最多一次。
- 计划中断不撤销此前真实世界变化。
- UI 的月内动画严格沿当月权威 path 和进度。
