# ELAND 最小物质—人物—动作模型

状态：设计草案，不直接改变当前 schema。

千项能力地图要求的主动观察、记录、非人生命、规范内核、共同体、能量/信号和多区域扩展，统一见 [《千项能力的最小涌现底座 v1》](../../docs/emergent-capability-substrate-v1.md)。本文保留人物—物质—动作的核心模型。

目标不是复刻 Minecraft，而是吸收它最关键的结构：世界由少量可组合的物质单元组成，人物只能移动物质、改变物质、使用物质；建筑、道路、农田和聚落都是这些动作在空间与时间中积累的结果。

## 一、三个决定

### 1. 格子改为物质，不再是属性包

当前格子同时保存地形、高度、肥力、水深、覆盖、湿度、温度、植被、火、冰和多种活动计数。它描述的是“设计者已经理解过的地理单元”，不是可被人物重组的世界。

新模型中，一个体素只回答一件事：**这里是什么物质**。

```ts
type MaterialId = number;

interface VoxelWorld {
  width: 84;
  depth: 52;
  levels: 12;
  palette: MaterialDefinition[];
  voxels: Uint16Array; // (x, y, z) -> MaterialId
}
```

为了保留当前俯视界面，第一阶段采用 2.5D：世界内部是 12 层物质柱，人物只在每列最高可通行表面移动；UI 仍显示俯视像素，缩放后可以查看该列的纵向物质组成。这样无需一开始实现完整 3D 寻路，却已经能够表达地势、河床、树、墙和屋顶。

示例物质：

```text
air
water / ice
stone / sand
soil / wet_soil / rich_soil / exhausted_soil
grass / shrub / berry_bush / crop_sprout / crop_mature
wood / plank / fiber
fire / ash
```

高度由一列非空气物质的最高位置派生；水深由连续水体素数量派生；肥力由土壤物质类型表达；植被、火和冰本身就是物质；不再为单格保存对应数值。

#### 物质定义，而不是格子属性

```ts
interface MaterialDefinition {
  id: MaterialId;
  key: string;
  phase: 'solid' | 'liquid' | 'gas';
  tags: MaterialTag[];
  hardness: number;
  mass: number;
  consume?: { nutrition?: number; hydration?: number; health?: number };
  drops?: Array<{ material: MaterialId; quantity: number }>;
}
```

这些是同类物质共享的规则，不是每个格子的属性。过程规则负责物质变化，例如：

```text
grass --反复踩踏--> soil --继续踩踏--> packed_soil
water --严寒--> ice
crop_sprout --适宜月份概率演进--> crop_mature
crop_mature --收获--> food + seed + exhausted_soil
wood --切削--> plank
plank --放置/连接--> 墙、地板或屋顶的空间结构
```

作物阶段也使用不同物质，不给格子增加 `growth: 73`。成长等待由月份和确定性概率完成。

#### 物块、掉落物与结构

- **物块**：占据体素的物质。
- **掉落物**：位于某格、尚未被持有的物品堆，类似 Minecraft 的掉落物实体。
- **结构**：相邻物块的拓扑观察结果，不保存一份重复的权威建筑模型。
- **容器**：极少数有附加状态的物块；其背包以 `container voxel id` 为所有者。

道路不再是 `traffic[cell]` 数值达到阈值后画出来，而是反复通行事件使地表物质逐步变成 `soil / packed_soil`。休息次数等统计只从事件流派生，放在“活动”观察页，不再冒充格子属性。

因此截图里的格子检查器应从：

```text
高度 -4    肥力 19
水深 0     植被 28
通行 3     休息 71
```

改为：

```text
格 7, 26
表面  草
下层  湿土 × 2
基底  石 × 4

地面物品  木材 × 2
附近人物  ……
```

“过去 12 月通过 3 次、休息 71 次”可以在独立的活动 Tab 展示，但不是该格的权威物质状态。

### 2. 人物只保留三个生存属性，并拥有私有背包

人物的数值属性收敛为：

```ts
interface PersonState {
  id: PersonId;
  profileId: string;
  bornAtMonth: number;
  diedAtMonth?: number;
  sex: 'female' | 'male';
  parents?: [PersonId, PersonId];
  longevityBaselineMonths: number;

  position: VoxelPosition;
  health: number;
  hydration: number;
  nutrition: number;

  inventory: ItemStack[];
  conditions: PersistentCondition[];
  knowledge: KnownFact[];
  activeIntent?: Intent;
}
```

- `health`：生命；归零后死亡。
- `hydration`：水分储备；不足会持续伤害健康。
- `nutrition`：营养储备；不足会持续伤害健康。
- 年龄由当前月份与出生月份派生。
- `longevityBaselineMonths` 只影响衰老进程的概率曲线，不再代表一个预先排定、到月即死的日期。
- 存活、脱水、饥饿等即时状态由三个数值派生，不重复保存枚举。
- 疲劳不再作为第四条永久属性；长时间活动的成本直接扣除营养和水分，休息降低下一阶段消耗并允许健康恢复。
- 只有无法从当前事实重算、必须跨月保留进程的状态进入 `conditions`，例如伤口、疾病、妊娠和拘束。

历史人物差异不再预生成一组能力数值。`profileId` 指向不可变人物原型，其自然语言特质用于本地选择偏置和 LLM 上下文；真正的差异逐渐来自经历、知识、所处环境和持有物。

#### 私有背包

```ts
interface ItemStack {
  id: ItemStackId;
  materialId: MaterialId;
  quantity: number;
  sourceEventIds: EventId[];
}
```

背包是人物聚合的一部分：

- 本人拥有背包物品的默认授权；其他人只有在获得授权时才能合法取用；
- “私有”不是魔法锁定：近身、目标失去行动能力或背包无人看守时，其他人仍可尝试未经授权的转移，从而允许偷窃与抢夺出现；
- 给他人必须产生一次明确转移动作；
- 交易是两次带条件的转移；
- 死亡时背包变成死亡格的掉落物；
- 公共资源必须被放进一个真实容器，不能存在抽象的“文明库存”；
- 背包有质量或格数上限，迫使储藏、运输、共享和分工出现。

人物卡后续增加“背包”Tab，直接展示私有物品及来源。

### 3. 状态效果：少量条件改变同一套身体结算

状态不是新的永久属性条。系统将状态分成两类：

1. **即时状态**：只由当前数值和环境派生，不保存；
2. **过程状态**：需要记住开始时间、强度和来源，保存在 `conditions`。

```ts
type PersistentCondition =
  | { kind: 'cold'; stage: 1 | 2 | 3; sinceMonth: number; sourceEventIds: EventId[] }
  | { kind: 'heat'; stage: 1 | 2 | 3; sinceMonth: number; sourceEventIds: EventId[] }
  | { kind: 'wound'; severity: number; sinceMonth: number; sourceEventIds: EventId[] }
  | { kind: 'illness'; severity: number; sinceMonth: number; sourceEventIds: EventId[] }
  | { kind: 'aging'; stage: 1 | 2 | 3; sinceMonth: number; sourceEventIds: EventId[] }
  | { kind: 'pregnancy'; otherParentId: PersonId; conceivedAtMonth: number; dueAtMonth: number; sourceEventIds: EventId[] }
  | { kind: 'restrained'; restraintStackId: ItemStackId; sinceMonth: number; sourceEventIds: EventId[] };
```

人物卡可以显示以下状态：

| 状态 | 出现条件 | 退出条件 | 对月度结算的影响 |
|---|---|---|---|
| 温暖 | 当前体感处于舒适区；通常来自遮蔽、火源、干燥覆盖物 | 离开热源/遮蔽或环境转冷/转热时立即重算 | 营养消耗 ×0.85；健康、水分、营养均充足时健康 +2；工作量 ×1.10 |
| 寒冷 1–3 | 寒冷纪元、潮湿、暴露带来的冷负荷超过衣物/火源/遮蔽；按超出程度产生月概率 | 连续处于温暖环境；每月按干燥、食物与遮蔽计算恢复概率 | 营养消耗 ×1.25/1.5/1.8；工作量 ×0.85/0.65/0.4；3 级每月损失健康 |
| 炎热 1–3 | 酷暑/火源热负荷超过遮阴、饮水与覆盖物；按超出程度产生月概率 | 离开热源并能饮水/遮阴；按条件计算恢复概率 | 水分消耗 ×1.3/1.7/2.2；工作量 ×0.9/0.7/0.45；3 级每月损失健康 |
| 饱足 | `nutrition ≥ 70 && hydration ≥ 60`，即时派生 | 任一数值低于阈值 | 工作量 ×1.10；满足温暖条件时允许健康恢复 |
| 饥饿/濒饿 | `nutrition < 35 / < 10`，即时派生 | 进食超过带滞回的 45 阈值 | 工作量 ×0.8/0.45；濒饿每月损失健康 |
| 干渴/脱水 | `hydration < 35 / < 10`，即时派生 | 饮水超过带滞回的 45 阈值 | 工作量 ×0.75/0.35；脱水每月损失健康 |
| 受伤 | 跌落、打击、火或事故造成一次显著伤害时确定进入，强度取决于伤害 | 每月恢复概率由饱足、温暖、包扎和照护共同决定；再受伤会叠加强度 | 工作量随严重度降低；严重伤口持续损失健康并提高患病概率 |
| 患病 | 污染饮食、感染伤口、长期暴露等风险事件；用确定性月采样决定是否进入 | 每月恢复概率由健康、饮食、温暖、休息和照护决定 | 额外消耗水分与营养；降低工作量；严重时损失健康 |
| 衰老 1–3 | 年龄越过个体寿命基线的阶段阈值后，每月按年龄、既往伤病、长期匮乏和个体基线确定性采样；只会进入或升级 | 不退出、不降级；良好饮食、温暖、休息和照护只能延缓升级并改善当月结果 | 1 级恢复效率 ×0.9、工作量 ×0.95；2 级恢复 ×0.65、工作量 ×0.8、患病概率上升；3 级恢复 ×0.3、工作量 ×0.55，中度饥渴或伤病也会损失健康，并进入自然死亡风险结算 |
| 妊娠 | 生殖过程成功后按生理条件产生确定性概率 | 到期分娩；健康或营养过低时存在流产概率 | 增加营养和水分消耗；后期降低工作量；到期尝试创建新人物 |
| 拘束 | 他人使用可约束物质成功作用于身体 | 被释放、约束物被破坏，或按身体/看守情况逃脱 | 禁止远距离移动；工作产出可被控制者取得；提高反抗选择权重 |

所谓“概率”仍必须可重放：

```text
sample = hash(worldSeed, month, personId, conditionKind, phase)
enter / exit = sample < probability(current facts)
```

同一种子和同一历史永远得到相同结果。阈值使用滞回，例如低于 35 进入饥饿、高于 45 才退出，避免人物卡每月闪烁。

#### 衰老不是固定日期死亡

衰老采用一个不可逆、但进度具有个体差异的过程状态。年龄是客观输入，不直接成为死亡命令：

```text
ageMonths = currentMonth - bornAtMonth
agingPressure = f(ageMonths / longevityBaselineMonths,
                  accumulatedWounds,
                  illnessHistory,
                  longTermDeprivation,
                  currentCareAndShelter)
stageUp = deterministicSample < agingPressure
```

- `longevityBaselineMonths` 在创生或出生时确定，只调节衰老压力，不向人物或模型暴露“准确死亡月份”；
- 进入 1 级后只能保持或逐级加深，不能因一次进食恢复年轻；照护改变的是恢复、病痛和升级概率；
- 自然死亡必须有可审计的身体路径：3 级衰老叠加健康衰退、严重疾病或确定性终末风险，而不是抵达某个月后健康值仍很高却突然死亡；
- 15 个规则行动刻度保持不变。衰老只改变每个刻度的动作成本、成功率、恢复需求和可达范围；移动依然每刻度最多跨一个相邻格；
- 模型只能看到衰老状态及其真实后果，并据此形成休息、求助、传授、照护或交接意图；模型不能决定自己是否衰老，也不能直接宣布死亡。

人物卡显示“衰老 1/2/3”和开始月份，不显示精确剩余寿命。历史事件记录每次进入、升级、照护和终末结算的来源证据。

所有状态只汇总到四个结算结果：

```text
nutritionCost
hydrationCost
healthDelta
workMultiplier / actionRestrictions
```

多个状态的乘数相乘后必须限幅，例如 `workMultiplier ∈ [0.2, 1.5]`，防止状态叠加导致无限行动或彻底锁死。

状态本身不选择动作，只改变成本、成功率和可执行范围。复杂行为由人物在新约束下选择原子动作而出现：

| 状态压力 | 可能逐渐出现的行为模式 |
|---|---|
| 寒冷/炎热 | 寻找遮蔽、收集燃料、制作覆盖物、季节迁徙、围绕火源或水源合作与冲突 |
| 饥饿/干渴 | 储粮、灌溉、交换、迁徙，也可能发生偷窃、抢夺和暴力 |
| 受伤/患病 | 自我休息、照护、药物试验、对照护者产生信任、形成依赖与分工 |
| 衰老 | 减少高成本劳动、求助与陪伴、技能传授、财物交接、代际分工、长者影响与临终照护 |
| 妊娠与新生儿 | 食物缓冲、照护分工、亲属关系、家庭聚居和代际知识传递 |
| 拘束 | 服从、逃跑、营救、控制劳动、反抗与群体制裁 |

这也是判断状态是否值得加入的标准：它至少要改变一类真实选择；只改变人物卡文案、不改变身体结算或动作可达性的状态不进入领域模型。

### 4. 删除 `PlanMode`，只保留五种原子动作

不再增加 `explore / travel / gather / carry / build / recover / farm / trade / care ...`。这些是人类对动作序列的命名，不是引擎原语。

`break / take / put / apply` 仍可继续合并。为覆盖千项能力地图中的观察、科学、记录、艺术与远程信息，领域层最终只接受五种原子动作：

```ts
type PrimitiveAction =
  | { kind: 'move'; to: VoxelPosition }
  | { kind: 'transfer'; stackId: ItemStackId; quantity: number; from: HolderRef; to: HolderRef }
  | { kind: 'act'; operation: SourceOperation; targets: WorldRef[]; toolStackId?: ItemStackId }
  | { kind: 'attend'; target: WorldRef | RecordRef | ClaimRef; instrumentStackId?: ItemStackId }
  | { kind: 'communicate'; content: RepresentationInput | RepresentationRef; channel: ChannelRef; audience: AudienceRef };

type SourceOperation =
  | 'exert'      // 对目标施力：打击、推动、拉扯
  | 'separate'   // 分离物质或连接：折断、切削、采收
  | 'combine'    // 让物质接触或连接：混合、包扎、捆绑
  | 'expose'     // 暴露于另一物质/能量：加热、浸水、烟熏
  | 'ingest'     // 摄入身体：吃、喝、服药
  | 'reproduce'; // 唯一不可再约简的生殖过程
```

含义：

- `move`：移动到相邻可达位置；
- `transfer`：在体素、掉落物、容器、背包和人物之间移动物质；授权是引擎根据所有权与承诺判断的事实，不是另一种动作；
- `act`：人物用六种固定局部原语之一作用于物质、空间或身体；具体效果由目标物质、工具、身体和环境共同决定；
- `attend`：投入时间观察、测量、阅读、比较或核验，生成有来源且可能有误差的知识；
- `communicate`：通过嗓音、手势、触摸、实体记录、信使或设备表达结构化内容；陈述、提议、接受、承诺、主张、支持、命令、威胁、叙事和表演都是内容，不是动作模式。

`SourceOperation` 是封闭集合。引擎可以增加“哪些物质在何种条件下产生什么变化”的数据规则，却不再增加动作种类，更不增加“耕种、包扎、交易、选举、奴役”这类目的型动作。

自动看见附近事物不是动作，每月根据视野生成个人可见事实；但持续观察、诊断、测量和核验需要 `attend`。合作也不是专用动作：多人对同一目标执行动作，自然形成共同结果。

复杂行为只是可读投影：

| UI 名称 | 实际原子动作链 |
|---|---|
| 采集 | `move → act(separate, target) → transfer(drop, inventory)` |
| 饮水 | `move → act(ingest, water)` |
| 建屋 | `act(separate, wood) → transfer → act(combine, parts) → transfer(to voxel)` |
| 耕种 | `transfer(seed, soil) → act(expose, water) → 等待物质变化 → act(separate, crop) → transfer` |
| 储藏 | `transfer(item, container)` |
| 分享 | `transfer(item, person)` |
| 交易 | `communicate(offer/accept) → 双方条件式 transfer` |
| 照护 | `transfer(material, person) → act(combine/ingest, person)` |
| 教学 | `communicate(assert, technique facts) → 学习者 attend/模仿` |

`Intent` 只保存目标条件和下一原子动作，不保存模式：

```ts
interface Intent {
  id: IntentId;
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  startedAtMonth: number;
  lastProgressAtMonth: number;
  evidenceEventIds: EventId[];
}
```

目标可以持续很多个月；每月继续执行或推进当前原子动作。只有目标完成、动作受阻、生存属性进入危险区或出现重要新事实时，人物才显著提高重新决策概率。历史意图不永久堆在活动状态中，完成后只留事件。

## 二、涌现仍需要不可约简的底层事实

“没有目的型动作”不等于“什么都不定义”。如果引擎不保存承诺，就无法区分背叛和普通改变主意；如果没有授权，就无法区分偷窃和捡起；如果没有身体生殖过程，就不会仅靠移动和搬运凭空产生孩子。

最小底层事实分成四类，它们都不是人物可直接选择的动作：

1. **身体与因果**：谁作用了谁、造成多少伤害、谁导致死亡、亲子与妊娠过程；
2. **持有与授权**：物品当前在哪里、谁默认有权转移、谁给过谁何种许可；
3. **话语与承诺**：谁向谁陈述、提议、接受、承诺、主张、支持或命令了什么；
4. **见闻与知识**：谁亲眼看到或后来获知了哪些事件，防止人物拥有全局读心术。

最小命题不写成自然语言字符串，而是结构化事实：

```ts
type Proposition =
  | { kind: 'assert-fact'; fact: FactRef }
  | { kind: 'permission'; grantee: PersonId; object: WorldRef; operation: string; untilMonth?: number }
  | { kind: 'commitment'; debtor: PersonId; creditor: PersonId; condition?: FactPredicate; promised: PrimitiveAction; dueMonth?: number }
  | { kind: 'exchange'; partyA: TransferTerm[]; partyB: TransferTerm[]; expiresAtMonth: number }
  | { kind: 'claim'; claimant: PersonId; object: WorldRef }
  | { kind: 'selection'; group: PersonId[]; roleKey: string; candidateId: PersonId; termEndsAtMonth: number };
```

`assert-fact` 可以是真话也可以是假话；话语事件只证明“此人说过”，不证明命题为真。承诺、授权和交换提议必须经 `accept` 才成为双方知晓的约束事实。人物对事件的评价只能使用自己的见闻。

### 私有背包不是无敌背包

`transfer` 总可以被尝试，但领域层会把结果记录为：

```ts
interface TransferOutcome {
  moved: boolean;
  authorized: boolean;
  resistedBy?: PersonId;
  witnessedBy: PersonId[];
  sourceEventIds: EventId[];
}
```

物品正在他人随身背包中时，未授权转移通常会被阻止；当持有人休息、失去行动能力、被拘束，或物品位于无人看守的容器时，才可能成功。这样既保留“物品私有”，也不会把偷窃和抢夺从世界中硬编码删除。

## 三、九类复杂现象怎样出现

这些现象都不应成为 `PrimitiveAction.kind`。底层只执行动作并记事实，由观察器给动作序列命名；一旦某个结果会影响人物后续选择，就把相关事实反馈给人物，而不是把观察器标签当成魔法规则。

| 现象 | 最小动作链 | 必需但不可省略的事实 | 能否涌现 |
|---|---|---|---|
| 生育 | 双方形成接受事实 → 邻近执行 `act(reproduce)` → 妊娠跨月结算 → 分娩 | 生理适格、亲子、妊娠、到期、母体生存状态 | **可以**；不能只靠通用搬运动作，需要一个局部生殖原语和妊娠状态 |
| 杀戮 | `move` 接近 → 一次或多次 `act(exert/separate, person)` → 伤口/健康归零 | 伤害来源与死亡因果、见证者；“谋杀/正当防卫/事故”还依赖承诺与群体规范 | **可以**；没有 `kill` 动作，死亡只是身体结算结果 |
| 信任 | 承诺被履行、陈述被证实、互惠转移、照护累积；伤害、谎言和违约反向累积 | `A → B` 的定向见闻、承诺及其结果 | **可以**；信任是带证据的关系摘要，不是人物固定属性 |
| 选举 | `communicate(selection proposal)` → 多人公开 `support` → 截止时汇总 → 群体持续接受当选者命令 | 群体边界、候选角色、任期、谁支持谁、共同知晓的计数惯例 | **可以形成原始选举**；具有约束力的选举还需群体反复接受同一选择惯例 |
| 背叛 | 先形成承诺、联盟或授权 → 后来执行与其冲突且使对方受损的动作 → 被当事人获知 | 原承诺、冲突行为、受益者、知情范围 | **可以**；没有先前义务就只能叫冲突，不能叫背叛 |
| 占有 | 携带/储藏 → `communicate(claim)` → 排除他人 → 他人反复尊重或挑战 | 实际控制、主张、授权、群体承认 | **可以**；随身背包先天有个人占有，土地/容器所有权则需社会承认 |
| 奴役 | 拘束或持续威胁 → 命令劳动 → 未授权取得产出 → 阻止离开，并持续多月 | 定向控制、强制证据、产出流向、逃离受阻、群体是否容忍 | **可以被观察为强制控制制度**；不能因一次命令或合作劳动就误判为奴役 |
| 交易与金钱 | `offer → accept → 条件式 transfer`；某种物质被不同人反复收取并再次支付 | 报价、接受、实际交割、交易对手、物质是否被消费或再次流通 | **交易可以直接出现**；金钱是多方持续把某物质当交换媒介后的二阶涌现 |
| 偷窃 | 在低可见条件下，对他人物品执行未授权 `transfer` | 当前持有者/所有者、许可、成功与否、见证和后来发现 | **可以**；若没有授权事实，只能观察到“物品移动”，不能称为偷窃 |
| 制作、科技与发展 | 用固定原语对材料反复 `act`，用 `attend` 比较结果 → 记住步骤 → `communicate` 传授 → 工具改善后继续试验 | 输入、工具、环境、步骤、输出、成功记录、知识持有人 | **可以**；制作是单次转换，技术是可复制知识，发展是知识扩散、剩余和分工的长期结果 |

### 信任只做定向关系余额

第一版不需要复杂人格心理学，只维护由事件更新的稀疏关系账本：

```text
履行已接受承诺       trust(A→B) +
互惠、救助、如实告知  trust(A→B) +
违约、已证伪陈述      trust(A→B) -
未授权取物、伤害、威胁 trust(A→B) -
```

未被 A 看见、也没人告诉 A 的事件，不能立即改变 `trust(A→B)`。账本可以缓存分数以便决策，但必须保留导致变化的事件引用，人物卡才能解释“为什么信任/不信任”。

### 选举不是 `vote` 动作

`support` 是对一个结构化 `selection` 命题的言语行为。多个支持事件可以被计数，但“得票最多的人自动拥有控制权”不应是宇宙定律。当群体成员反复遵守某种截止、计数和任期规则，并开始接受被选者的协调命令时，观察器才识别出选举制度。第一次可能只是一次公开推举，重复成功后才成为惯例。

### 金钱不是预设物品类型

任何可携带物质都可能成为交换媒介。观察器在满足以下模式时才称它为货币：

```text
至少三个独立人物参与
同一物质跨多次交换再次流通
接收者并非主要为了直接食用或加工
多个商品开始用该物质表达相对交换量
```

金钱因此不是 `coin` 标签，也不是抽象余额；它仍是某个人背包或某个容器里的真实物质。

### 科技来自试验，不来自解锁树

六个 `SourceOperation` 对所有人物相同；技术不是新动作，而是人物发现的一段可重复操作序列。一次成功只产生事件；当人物记住“输入物质 + 工具 + 环境 + 原语序列 → 输出”的规律后，才形成 `KnownTechnique`。其他人必须观察或被告知，不能因一个人发现而全世界自动解锁。

```ts
interface KnownTechnique {
  pattern: PrimitiveAction[];
  requiredFacts: WorldPredicate[];
  expectedEffects: EffectPredicate[];
  confidence: number;
  evidenceEventIds: EventId[];
}
```

工具只是特定物质结构，它改变局部动作的可达目标、耗时、成功率或产物。斧、农田、工坊、职业、技术时代都应是这些规则叠加后的观察结果。

## 四、最小过程系统

Minecraft 的合成依赖物品和配方；ELAND 需要同样简洁的过程表：

```ts
interface InteractionRule {
  id: InteractionRuleId;
  operation: SourceOperation;
  targets: TargetPredicate[];
  inputs?: MaterialPredicate[];
  context?: WorldPredicate[];
  work: number;
  effects: Array<MaterialEffect | BodyEffect | ConditionEffect | KnowledgeEffect>;
}
```

第一批只实现一小组“物质/身体如何响应原语”的规则：

```text
ingest + water/food           → 补充水分/营养
separate + wood/crop         → 掉落物
combine + parts/fiber/person → 连接物、包扎或拘束
expose + fire/water          → 加热、燃烧、湿润或熄灭
exert + person/material      → 推移、损伤或破坏
reproduce + eligible person  → 概率进入妊娠
```

配方只判断物质与空间条件，不判断人物是不是“农民、木匠或医生”。某人反复成功执行某类过程后，观察器可以称其为种植者、木匠或照护者，但这个称谓不是权限。

休息不是第七种动作：人物当月没有执行原子动作时，若环境安全且身体资源足够，就进入恢复结算。

状态进入/退出、技术结算、信任账本、交易识别和制度观察都由本地确定性规则完成，不调用模型。LLM 仍只在某人当月触发关键决策时选择一个意图、下一原子动作或结构化命题，因此上述复杂度不会把每月 token 消耗按现象数量放大。

## 五、最小食物闭环

当前文明约十年后因食物耗尽而灭绝。改格子模型的第一价值，就是让食物生产来自物质变化：

```text
seed + wet_soil
  → crop_sprout
  → crop_mature
  → food + seed + exhausted_soil

exhausted_soil + ash/腐败物 + water
  → soil / rich_soil
```

气候只作为世界级外力，使部分物质按规则转换：严寒使水结冰、酷暑使湿土变土、火使植物变灰。无需保存每格温度和湿度曲线。

## 六、需求、能力、关系都做派生

### 需求

人物决策直接读取健康、水分、营养、危险、持有物和重要关系。人物卡仍可把它投影为“生理、安全、归属、尊重、自我实现”，但领域中没有五个需求槽。

### 能力

能力不是开局数值。动作耗时与成功率来自：

```text
身体状态 + 所持工具物质 + 相同过程的历史成功次数 + 当前环境
```

只有实际做过的过程才积累稀疏经验；不保存一整套固定技能表。

### 关系

关系不保存“朋友、领袖、农民”等标签，只从给予、合作、陪伴、伤害、亲属、承诺与违约等事件派生信任与亲近。角色和制度只有在重复事实开始影响后续选择时才成为有用投影。信任可以作为带来源事件的缓存供决策使用，但不是无来源的人格数值。

## 七、DDD 边界

```text
domain/
  material/      物质定义、物质转换、掉落物与背包堆
  world/         体素占位、邻接、表面与可达性
  person/        三项生存属性、状态条件、位置、私有背包、知识
  action/        五种原子动作、意图、可达性与动作结果
  process/       饮食、加工、种植、生殖等局部技术规则
  social/        授权、命题、承诺、选择惯例与定向关系账本

application/
  advance-month  环境变化、身体消耗、动作推进、事件落账
  decide-intent  本地规则或 LLM 只选择合法动作

projection/
  cell-card      物质柱、掉落物、附近实体、活动历史
  person-card    生存状态、背包、需求投影、个人经历
  observer       道路、农田、住所、职业、聚落、技术、交易、金钱与制度
```

## 八、当前字段迁移

| 当前模型 | 新模型 |
|---|---|
| `terrainKind/elevation/fertility/waterDepth/...` | `voxels[position] = materialId` |
| `traces.traffic` | 通行事件驱动物质变为道路；统计从事件派生 |
| `traces.rest/gathering/...` | 从事件查询，不进格子状态 |
| `MatterState holder=cell` | 掉落物实体 |
| `MatterState holder=agent` | 人物私有 `inventory` |
| `StructureState/components` | 已放置物块；结构效果由拓扑派生 |
| `body.health/hydration/nutrition` | 保留 |
| `body.fatigue` | 删除；成本进入水分和营养，休息影响恢复 |
| `body.ageMonths/state` | 由出生与死亡月份派生 |
| `mind.needs` | UI 与决策时派生 |
| `limbs.abilities` | 工具 + 稀疏实践历史派生 |
| `relations[].word` | 从互动事件派生关系 |
| `PlanMode` | 删除 |
| `plans[]` | 每人至多一个 `Intent`；历史只留事件 |

## 九、实施顺序

1. 建立物质表、2.5D 体素存储和新的格子检查器。
2. 把现有地形转换为物质柱；把植物、水、火、冰变成物质。
3. 把世界物品与人物物品分别迁移为掉落物和私有背包。
4. 引入五种原子动作，以适配层暂时执行现有计划。
5. 加入状态条件和统一身体结算，再实现伤害、治疗、死亡因果。
6. 实现种植—收获—土壤恢复闭环，验证温和气候下存在可跨越 600 个月的文明。
7. 删除 `PlanMode` 和重复结构状态；改用 `Intent + PrimitiveAction + InteractionRule`。
8. 加入授权、见闻、结构化命题和承诺，使分享、偷窃、交易、信任与背叛先出现。
9. 最后加入生殖—妊娠—出生、知识传播与群体选择惯例；复杂制度必须建立在真实食物余量和事件事实上。

## 十、边界规则

- 一个体素同一时刻只有一种物质；人物和掉落物是实体，不占用“格子属性”。
- 不新增抽象文明库存。
- 不新增 `farm/trade/care/teach` 等动作模式。
- 不新增 `kill/birth/steal/vote/betray/enslave/money/research` 等结果型动作。
- LLM 只能选择引擎生成的合法原子动作，不能创建物质或直接声明结果。
- “住所、道路、农田、职业、聚落、信任、交易、金钱和制度”必须由物质布局、结构化承诺和事件历史识别。
- 观察器删除后，世界事实仍应照常演化；只有明确反馈到选择的惯例例外。

## 参考机制

- [Minecraft 官方入门](https://www.minecraft.net/en-us/article/how-minecraft)：取得、携带、放置和合成是统一的世界操作。
- [Minecraft 官方农耕指南](https://help.minecraft.net/hc/en-us/articles/360046311411-A-Beginner-s-Guide-to-Farming-in-Minecraft)：种子、适宜位置、生长与收获构成可持续食物循环。
- [Minecraft Redstone 官方说明](https://help.minecraft.net/hc/en-us/articles/360045950932-Getting-started-with-Redstone-in-Minecraft)：少量局部交互元件可以组合出复杂自动化。
- [RimWorld 官方介绍](https://rimworldgame.com/)：身体、需求、关系和经历共同驱动人物故事。
- [Dwarf Fortress 官方特性](https://bay12games.com/dwarves/features.html)：持久世界、材料、事件和场所积累成历史与文明。
- [Oxygen Not Included 官方介绍](https://www.klei.com/games/oxygen-not-included)：资源循环决定群体能否从生存走向繁荣。
