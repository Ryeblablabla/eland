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
→ Mind intention
→ Model Plan
→ Execution 本地编译
→ Intent
→ PrimitiveAction
→ ActionFact
→ 人物可感知结果
→ 更新 PersonMind
```

每月仍执行 15 个 planning tick。月初先由 Mind 形成意图；需要落地的新方向再交给 Plan，Plan 读取冻结意图并形成领域规划。Execution 把当前规划入口编译为既有 Intent / Project / HTN 并逐 tick 执行。月内真实沟通、观察、试验结果或失败可以在下一 tick 前触发新意图；普通移动、搬运和稳定项目步骤仍只由规则执行。

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

模型收到的是从 `mind.markdown` 确定性提取、数量有界的当前关切、近期经历、已形成信念和最近思考，不直接收到整份 Markdown 或独立的内部 AST。请求保留 `m1…m6`、`g1…g4` 来源句柄，但去除编译元数据、重复内容和无关旧条目。旧存档中的 `person.memories`、`knowledge`、`knownPlaces`、`relations`、`cognition`、`characterAgenda` 和根级 `memoryStore` 暂时保留为 codec backing；新人物、旧 schema 17 恢复和每次月末提交都会保证每个人已有一份 Markdown。

人物观察界面的“记忆”卡片也直接读取这份 Markdown，并按四个固定章节渲染；它不再用另一套 recall 列表冒充人物当前心智文档。`remembered[]` 暂时只保留在外部读取协议中兼容旧调用方。

## Mind、Plan 与兼容 MentalAct

Mind 一次只形成一项意图：

```ts
interface MindIntention {
  utterance: string;
  delivery: 'whisper' | 'normal' | 'call';
  goal: string;
  orientation: 'social' | 'inquiry' | 'survival' | 'construction' | 'acquisition' | 'exploration' | 'rest';
  horizon: 'momentary' | 'ongoing';
}
```

Mind 不读取 availableSteps、continuations 或带实体句柄的 actionSpace，也不输出策略、实验、动作或 concern 生命周期命令。它额外看到由两者按类型归并出的 `actionPossibilities`，只知道此刻大致能观察、取材、交谈、移动、继续项目或进行哪类试验，不知道具体候选、句柄、排序和结果。它看到的 current 只保留正在承担的事项摘要与社会承诺，不含执行进度、下一动作类型和项目材料状态。`utterance` 是本次意图形成时唯一外发的第一人称语言波。

创世先民的第一次 Mind 调用会收到一次性开局背景与宽泛初始意图：共同抵达、随身物资和“尚未形成持续工作”等内容来自零月权威事实，初始意图按人物当轮性格注意方向确定性投影。它只给人物一个进入世界时已经在意的方向，不给行动清单、隐藏配方或文明发展任务；之后不再重复注入。

每个人物还从 baseline HEXACO 确定性投影一个终身稳定的 MBTI 角色写作预设，并把抽象的注意方向、内在张力、反应倾向和表达倾向放在单人 Mind 上下文末尾。预设不再带内容性的示例台词，以免人物共同模仿一个无来源话题。它只塑造 goal 与 utterance，不进入 Plan，不创造经历、事实、能力或合法行动。多人决策时，每个人物的 Mind 分别调用，避免不同人格在同一批请求中互相带偏；冻结意图之后的 Plan 仍可批量处理。

Mind 形成的意图进入第二次 Plan 调用。Plan 读取冻结意图、当前可见对象、动作空间和 Execution 可接纳的入口，输出按实际需要组织的领域 `steps`，不规定固定步数。Mind 的 `orientation` 是看到行动菜单前选定的意图方向；Plan 只能选择真正推进该方向的入口，没有匹配项就 `stay` 并保留意图。当前入口随后由 Execution 编译为既有多步 Intent；Plan 不直接改变世界，服务端仍把两阶段结果合并为兼容 MentalAct / DecisionFact 以维持存档与回放。

模型可以：

- 采用新的目标；
- 形成或保留主观意图；
- 由 Plan 为意图形成可失败的领域规划；
- 发起交流、请求、交换和协商；
- 根据真实结果继续、修正、暂停或放弃方向。

模型不能：

- 声称未发生的结果已经发生；
- 读取隐藏配方、全局地图、文明指标或他人私有状态；
- 直接改变体素、身体、库存、知识、关系、协议和项目进度；
- 把想象、措辞或总结升级成世界事实。

## Plan 与 Execution

只有 Plan 可引用 `availableSteps` 中的 `firstStepHandle`；Mind 看不到这份列表。它只是 Execution 当前能够接纳的规划入口，不是完整计划、推荐排序或成功保证，普通入口不设人为数量上限。模型仍看不到本地 need urgency、motivation、aspiration、expectedSuccess、候选排名、精确身体小数、人格量表、坐标和内部 material profile 枚举。

本人持有物会完整进入 Plan 的 `actionSpace.heldObjects`，不截取前 6/8 项；附近对象与可见表面只在 `visible` 发送一次。`actionSpace.operations` 说明 `observe / combine / expose / exert / move` 的人类含义。Plan 不能改写冻结的 goal、utterance 或 delivery。

本地编译器只做：

1. 校验 Plan 请求句柄属于本人当前上下文；
2. 把当前规划入口映射成兼容 `Decision / Intent`；
3. 在动作提交前重新检查当前可见、持有、同意和空间条件；
4. 把真实动作交给领域执行器。

对于有知识、预言、协议或权限后果的沟通，编译器会核对人物实际发出的 `utterance` 是否明确表达同一含义；不一致时只记录普通话语，不允许隐藏的结构化载荷替人物教学、预言或承诺。

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

## 统一语言波

每个模型决策只播出一条 `utterance`，并携带 `whisper / normal / call` 强度。没有“心念”和“说话”两种通道；选择社会性 `talk` 时，对应 ActionFact 复用 DecisionFact 的同一条波，用实际解码结果生成逐人解释，不再次广播。纯规则产生、没有模型 DecisionFact 原话的 talk 才独立形成一条语言波。所有语言都没有收件人、受众或声道字段，只从发出者头部体素向整个有限世界传播。

传播在三维体素网格上以材质阻力运行 Dijkstra 最低代价路径：开阔空气代价最低，植被与树叶产生散射，液体衰减，木材、砖石、金属和保温材料阻力更高。声音可绕过墙体或穿透墙体，取总代价较低者；低声在封闭屋内更难外泄，呼喊在空地上传得更远。距离和材质代价只连续改变概率与字符混淆，不形成绝对听见 / 绝对听不见的阈值。

`LanguageBroadcast` 只保存原始字符串、路径代价和逐人信号回执，不携带请求、承诺或其他语义对象。成功解码后才为该人物生成 `listener-language-interpretation-v1`；知识、协议、回应候选和关系证据只能读取解释结果。说出的猜测仍是猜测，单纯感知也不自动增加关系分数或创造制度。

## 记忆

模型不再拥有 `memoryConsolidation`。具体经历由确定性容量、模糊和遗忘策略处理；不得用模型 gist 破坏性替换原事件。

行动后果也必须先经过人物感知再进入记忆。捕猎造成动物受伤或死亡时，执行器按每个在世人物当刻的局部视野记录 `witnessedBy`；行动者记住自己的结果，视野内见证者记住亲眼看到的伤亡，视野外人物不得取得这条事实。动物死亡会让行动者和真实见证者进入下一 planning tick 的心智复核，但规则不直接删除或改写 concern / Intent。

模型能做的是基于经历形成新的 MentalAct：修正信念、采用假说、改变策略或放弃 concern。只有实际观察结果能够更新规则可读知识与行动结果后验。

## 回放与兼容

- HTTP、`BatchDecider`、`DecisionFact`、`Intent` 和存档根结构暂时保持兼容。
- `firstStepHandle` 在服务端映射为旧 `optionId`，模型永远不直接看到或输出长期内部 ID。
- 已提交 MentalAct 保存在 DecisionFact 中，回放不重新调用模型。
- 旧心智字段只允许留在 codec / compatibility adapter；新 Agent 逻辑不得继续增加直接读取点。

## 完成标准

- Mind 输入包含语义化 person、mind、current、visible、当前义务和无句柄的粗粒度 actionPossibilities，不含 availableSteps 或完整 actionSpace。
- Plan 单独读取冻结意图、availableSteps、continuations 与 actionSpace，输出领域 steps 和当前 Execution 入口，不设固定计划长度。
- Execution 保留物理合法性、规则编译与后果权威，不替模型改写意图或规划。
- 模型之前没有预先选好的本地答案。
- 隐藏失败只能经世界内观察或试错暴露。
- 模型缺席时模拟可运行，但自主目标、实验和社会分叉明显更保守。
- 删除的旧选择、巩固和特殊分支代码多于新增兼容代码。
