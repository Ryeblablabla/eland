# ELAND 人物 Agent 架构

状态：当前权威设计。文件名为兼容旧链接保留 `v1`。

## 核心边界

```text
规则决定：世界允许什么、动作是否合法、行动后发生什么。
模型决定：人物注意什么、相信什么、想追求什么、怎样尝试、对谁说什么。
```

模型不是世界裁判，本地也不再先替人物决定方向。

没有模型时，生存、照护、义务、已知生产、既有项目和保守探索仍能完整运行；模型模式增加自主目标、假说、试验、协商和反思，不要求两种模式产生相同文明。

## 唯一主链

```text
WorldEvent
→ 局部感知
→ PersonMind
→ MentalAct
→ 增量编译当前一步
→ Intent
→ PrimitiveAction
→ ActionFact
→ 人物可感知结果
→ 更新 PersonMind
```

每月仍执行 15 个 planning tick。月初先形成一次 MentalAct；月内真实沟通、观察、试验结果或失败可以在下一 tick 前触发同一人物的新 MentalAct。每人每月最多两次模型心智转折，触发者按 tick 批量请求；普通移动、搬运和稳定项目步骤仍只由规则执行。

## PersonMind

每个人持久化一个 `person.mindMarkdown`。它是人物 Agent 的唯一记忆文档，而不是四组并列数组：

```markdown
---
version: person-mind-markdown-v1
person: person-id
through_month: 12
---

# 当前关切
# 经历
# 信念
# 最近思考
```

本地 `MindWriter` 从已提交的个人事实、旧 codec backing 和 MentalAct 确定性重写这份文档；模型不能编辑它。决策前，本地 `MindCompiler` 把文档编译成瞬时视图供规则代码使用：

```ts
interface PersonMindView {
  markdown: string;
  episodes: RecalledMemory[];
  beliefs: RecalledMemory[];
  concerns: ConcernView[];
  deliberations: MentalAct[];
}
```

- `episodes`：本人经历过的行动、对话、发现与失败。
- `beliefs`：知识、地点、关系和行动结果的当前主观看法。
- `concerns`：仍想完成或弄清的长期方向。
- `deliberations`：本人最近形成、但不自动等于真实世界结论的 MentalAct。

模型收到的是清除本地编译元数据后的 `mind.markdown`，不再收到独立的 episodes / beliefs / concerns / deliberations 数组。旧存档中的 `person.memories`、`knowledge`、`knownPlaces`、`relations`、`cognition`、`characterAgenda` 和根级 `memoryStore` 暂时保留为 codec backing；新人物、旧 schema 17 恢复和每次月末提交都会保证每个人已有一份 Markdown。

人物观察界面的“记忆”卡片也直接读取这份 Markdown，并按四个固定章节渲染；它不再用另一套 recall 列表冒充人物当前心智文档。`remembered[]` 暂时只保留在外部读取协议中兼容旧调用方。

## MentalAct

模型一次只形成一项主观心智动作：

```ts
interface MentalAct {
  version: 'mental-act-v1';
  kind: 'pursue' | 'investigate' | 'talk' | 'reconsider' | 'continue' | 'wait';
  goal: string;
  strategy: string;
  assumptions: string[];
  expectedObservation?: string;
  sourceEventIds: string[];
}
```

`MentalAct` 证明“人物这样想过”，不证明其假说、预测或办法正确。它随 `DecisionFact` 保存并在以后进入本人的 deliberation history。

模型可以：

- 采用新的目标；
- 对未知机理提出假说；
- 形成不完整、可失败的策略；
- 说明采取下一步后期待观察什么；
- 发起交流、请求、交换和协商；
- 根据真实结果继续、修正、暂停或放弃方向。

模型不能：

- 声称未发生的结果已经发生；
- 读取隐藏配方、全局地图、文明指标或他人私有状态；
- 直接改变体素、身体、库存、知识、关系、协议和项目进度；
- 把想象、措辞或总结升级成世界事实。

## 增量编译

模型可引用 `availableSteps` 中的一个 `firstStepHandle`。该列表只是人物当前可以尝试的下一步，不是完整计划、推荐排序或成功保证。

本地编译器只做：

1. 校验请求句柄属于本人当前上下文；
2. 把当前步骤映射成兼容 `Decision / Intent`；
3. 在动作提交前重新检查当前可见、持有、同意和空间条件；
4. 把真实动作交给领域执行器。

它不得因为权威规则知道某个长期方案会失败，就在人物实际观察和试错前返回失败原因。

### 三类失败

| 类型 | 处理 |
|---|---|
| JSON、未知句柄、跨人物引用 | 协议重试；不进入人物历史 |
| 人物已经看见或知道的障碍 | 编译为接近、取得、询问、观察等准备动作 |
| 材料机理、远处障碍、容量、他人选择等未知 | 真实观察或尝试后产生 ActionFact，再进入人物经验 |

计划只展开到认知边界。路径进入未知区域、材料结果未验证、设施状态未观察或社会同意未取得时，系统生成局部移动、观察、小规模试验或沟通，不生成全知答案。

执行协议中的空间占位符不是人物概念。尤其是 `Air` 只表示尚未占用的安装位置；内部兼容 `combine` 即使负责把木材加工并安装为木板，也只能把“加工、播种、改造、安装”等工艺写入知识和对话，不能生成“木材与空气结合”一类字面配方。

## Concern、Intent、Project

```text
Concern：我长期仍在意什么
MentalAct：我此刻怎样理解、准备怎样试
Intent：当前已经落地的一段执行
Project：世界中持续存在的共同工作
```

没有当前可尝试步骤的 `pursue / investigate` 可以先形成 concern。方法失败只改变策略和结果信念，不自动删除目标。

已有 `Intent` 稳定且仍有进展时继续执行；生存反射、必须回应和履约可以优先或临时中断。项目每个 tick 根据最新世界编译下一步，不把整条未来行动链冻结为已知事实。

## 本地保守策略

本地 `RulePlanner` 只按四段工作：

```text
生存反射
→ 必须回应 / 履约
→ 当前 Intent 持续
→ 无模型时的保守自由选择
```

合法性和义务在评分前处理。普通候选使用可解释的加法偏好，不再由长乘法 gate 链让一个小因子吞掉全部动机。

模型请求前不预先计算本地选择。只有模型超时、协议非法、额度不足或提交前步骤已经失效时，才调用保守本地策略。

## 模型触发

模型在认知事件上参与，而不是每个物理 tick 调用：

- 当前没有 Intent；
- Intent 连续没有可见进展；
- 出现显著新观察或原假说被反驳；
- concern 到达复核点；
- 出现自主交流、协商或回应选择；
- 玩家对话明确要求人物考虑下一步。

普通预算按一个 living person-month 产生一个模型上下文额度；请求仍可批量发送，世界执行不依赖网络成功。

月内事件触发使用独立的有界额度，不回头改写已经执行的 tick。模型只读取当前 tick 之前已经形成的 ActionFact；输出在下一 tick 写成带真实 `planningTick` 的 DecisionFact。回放已有月份时不重新调用模型。

## 对话

模型决定是否开口、对谁、为了什么和准备说什么。规则校验语音范围、参与者、来源事实、同意、物品和协议，并先提交真实沟通 ActionFact。沟通是语言通道：一个完成的沟通子 Intent 可以在同一 planning tick 恢复父 Intent，并继续移动、取得、制作或观察；狩猎、生殖、休眠出入等高占用身体动作仍与说话互斥。听见本身不占听者的身体动作，主动回应占用其语言通道。最终可见台词仍由 Voice Contract 生成或复用已验证的 decision utterance。

说出的猜测仍是猜测。听者可以记住、相信、质疑或拒绝，但语言本身不创造知识、关系分数、承诺和制度。

## 记忆

模型不再拥有 `memoryConsolidation`。具体经历由确定性容量、模糊和遗忘策略处理；不得用模型 gist 破坏性替换原事件。

模型能做的是基于经历形成新的 MentalAct：修正信念、采用假说、改变策略或放弃 concern。只有实际观察结果能够更新规则可读知识与行动结果后验。

## 回放与兼容

- HTTP、`BatchDecider`、`DecisionFact`、`Intent` 和存档根结构暂时保持兼容。
- `firstStepHandle` 在服务端映射为旧 `optionId`，模型永远不直接看到或输出长期内部 ID。
- 已提交 MentalAct 保存在 DecisionFact 中，回放不重新调用模型。
- 旧心智字段只允许留在 codec / compatibility adapter；新 Agent 逻辑不得继续增加直接读取点。

## 完成标准

- 模型输入只有 PersonMind、current、visible、availableSteps 和当前义务。
- 模型输出是 MentalAct，不是 start / revise / optionId。
- 模型之前没有预先选好的本地答案。
- 隐藏失败只能经世界内观察或试错暴露。
- 模型缺席时模拟可运行，但自主目标、实验和社会分叉明显更保守。
- 删除的旧选择、巩固和特殊分支代码多于新增兼容代码。
