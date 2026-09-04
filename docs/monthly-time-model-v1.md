# Eland 月度时间模型 v1

状态：当前权威时间设计（schema 19）。月是存档与日历单位，每月包含 15 个可调度的 activity episode；`planningTick` 是事件协议中保留的兼容名称。模型调用遵循[人物 Agent 架构](./rule-first-agent-architecture-v1.md)：后台快速演化不等待模型；实时月份用 Mind → Plan 形成方向与计划，开放行动另经独立 World Semantics Resolver，再由确定性 kernel 提交结果。

范围：three-body 人间世界的时间、规划、长期行动、历史与播放节奏。

关联：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [像素世界（空间·历史·迁移）](./pixel-world-v1.md)

## 1. 核心决定

世界的存档时间步是一个月，人物的执行粒度是一段连贯活动：

```text
1 月 = 15 个 activity episode
健康人物基准 = 120 work effort / 月 = 8 work effort / episode
```

关键分离：

```text
月度世界推进 ≠ 模型调用
人物规划       ≠ 每月只发生一次
活动片段       ≠ 一小时、一天或一步路
活动片段       ≠ 每次都更换长期目标
长期意图       ≠ 一次完成行动
没有模型       ≠ 人物没有决定
```

规则世界、人物规划和动作执行必须在本地完整闭环。实时 Mind 先根据人物记忆与处境形成意图，Plan 再保存不限固定长度的 steps，并选择一个当前入口或提出菜单外 `worldAction`。开放行动的结果由独立 Resolver 翻译，kernel 仍重新验证来源、守恒、身体、空间、时间与同意；任何模型输出都不能直接修改世界。每个有效 MentalAct 返回唯一 `utterance / delivery`，提交 DecisionFact 时立即形成语言广播。社会性 talk 复用同一条波；只有没有模型原话的规则 talk 才在 completed ActionFact 后进入表达增强。

## 2. 权威时钟

```ts
interface WorldClock {
  unit: 'month';
  elapsedMonths: number;
  monthsPerYear: 12;
}

const PLANNING_TICKS_PER_MONTH = 15;
const ACTIVITY_EPISODES_PER_MONTH = 15;
const BASE_PERSON_MONTH_WORK_EFFORT = 120;
```

`elapsedMonths = 0` 是文明初始态。完整执行 15 个 activity episode 和月末结算后，才能提交下一个月并增加 `elapsedMonths`。

一次推进只计算一次 `atMonth = elapsedMonths + 1`。月初世界过程、候选生成、意图重编译、年龄门禁、协议生命周期、15 个 activity episode 与事实 ID 都使用这个固定值，月末再把 `elapsedMonths` 提交为 `atMonth`。普通只读查询仍读取已经提交的 `elapsedMonths`；文明创世在 `elapsedMonths = 0` 建立初始事实，是唯一显式例外。

显示纪年只由月数派生：

```text
completedYears = floor(elapsedMonths / 12)
monthOfYear = elapsedMonths === 0 ? 1 : ((elapsedMonths - 1) % 12) + 1
displayYear = elapsedMonths === 0 ? 1 : floor((elapsedMonths - 1) / 12) + 1
```

年龄、妊娠、疾病、承诺期限、长期目标复核和制度持续时间均保存月数，不另存年度计数。

## 3. 月不是地球季节，activity episode 也不是自然日

月是文明内部等长时间单位，不预设春夏秋冬；当月温度、光照、降水、冻结和火灾风险来自宇宙天象与世界过程。

15 个 episode 是人物行动密度，不等于 15 天，更不等于 15 小时。移动 episode 可按地形和身体能力跨过多格，同时保存完整路径；健康人物在全部片段都用于普通地面旅行时约可移动 60 格。身体储备、冷热、伤病、衰老、妊娠和产后恢复只改变已选行动的 work throughput，不替人物选择目的地。等待仍让时间片段过去，但不伪造体力劳动。环境可以在月初、特定 episode 或月末按明确规则变化，同一规则版本、种子和历史必须得到相同结果。

## 4. 长期意图

人物至多有一个当前执行中的 `Intent`。意图保存目标条件，不保存“本月一次动作”。以下只列执行契约所需的核心字段，完整定义以 `domain/action.ts` 为准：

```ts
interface Intent {
  id: string;
  ownerId: string;
  domain: 'strategic' | 'social';
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  status: 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';
  createdAtMonth: number;
  lastProgressAtMonth: number;
  lifecycle?: {
    version: 'intent-lifecycle-v1';
    completion: 'on-achievement' | 'maintain-state';
    reviewAtMonth: number;
    maintainUntilMonth?: number;
  };
  // 旧存档兼容字段；新意图不再用它推断维护语义。
  stateGoalUntilMonth?: number;
  sourceFactIds?: string[];
  plan?: MentalPlanTranslation;
  outcomeReceipts?: IntentOutcomeReceipt[];
}
```

采集、储藏、放置、种植和知识等目标默认是 `on-achievement`：真实目标一旦达成立即结算，3～12 月只表示未达成时的有界复核期限，不能冒充“保持库存数月”的维护行为。只有选项显式声明 `maintain-state` 时，达成后才持续到 `maintainUntilMonth`；旧存档中没有 `lifecycle`、只有 `stateGoalUntilMonth` 的意图继续按旧维护语义排空，不重写历史。

每个 episode 只推进意图的一项原子动作或一段有 effort 上限的移动。移动、搬运、施工、照护、观察和履约因此能在同月产生多段真实进展，也能跨月延续。完整模型 Plan 随 Intent 保存，但每一项后续步骤仍要在执行时对最新世界重新落地。

每项执行追加一条 `IntentOutcomeReceipt`，把动作是否发生、目标是否推进、证据是否新增 / 确认 / 反驳分开记录。只有目标或证据真实改变才刷新 `lastProgressAtMonth`；一次完成的观察不会因为长期 goal 尚未达成而被机械重复几年。

## 5. 目标组合与当前焦点

人物同时保留四类目标压力：生存、生产、社会和求知，但任一 episode 只执行一个当前焦点。

本地规划器每个 episode 都检查：

- 当前意图是否仍合法且有进展路径；
- 身体或直接危险是否要求反射；
- 是否存在到期承诺、必须回应或依赖照护；
- 空闲人物是否有可执行生产/探索目标；
- 未完成生产目标是否应优先续作；
- 重复社交是否应被冷却；
- 当前目标是否达到复核月或已经客观完成。

稳定意图不生成无意义的“继续生活”决策文本；引擎直接推进并记录动作。每人每月通常只做一次普通广义选择；若这个月创建、复核或跨月带入的根意图真实进入终态、且完整处理中断返回后没有父意图恢复，下一 episode 可再做一次普通选择。这个额外额度即使返回 `idle` 也会在暂存 `MonthExecution` 中立即消费并进入有限化身重放哈希，但不为“什么也没改变”制造持久 `DecisionFact`；回应、履约、记录使用等有真实合法候选的边沿唤醒另行审计，不挤占普通额度。

## 6. 本地活动片段

对 `planningTick = 1..15`（即 15 个 activity episode）：

1. 计算当前人物稳定执行顺序；
2. 为当前人物生成最新局部感知和合法可供性；
3. 执行确定性生存/照护反射；
4. 检查并修复 active intent；
5. 若没有可执行意图、现有意图到达复核条件，或出现带真实合法候选的独立边沿唤醒，则在普通 deliberation 额度与 edge 通道各自边界内由正式 `RulePlanner` 选择目标；
6. 编译下一项原子动作并进行前置条件预演；
7. 执行动作，写入精确路径、work effort、结果、世界差异和来源；
8. 后续人物读取本 episode 已提交的世界状态。

本地规划器始终可用。模型额度、网络状态和外部任务不能让人物失去这个入口。

### 有限化身的暂存月份

普通快速演化与第一人称有限化身共用同一套 `prepare → executePlanningTick × 15 → finish` 月执行生命周期，不维护第二套人物、世界或月末规则。进入化身时，服务端从最近已提交的 `SimulationState` 创建隔离工作副本，固定 `atMonth = elapsedMonths + 1` 并准备月初事实；在第 15 个 episode 和月末结算完成前，权威状态的 `elapsedMonths`、分支头和已提交帧都保持不变。化身视图显示的是这个暂存月份及其 `completedTick`，不能冒充已经提交的新月。

观察与行动分开：转动第一人称镜头、瞄准、查看人物 / 结构提示和展开当前合法选项不消耗 activity episode。玩家只有提交 `wait`，或提交服务端刚投影的稳定 `optionId + choiceKey`，才请求推进一段；服务端会在被控制人物轮到行动时用最新局部 `DecisionContext` 重配并重验选择，领域执行器仍作最终合法性校验。每个成功接受的命令不是只动化身一人，而是按稳定顺序让当月全部存活参与者完整执行同一个 activity episode，所以其他人物、资源与危险会继续演化并可能使先前选项失效。

化身不是高于人物身体的权限。脱水休眠、恢复、生存反射、依赖照护、幼儿限制和必要避护仍在玩家控制入口之前执行；命令因此可能没有接管本人行动，但这个 activity episode 仍然真实发生。玩家走完第 15 个 episode 时直接月末结算并原子提交；提前“交还自主”时，本地规划器跑完剩余 episode，再走同一月末流程一次提交，不产生半个月提交或逐 episode 持久化出的第二权威分支。

## 7. 反射、计划和重新规划

优先级：

```text
直接生存反射
> 到期履约、必须回应和依赖照护
> 修复仍有效的长期意图
> 未完成生产与空闲生产机会
> 探索、求知和非必要社会活动
```

紧急吃喝、脱离火场、避免立即失温和幼儿依赖照护由规则直接执行，不创建模型任务。

生殖合法性与生殖后果必须分开：双方同意且身体适格才可执行生殖原语；一次接受形成最长四个自然月的可撤回尝试窗口，任一参与者都可在后续尝试前通过可追溯沟通撤回。亲缘距离不阻断动作，而是在出生和后续月份形成遗传负荷、属性偏差与疾病风险。人物是否回避近亲取决于本人已经形成或经沟通获得的有来源认识，不读取全局族谱答案；这项认识按知识置信度连续形成软成本，不以单一知识阈值突然切换为禁令，多个合格伴侣则作为独立候选交给同一因子树比较。

每次真实完成的生殖原语都是一次独立、可回放的受孕机会。单次概率仍由女性当时的健康、营养和水分决定；确定性随机键必须包含动作事件 id。同一伴侣对同一自然月最多完成一次尝试；未受孕只把动作事实追加到当前协议，窗口继续有效。受孕、撤回或四个月到期才结清协议；没有受孕的窗口结束后需经过六个月才能再次提议，受孕后则需经过十二个月。人物在提议、接受、每次尝试或撤回时都会重新权衡本人产后恢复、亲生未成年子女的年龄负担，以及同地子女可见的身体危机。

分娩会产生 9–15 个月的 `postpartum-recovery` 状态，期限由分娩时身体储备决定。恢复阶段增加水分与营养消耗、降低行动能力，并阻止下一次妊娠；状态的产生、阶段变化与结束都来自月度身体规则，不由前端或叙事补写。

人口承载是身体与生态后果，不是人物读取的文明指标。当前软承载目标为 50 人：存活人口在 49–50 人时，单次受孕概率逐步降为正常值的 `2/3` 与 `1/3`；超过 50 人时暂不开始新妊娠，但已有妊娠仍可分娩。超过目标的人口还会使每个人的水分与营养月消耗按每超出 1 人增加 8%，最高为正常值的 2.5 倍。人物是否提议、接受、尝试或撤回仍由局部关系、身体和责任事实决定，不能读取全局人口数或文明指数作为目标。

开局先民由一条列明全体参与者的“共同抵达”事实获得 `trust=10 / bond=10` 的双向基本熟悉，但 founding 本身不是正式结伴或生殖提议的充分关系证据。提议可供性不再由 `trust / bond / fear` 数值或共同经历数量解锁；领域层只阻止同一关系 episode 的重复、仍在途的提议和没有新事实的原样重开。人物是否提出、接受、拒绝、继续或撤回，由模型结合本人有来源经历、主观 appraisal、身体、责任和风险判断；有效双方同意仍是实际生殖不可绕过的执行边界。新生儿和区域来客都不会自动继承先民关系。

月末按 15 个 activity episode 统计共同活动：两人必须在同一 episode 都完成或推进非沟通行动，并在行动后真实同地。每个人按自己的有效外向性与宜人性，把每 3、4 或 5 个合格片段换成一份定向 `trust +1 / bond +1`；当月已经形成基础增量时，未满 16 岁再获得 `trust +2`，16–29 岁获得 `trust +1`。这些变化写入 `relationship / shared-action-ticks` 客观事实。单纯同处、空闲、休眠、失败动作或只有一方行动不计；直接伤害、拘束或未授权取物会把涉事双方从当月正向积累中排除。Mind 还可把确实涉及眼前人物的来源记忆解释为 directed `RelationshipEpisode`；感激、吸引、怀疑、嫉妒或恐惧可以并存，但这种 appraisal 不直接改双方关系数值，也不替对方同意。

计划失败时：

1. 同一 episode 尝试重算路径、靠近目标、取前置材料或更换已知方法；
2. 仍不可行则由本地规划器选择同目标的替代子目标；
3. 目标消失、持续失败或长期价值变化时，才改变长期意图。

候选重试另有结构化失败 basis，而不是比较显示摘要或临时 option ID。新状态优先从 terminal Intent 的 `goalOutcome / actionEventIds` 解析当月 overlay 或已提交历史中的真实 blocked / failed `ActionFact`，按实际执行动作建立 basis；项目、记录使用和生活复核为了隔离规划副作用而创建的嵌套 preview state 必须继承外层同一 overlay，使候选展示动作与提交前重编译看到相同的当月事实。容量有限、允许遗忘的自传记忆只保留为旧快照以及没有执行动作的复核 / 编译失败兼容路径，并为这些兼容失败显式保留 0–6 个月。失败当月，已经提交的 ActionFact 是当前物理证据：即使新目标或新项目再次请求，完全相同的实际动作也不会在第二次普通复议中原样执行；动作真实改变仍可尝试。跨月后再按包含动作、目标、数量、人物、项目、记录使用和关系的完整 basis 判断：第 0–6 个月内，相同 basis 且没有新来源的候选处于冷却，第 7 个月恢复；新来源或任一结构字段改变会立即重开。必须回应和履约不受冷却。无法从旧自由文本失败记忆还原 basis 时 fail-open，避免历史文案永久封锁合法候选。候选编译还会复用领域层同一套“随身物质作用于体素”的产物规则：若 `nextAction` 或已经声明的 `completionAction` 会把固体放进当前被任一身体占据的空气体素，整条计划都不构成当下可供性；机械 / 电力安装则从自身冻结 action basis 取得精确安装位，并使用同一身体占位边界。项目每次只暴露一个原子步骤；若移动 / 物流前缀结束后才在 active-intent 重编译中显出上述放置，而目标仍是空气却被身体占据，该意图保持 active 并等待，不提交 blocked ActionFact；身体离开后下一 episode 自然重编译。目标若已不再是空气则仍进入领域失败和项目复核，不被静默等待。实际执行仍再次检查，防止规划后世界变化造成越界。

## 8. 实时模型规划与本地连续执行

实时模型使用滚动 person-month 上下文与 token 容量；它只限制哪些认知时刻得到模型增强，从不决定人物能否行动。每人每月最多形成两次模型 MentalAct，月内只由真实沟通、观察、试验、失败或见证等新事实触发，不按钟表反复复核同一旧关切。

实时会话在进入 15 个 episode 前冻结必要的本地回退，然后对筛中的认知上下文运行 Mind → Plan。Plan 可以选择 `availableSteps`、continuation / experiment，也可以提出固定菜单之外的具体 `worldAction`；完整 steps 保存在 MentalAct 与 Intent。只有开放行动再调用独立 World Semantics Resolver，Resolver 不得改写人物意图，也不能替另一人物回答或同意。随后领域层重新验证强制回应、引用、物质来源、数量守恒、身体、空间与权限。超时、缺少端点、额度不足或任一阶段输出无效时，已有 Intent 继续执行；无 Intent 者使用 RulePlanner 的保守方向，不把模型故障写成角色决定发呆。

每次模型选择都会同步发出唯一 `utterance`，不存在另一个“心念”通道。若所选步骤本身是社会性 talk，ActionFact 复用这条 DecisionFact 语言波，不再次广播；没有决策空间的必须回应，以及第 2..15 个 episode 才由规则产生的 talk，依然由规则正常提交，并在缺少模型原话时按需进入 speech-only 批次。

决策模型的 `utterance` 就是已经发射的语言波，直接绑定 DecisionFact；表达层不得在事实发生后改写它。若社会性 talk 复用该波，SpeechLine 改为绑定 ActionFact，但仍保留同一原文。speech-only 只处理没有决策模型原话的规则 talk：它读取说话者的有效人格、本月提交后的当前身体和状态、当前关系、当前处境与有源近期经历，并从 ActionFact 的结构化 `speech-act-v1` 草稿生成显示文本。speech-only 失败时保留沟通事实但不显示文字气泡。

玩家主动对话使用 `interaction` 路由。服务端先保守判定 `actionChoiceRequested`；第一阶段只生成角色回复和来源审计，纯问答不暴露其他人物待回应的 required option，也不触发意图调用；明确行动请求才追加隐藏 prompt，从实际回复中提取接受、考虑或拒绝。回复失败时不做本地补答，隐藏意图失败时保留回复且不形成行动。只有角色回复已经明确接受请求、隐藏意图阶段唯一匹配 `accept + choice` 且本地校验通过，才在当前分支保存排除临时月份和表达 ID 的稳定 choice key。下一次可行动月份只用最新局部状态和合法候选做本地唯一重配，不再让模型重新决定，也不能绕过强制回应、履约、物理或意图校验。

规则事实提交后可以调用 `narrative` 路由：实时帧只压缩已经筛出的重大纪事实；长程运行的 `dialogue / memory / history` 增强作为独立 artifact 队列异步处理。两者都只能写非权威投影，不能产生行动、意图或策略建议。`strategy` 当前只是端点配置扩展位，没有可执行任务队列。

月度帧提交后，实时会话再把当月规则候选增量推入分支局部纪事投影。这一层可以把六个月间隔内的天气转折连成一段过程，并在项目完成时用完整项目来源链覆盖早期原子动作。这只是事后可重建的表达缓存，不改变月度执行顺序，也不向下一月人物规划暴露归并结果。

必须回应等 edge context 可免计普通额度，但仍必须有本地强制回应回退。玩家主动对话有独立用量记录；已接受 choice 的跨月落实只有本地重配，没有第二次模型调用或额度。额度只限制模型增强，不限制规则行动、承诺履行或沟通事实；Mind、Plan、Resolver、台词和记忆压缩的真实请求与 token 都进入同一月度审计。

## 9. 月度执行顺序

```text
1. 固定 atMonth = elapsedMonths + 1，取得该月天象并推进月初环境过程
2. 更新协议、权限、记忆期限和月初感知基础
3. 冻结可靠本地回退；筛中的认知上下文执行 Mind → Plan，开放 worldAction 再经独立 Resolver
4. 顺序执行 15 个 activity episode；普通推进连续跑完，有限化身由每个玩家命令推进一个完整世界片段
5. 每个 episode 内完成本地规划、预演、修复、effort 结算和原子动作
6. 月末结算身体、状态、疾病、妊娠、产后恢复、死亡和环境后果
7. 更新人格证据、客观关系事实、知识、共同体、作品使用回执与观察器
8. 原子提交更新后的 `SimulationState` 与本月普通 `WorldEvent` 历史并判定终局
9. 若文明仍在运行，提交到期的区域边界旅程、来客与首次相遇 `PopulationFact`；来客从下一月开始行动
10. 实时会话保存 checkpoint / delta，并收集 DecisionFact 的唯一 utterance 与 completed talk ActionFact 形成 `speechLines`
11. 每 12 月生成确定性年度聚合
12. 如有重要事件，可在事实提交后生成即时叙事投影或异步排队增强任务
```

实时天象若显式提交 `triple-sun-vaporization`，第 1 步会在 `planningTick = 1`、任何人物 DecisionFact / ActionFact 之前结算全部汽化，并返回空的可行动人物集合。该月仍遵守 15 个 episode 的时间契约，但没有人物动作；随后直接以零生还者提交毁灭结局。普通 `fire` 不走这条终局分支。

月提交是原子的：普通推进与有限化身都只在 15 个 episode 和月末流程完成后提交一次；化身暂存期间进程中断时仍以最后已提交月为权威，并可从暂存快照确定性重放。已接受的实时模型选择作为 DecisionFact 输入进入本月历史；台词、异步模型任务与即时叙事投影都在事实提交后生成，不参与世界事务。

## 10. 同 activity episode 冲突

人物按 `seed + branchId + month + planningTick + personId` 产生稳定顺序。

- 两人争取同一耗尽资源：先执行者取得，后执行者当 episode 本地修复；
- 两人放置互斥构件：第二项被拒绝并立即重新规划；
- 双人交换和对话仍要求双方当时可达；
- 一个动作造成的死亡、阻塞或物质变化立即影响后续人物；
- 不允许模型通过提前看到 episode 末状态获得全局优势。

## 11. 历史事实

```ts
// 与运行时 BaseEvent 一致；planningTick/orderInTick 对新事件应明确记录
interface EventTime {
  atMonth: number;
  orderInMonth: number;   // 兼容字段，旧事件沿用
  planningTick?: number;  // 0 表示月初/月末系统过程，人物动作使用 1..15
  orderInTick?: number;
}
```

旧事件可在迁移读取时把 `orderInMonth` 映射为兼容顺序，但新事件应明确记录 `planningTick`。每项动作仍保存人物、意图、路径、状态差异和来源。

同一次推进内，月初系统事实、协议事实、DecisionFact、ActionFact 和月末事实的 `atMonth` 必须一致；它们只通过 `planningTick / orderInTick / orderInMonth` 表达月内顺序。

## 12. 快速演化与播放

后端快速演化可以在一次进程中连续执行任意月数，每月仍完整运行 15 个 activity episode，不跳过中间规则状态。

前端实时 `GameFrame` 的 society / history 投影至少表达：

- 人物本月 15 个 activity episode 的压缩路径或关键位置；
- 本月新建、改变或损坏的物质和结构；
- 意图开始、改变、完成和阻塞；
- 重大身体、关系、协议和环境事实。

实时 GameFrame 另可包含 `speechLines`：每条指向一个模型 DecisionFact，或一个已完成的 talk ActionFact，标记说话者、实际感知者、`planningTick`（活动片段序号）、来源事实和台词来源。模型决策原话对应权威 LanguageBroadcast；SpeechLine 只是显示投影。规则 talk 的可见措辞可由 speech-only 模型补充，但不能改变结构化话语行为。

客户端可以压缩展示，但不能伪造路径或提前显示月末结果。观察页只通过有过期时间的在线租约声明当前有人观看，并轮询最新已提交 `GameFrame`；它不发送逐月推进命令。服务端从已提交宇宙快照形成下一月天象，完整执行 15 个 activity episode、Mind / Plan / 按需 Resolver 与台词组装后再原子提交；最后一个观察租约失效后不再开始新月份，进行中的月份最多完成一次。已保存帧的回放不重新调用模型；后台 `/evolve` 与实验矩阵仍完全不等待模型。

## 13. 时间尺度换算

| 概念 | 当前规则 |
|---|---|
| 年龄 +1 | 完成 12 月 |
| 一月活动 | 15 个连贯 activity episode；健康基准 120 work effort，受身体、地形和反射限制 |
| 一次观察 | 通常一个 episode 即产生 receipt；只有新证据支持时才继续复查 |
| Intent 复核 | 通常 3～12 月内按真实结果复核；Concern / Project 可自然跨年 |
| 妊娠/疾病/承诺 | 保存 `dueAtMonth` / `durationMonths` |
| 道路和制度 | 跨多个 episode、月份和人物的事实组合 |
| 区域来客 | 创世固定来源、旅程和边界入口；月末抵达，次月成为普通 agent |
| 叙事增强旁车 | 事实提交后的独立任务，不属于世界时间换算 |

月度概率不能直接把旧年度概率除以 12。若过程确实满足独立月采样，才使用：

```text
p_month = 1 - (1 - P_year)^(1/12)
```

## 14. 验收不变量

- 完成 12 月才使年龄增加一岁；
- 每个已提交月完整执行 15 个 activity episode；`planningTick` 只保留为事件顺序字段；
- 一次推进的候选、重编译、年龄、协议和事件全部使用同一个 `elapsedMonths + 1`；只读查询仍停留在已提交月；
- 有限化身的自由观察不消耗 episode；每个已接受命令让全部人物执行一个完整 episode，暂存期间已提交 `elapsedMonths` 不变；
- 化身命令只能引用当前投影的稳定 `optionId + choiceKey`，不能绕过生存 / 照护优先级或领域动作校验；提前交还时本地跑完剩余 episode 并只提交一次；
- 没有模型时空闲人物仍会获得本地意图；
- active intent 在同月可推进多项原子动作，并可跨月延续；
- 移动按 person-month effort 与身体吞吐量执行并保存精确路径，不把相邻一步伪装成一个月；
- 紧急、履约和必须回应由规则处理；
- 纯玩家问答不能继承其他人物的 required response，也不能经模型解析形成行动；只有 `accept + choice` 可等待下一月本地重配；
- 模型超时不会让月帧停在上一月；
- Mind / Plan / World Resolver 都不能直接修改格子、身体、物质、知识、关系、协议或计划进度；开放结果仍由 kernel 校验后提交；
- 每个执行步骤分别记录 execution、goalProgress 和 evidence；无关观察不能刷新长期目标进展；
- Work 的名字和建造事件不算文明采用，只有可回放使用 / 示范回执进入文明观察；
- 区域旅程不读取本地性别、妊娠、人口缺口或文明阶段；抵达与首次相遇不自动产生关系、成员身份或生殖；
- 模型决策原话进入 DecisionFact 的 LanguageBroadcast，并投影到 `GameFrame.speechLines`；它不能直接改写物理结果、关系、知识或文明纪事；
- speech-only 说话失败时，每个已完成且具有可解析真实听者的规则 talk ActionFact 仍然成立，但不生成文字气泡；
- 相同种子和已接受输入得到相同规则历史；
- 回放不重新运行规划器或模型；
