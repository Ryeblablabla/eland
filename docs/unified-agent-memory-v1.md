# ELAND 统一人物记忆 v1

状态：v1 已实现，仍随真实会话审阅与长程实验校准。本文规定人物怎样记住、压缩、模糊、遗忘和召回亲历；它不把玩家审计历史、文明纪事或模型文本当成客观世界事实。

关联：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [文明演化双闭环与实验协议](./evolution-iteration-loop-v1.md)

## 1. 问题

当前人物的情节记忆、知识、空间地点、关系、行动后验、社会后验、长期关切与模型原话分别由不同调用方读取。玩家行动历史可以显示真实模型台词，但人物自己只保存 `ActionFact.result` 的间接摘要；模型每轮又分别截取若干 memory、knowledge 和 SpeechLine。

这会产生三个直接后果：

- 行动流水替代了真正的选择性记忆；
- 真实对话没有进入人物的主观连续性，下一轮容易重新开场；
- 经历不能稳定形成“仍在意什么”，只能在已有候选出现后提供少量评分证据。

## 2. 核心边界

统一的是人物的写入、巩固、检索和遗忘入口，不是把所有领域事实塞进一个无类型数组。

```text
权威世界事件 / 项目 / 协议 / 关系余额 / 物理状态
                         │
                         ├─ 领域规则继续直接裁决
                         │
                         └─ owner-scoped MemoryStore
                              ├─ episodic      亲历的具体事情
                              ├─ semantic      本人相信的知识与地点
                              ├─ social        对具体人的关系与合作判断
                              ├─ procedural    本人做某类事的结果后验
                              ├─ prospective   未解决承诺、关切和计划线索
                              └─ dialogue      本人说过或亲耳听见的话
                                      │
                                      ├─ consolidate / blur / forget
                                      └─ retrieve(current situation)
                                             ├─ 本地 BDI
                                             ├─ CharacterAgenda review
                                             ├─ 模型 decision / interaction
                                             └─ ConversationEpisode
```

`WorldEvent` 仍是已经发生之事的权威；`KnownFact` 仍决定人物是否可靠掌握技术；`Relation` 仍是当前关系余额；`CharacterAgenda` 仍是长期主观关切；`Intent` 仍是唯一当前执行焦点。MemoryStore 只能说明“这个人现在还能怎样回忆或概括这些来源”。

玩家行动历史和文明纪事是观察投影。它们可以比人物记得更完整，但人物不能反向读取它们。

## 3. 统一召回项

所有召回结果使用同一只读结构：

```ts
interface RecalledMemory {
  id: string;
  lane: 'episodic' | 'semantic' | 'social' | 'procedural' | 'prospective' | 'dialogue';
  gist: string;
  precision: 'exact' | 'specific' | 'general' | 'faint';
  confidence: number;       // 0..100，本人对这份记忆的把握，不等于客观真值
  salience: number;         // 0..100
  emotionalValence: number;// -1..1
  personIds: string[];
  topicKeys: string[];
  sourceEventIds: string[];
  unresolved: boolean;
  lastExperiencedAtMonth: number;
  lastRecalledAtMonth: number;
}
```

不同 lane 可以继续由现有专用状态承载；MemoryStore 负责把它们投影为统一召回项，并保存无法从现有状态表达的巩固簇、对话记忆与 live conversation coordination。

## 4. 写入

### 4.1 普通经历

领域动作完成后仍只学习一次。MemoryStore 的 `writeExperience` 委托现有 `rememberAction`、cognition 和 socialLearning 更新，不重复增加成功率、关系或知识。

只有本人行动、本人受到的直接后果、真实见证或真实沟通才能写入 owner-scoped 记忆。全局事件、观察器阶段和他人私有事实不能进入。

### 4.2 真实对话

模型台词只有在对应 `completed voice talk` ActionFact 已存在且参与者可核验后，才写入双方的 dialogue memory：

- 说话者记得“我说过什么”；
- 听者记得“我亲耳听见什么”；
- exact text 只是“有人说过这句话”的主观事实，不自动成为知识、同意、履约或关系增长；
- blocked / failed 动作、孤儿 reply 或分支不匹配的台词不写入；
- 玩家与人物的真实回复也可走同一 lane，但必须绑定该分支的交互记录，不能成为世界客观事实。

## 5. 巩固、模糊与遗忘

记忆不是一次性删除，而是逐层失去细节。

```text
exact        具体事件与短期逐字原话
  ↓
specific     人物、结果和核心因果仍清楚，措辞开始消失
  ↓
general      多次相近经历合并为概括与倾向
  ↓
faint        只剩主题、情绪方向或“我似乎遇到过”
  ↓
forgotten    不再可召回；权威历史仍存在
```

巩固按人物、参与者、语义 basis、未解决状态和相近月份聚类。它保留来源 ID、时间范围、反例和未解决标记，不把多次事件简单拼成一长句。

默认本地巩固必须确定性可回放。可选模型压缩只改写 `gist / topicKeys / unresolvedSummary`，不能改变来源、参与者、发生月份、结果类别、置信度上限或是否已解决。

遗忘由以下因素共同决定：

- 距发生和上次真实召回的时间；
- 重要度、情绪强度和本人认知 / 记忆特质；
- 是否仍关联 active agreement、project、agenda 或 live conversation；
- 是否反复被新经历重新激活；
- 当前记忆容量压力。

活跃承诺、live conversation coordination 和正在执行的 agenda 来源不能因普通容量淘汰而消失。技术知识不能套用情节遗忘直接删除；语义 lane 先降低检索优先度，可靠度仍由原知识规则改变。

## 6. 可选模型压缩

模型压缩是可选、可失败的主观巩固操作。当前不新增独立请求：只有人物本来就进入月度 decision 时，才允许在同一返回中附带一次 `memoryConsolidation`；没有 decision 请求便完全使用本地巩固，不为压缩暂停月份。

同一个月的 decision 可批量包含多个人物的相互隔离 envelope；每个人物只暴露自己的当次临时 `m*` 句柄：

```json
{
  "personHandle": "p1",
  "memories": [
    { "handle": "m1", "gist": "...", "month": 12, "people": ["..."], "outcome": "blocked" }
  ]
}
```

返回：

```json
{
  "personHandle": "p1",
  "clusters": [
    {
      "sourceHandles": ["m1", "m3"],
      "gist": "...",
      "topicKeys": ["..."],
      "unresolved": true,
      "emotionalValence": -0.4
    }
  ]
}
```

服务端拒绝未知句柄、跨人物引用、空来源簇、互相矛盾的结果改写、凭空出现的人物 / 物品 / 关系 / 承诺 / 知识和权威结论。模型失败时采用本地巩固；因此压缩不会卡住月份。

只有当前召回项确实出现可合并、可概括或应失去逐字细节的来源时才返回压缩；服务端拒绝跨人物与未知句柄。没有可压缩来源就省略字段。容量压力、模糊和遗忘仍由本地确定性维护兜底。

## 7. 情境检索

调用方提交一个统一查询，而不是自行截取数组：

```ts
interface MemoryQuery {
  atMonth: number;
  personIds?: string[];
  topicKeys?: string[];
  actionBasisKey?: string;
  needKinds?: string[];
  projectId?: string;
  agendaItemId?: string;
  unresolved?: boolean;
  laneLimits?: Partial<Record<MemoryLane, number>>;
  tokenBudget: number;
}
```

排序依次考虑硬相关、未解决、参与者匹配、语义 basis、当前 need / project / agenda、显著度、置信度、真实召回强化与时间衰减。必须保留 lane 多样性，避免八条相似闲聊挤掉一个仍在履行的承诺或项目失败。

读取默认纯函数，不因 prompt 构造就更新 `lastRecalledAtMonth`。只有记忆实际改变 DecisionFact、agenda update、对话内容或动作选择时，才以来源绑定的 recall receipt 更新“被真正想起”。

## 8. Memory → Agenda

MemoryStore 可以产生有源 `AgendaSignal`，但不能自动替人物写长期目标：

- 多次同 basis 失败且仍有新来源；
- 一项承诺、问题或对话明确未解决；
- 同一主题跨月反复出现并改变本人行动；
- 新证据反驳了当前 approach；
- 一项显著经历首次出现且没有对应开放 agenda。

signal 只触发已有 decision 请求中的 agenda review，并携带当次临时记忆句柄。模型可以 create / revise / pause / abandon；本地继续重验来源、可供性和 probe。没有边沿 signal 时不增加模型调用。

## 9. ConversationEpisode

正在发生的对话是 MemoryStore 管理的共享协调状态，不是从行动历史临时猜出的候选。

```ts
interface ConversationEpisode {
  id: string;
  initiatorId: string;
  listenerId: string;
  status: 'reserved' | 'awaiting-response' | 'response-reserved' | 'closed' | 'expired' | 'cancelled';
  openingIntentId: string;
  responseIntentId?: string;
  openingActionEventId?: string;
  responseActionEventId?: string;
  lastActionEventId?: string;
  nextSpeakerId?: string;
  turnCount: number;
  openingTurnMemoryIds: string[];
  responseTurnMemoryIds: string[];
  createdAtMonth: number;
  replyByMonth: number;
}
```

- 同一人物同一时刻最多参与一个 live episode；同批 A→B / B→A / C→B 只有一个 reservation 成功；
- 同月批量决策使用月初上下文，但落地前必须用当前 `ConversationEpisode` 状态重编译。已经被较早人物预留、关闭或取消的 opening 不得以同一 episode ID 再生成；本地选择失效时在最新合法候选中只重规划一次，模型选择失效时只做非自愿社交的本地回退并把提交事实标为 `usedModel=false`，不能写一条没有 Intent 的“有效决定”吞掉人物整月行动额度；
- 开场动作 completed 后才提交原话并进入 awaiting-response；失败则 cancelled；
- response 只能由当前 `nextSpeakerId`、在期限内、针对精确上一句执行；模型返回 `continue` 时 `nextSpeakerId` 交给另一方，允许跨月多轮接力，返回 `close / rupture`、明确选择别的事或期限到达才 closed / expired；
- 等待回应不占 active Intent；独立 open / response 作为可恢复的短子中断，说完恢复原生产 Intent；
- 模型拥有说什么、回应 / 回避 / 转题 / 收束，规则只拥有参与者、顺序、期限、来源与合法性；
- 对话内容不自动增加 trust / bond，也不自动生成制度。

## 10. 行动历史

完整行动历史 API 继续来自权威事件与 SpeechLine，只承担调试和玩家审计。人物页默认展示的“记忆”不再把这份流水冒充大脑：

- 默认隐藏无位移移动、重复 continuation、没有新后果的相同步骤；
- 将同一 Intent / Project 的连续原子动作折叠成可展开 episode；
- 沟通有合法真实原话时显示原话，否则只显示间接事实；
- 记忆页只显示人物当前能召回的有损内容；普通低价值行动、弱关系占位、与真实台词重复的“进行开放交谈”摘要不会挤进这份投影。

## 11. 成本与长程

MemoryStore 本地写入、检索和遗忘不能调用模型。模型压缩只 piggyback 到已发生的月度批量 decision，并只发送被召回的 `m*` 来源，不重发完整行动历史。

月度 decision 将本月需要复核的人物合并为一个有界 provider 请求；最终可见台词另按本月已完成沟通批量生成。provider 直接读取世界内真名和结构化 ID，不再经过姓名占位符往返；本地事实边界仍禁止模型把同名原型的历史当作本局经历。月度账本累计 decision 与 speech 的真实 provider 请求和 token；玩家主动对话另在交互 turn 中记录用量。

后台长程本地模拟继续不等待模型，用确定性巩固验证文明因果链。真实模型会话单独验证人物回复、对话连续性、agenda 形成与压缩质量；模型形成的合法 agenda 随后由本地 Intent / Project 在后续月份推进真实世界。

## 12. 验收

最终验收以代表性历史人工判断为主，计数只作护栏：

- 回复确实在回应上一句，不是另一段礼貌开场；
- 人物会沉默、偏题、质疑、承认不知道或结束，而不是统一友善；
- 记忆有选择、有偏差、有模糊和遗忘，但不凭空创造事实；
- 未解决经历能够形成长期关切，方法失败后 aim 仍在、approach 会变化；
- 社交只短暂打断工作，不让项目身份和进度丢失；
- 多种子长程中，真实冶金、传播与制度链仍能达到古代文明；失败与停滞样本全部保留并检查最早断点。
