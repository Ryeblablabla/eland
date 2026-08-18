# Eland 千项能力的最小涌现底座 v1

状态：扩展设计。生物个体、物质体素、五类原子动作、知识记录、授权与共同体内核已大量进入运行时（当前 schema 17）；能量/信号网络、多区域与高级物理层仍未实现。运行时细节与本文冲突时以 `domain/` 为准。

关联：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [人类社会活动一千项能力地图](./human-society-capability-map-1000.md) · [最小物质—人物—动作模型](../three-body/design/minimal-emergent-human-model.md) · [月度时间模型](./monthly-time-model-v1.md)

## 一、核验结论

“一千个人类重点事件”实际是一千项**能力观察坐标**，不是一千个待编写的剧情脚本，也不是科技树。它们按 55 个领域组织，反复组合的是少数底层机制：身体过程、物质转换、学习与传播、承诺与授权、组织与规则、交换与记账、冲突与控制、生态与灾害、跨地域网络。

当前运行时观察器 v2 共有 137 个定义：120 个与地图原标签逐项一致的坐标，其中 53 个有当前结构化事实支持、67 个保持 guarded；另有 17 个不冒用地图编号的三体/世界复杂事件。观察器位于 `projection/capability-milestones.ts`，并由 `application/monthly-simulation.ts` 统一投影；定义、严格语义和六条 30 年历史重投影见[《能力里程碑因果观察器 v2》](./capability-milestones-causal-observer-v2.md)。

即使如此，正确方向仍然不是逐条手工添加其余九百多项动作，而是继续补齐最小底座，使人物只面对局部问题并执行少量动作，而千项观察器在事后识别其组合结果。

## 二、什么才算“理论上可以自然演化”

某项能力只有同时满足以下五点，才算由底座支持：

1. **前置事实可以存在**：例如偷窃需要持有与授权，背叛需要先前承诺，疫病需要传播载体；
2. **人物可以从局部认知选择手段**：不能把能力编号或结果名称注入人物目标；
3. **原子动作可以真实改变世界**：材料、身体、位置、关系或承诺必须发生可重放变化；
4. **结果能继续产生因果**：法律、货币、职位、知识不能只是观察器标签，人物以后必须能依据它们行动；
5. **观察器有闭合证据链**：参与者、时间、地点、材料、强制程度、受益与损害均可追溯。

以下都不算覆盖：

- LLM 说“我们建立了一所学校”，但没有场所、教师、学生、课程、重复教学和知识变化；
- 观察器把某人标成国王，其他人却从未授权、服从、纳税或反抗；
- 直接给物品打上 `money` 标签，却没有跨人流通和延迟交换；
- 直接执行 `invent-electricity`，却没有导体、能量源、连接结构和实际用电结果。

## 三、完整底座不是四类数据，而是九类事实

状态、物质、原子动作和人物属性仍是核心，但它们不足以区分交易与赠与、背叛与改变主意、法律与个人意见。最小完备底座需要九类事实：

```text
1. 空间与物质       哪里有什么、如何连接
2. 能量与信号       什么在流动、传播和驱动
3. 生命与身体       生长、受伤、疾病、繁殖和死亡
4. 人物动机与行动   为什么选、实际做了什么
5. 见闻与知识       谁知道什么、依据是什么
6. 持有与规范       谁控制、允许、承诺或禁止什么
7. 关系与群体       谁信任谁、谁属于哪个持续共同体
8. 记录与账户       信息、债务、份额、身份和规则如何跨时保存
9. 实践与制度投影   重复行为如何被识别为职业、市场、法律或国家
```

前八类是可产生后果的领域事实；第九类是可删除重算的观察结果。观察器不得反向修改世界。

## 四、人的基础属性：三个生存值不变，补足身体能力与非生存动机

### 4.1 人物聚合

```ts
interface PersonState {
  id: PersonId;
  bornAtMonth: number;
  diedAtMonth?: number;
  biologicalProfileId: BiologicalProfileId;
  geneticParents: PersonId[];

  body: {
    health: number;
    hydration: number;
    nutrition: number;
  };

  baselineCapacities: {
    locomotion: number;
    manipulation: number;
    perception: number;
    communication: number;
    cognition: number;
  };

  personality: {
    baseline: HexacoVector;
    learnedDelta: HexacoVector;
    evidence: PersonalityEvidence[];
    changes: PersonalityChange[];
  };

  motiveSensitivity: {
    control: number;
    status: number;
  };

  conditions: ConditionInstance[];
  affects: AffectInstance[];
  inventory: ItemStack[];
  knowledge: KnowledgeRef[];
  activeIntent?: Intent;
}

interface AffectInstance {
  kind: 'fear' | 'anger' | 'grief' | 'attachment' | 'shame' | 'guilt' | 'hope';
  intensity: number;
  target?: WorldRef;
  sinceMonth: number;
  sourceEventIds: EventId[];
}
```

仍然只有 `health / hydration / nutrition` 三条身体储备，不新增精力、幸福、智力、魅力等几十条数值。

`baselineCapacities` 不是技能表，而是身体能够移动、操作、感知、沟通和认知的基础范围。当前能力由下式派生：

```text
当前能力
= 基础身体能力
× 年龄阶段
× 伤病、暴露和情绪状态
× 辅具、工具与环境
× 已知技术的效率
```

这使衰老、残障、康复、辅助器具、训练和职业伤害有真实作用，同时避免给人物预装“农业 73、医学 42”式技能条。技能仍是带证据的 `KnownTechnique`。

### 4.2 HEXACO 人格、动机敏感度与动态需要

人物以六条连续维度保存相对稳定的人格倾向，而不是被归入一种固定人格类型：

- `honestyHumility`：真诚、公平、不利用他人与特权感的相对倾向；
- `emotionality`：危险敏感、焦虑、依恋和共情的相对倾向；
- `extraversion`：社会接近、公开表达和活跃程度；
- `agreeableness`：宽容、妥协、温和与愤怒阈值；
- `conscientiousness`：组织、持续投入、谨慎与冲动抑制；
- `openness`：好奇、试验、创造与接纳陌生方案。

六维只调节已有合法候选的相对价值，不生成压力、物质、知识、授权或行动。诚实—谦逊低不会凭空产生偷窃；必须先存在人物可感知的资源收益、他人持有和缺少授权。开放性高也不会直接解锁配方；必须先有真实问题、可观察材料和合法试验。

`control` 与 `status` 分别表示对失去选择权、社会声望与可见职责的敏感度，属于动机差异，不冒充 HEXACO 人格。归属、自主、胜任、安全和照护压力仍从身体、孤立、关系、拘束、失败、承诺和受益者风险动态派生。人物卡的五层需求只是读取投影：

```text
生理       = 三项身体缺口
安全       = 暴露、暴力、控制与资源不确定性
归属与爱   = 当前关系缺口 + 情绪性/外向性的有限调节
尊重       = control/status 敏感度 + 社会反馈
自我实现   = 开放性 + 已掌握知识与可用余量
```

性别、职业、阶层、民族、宗教和公民身份不是基础生物属性。生殖身体来自 `biologicalProfileId`；身份来自本人主张、他人分类、群体成员资格和制度记录，它们可以不一致并随历史改变。

## 五、状态系统：身体状态、情绪状态和社会处境分开

### 5.1 通用状态规则

不为每个状态写一套特殊循环，所有状态使用同一数据结构：

```ts
interface ConditionDefinition {
  id: ConditionId;
  enterWhen: Predicate;
  enterProbability?: ProbabilityRule;
  progressEveryMonth: TransitionRule[];
  exitWhen: Predicate;
  exitProbability?: ProbabilityRule;
  modifiers: {
    nutritionCost?: number;
    hydrationCost?: number;
    healthDelta?: number;
    capacityMultipliers?: Partial<CapacityVector>;
    perceptionFilters?: PerceptionFilter[];
    decisionBiases?: DecisionBias[];
    restrictions?: ActionRestriction[];
  };
}

interface ConditionInstance {
  definitionId: ConditionId;
  stage: number;
  sinceMonth: number;
  sourceEventIds: EventId[];
  carrierId?: OrganismId | MaterialStackId;
}
```

进入、恶化、恢复和退出的概率由世界种子、月份、人物、状态和阶段确定性采样，同一历史必须可重放。

### 5.2 第一批状态族

| 状态族 | 例子 | 千项能力中产生的压力 |
|---|---|---|
| 环境暴露 | 温暖、寒冷、炎热、潮湿、缺氧、烟尘、中毒、辐射 | 衣物、住所、消防、污染治理、迁徙、职业保护 |
| 损伤与疼痛 | 创伤、出血、骨折、烧伤、慢性疼痛 | 医疗、照护、辅助器具、暴力后果、工伤制度 |
| 疾病与传播 | 感染、寄生、免疫、慢性病 | 隔离、卫生、药物、疫苗、医院与公共卫生 |
| 生命周期 | 婴幼依赖、青春期、成年、衰老、妊娠、产后 | 家庭、教育、代际责任、人口变化和继承 |
| 功能受限 | 移动、操作、感知、沟通或认知受限 | 无障碍、康复、照护、排斥与权利争取 |
| 摄入与依赖 | 饱足、饥饿、脱水、醉酒、耐受、戒断 | 饮食、药物、成瘾、禁忌、治安与公共卫生 |
| 短中期情绪 | 恐惧、愤怒、悲伤、孤独、依恋、羞耻、内疚、希望 | 安慰、复仇、道歉、信任修复、艺术与仪式 |
| 强制处境 | 拘束、监禁、受威胁、被隔离 | 奴役、惩罚、逃亡、营救、服从与反抗 |

年龄阶段由出生月份派生，不重复保存。温暖、饥饿等能从当前事实重算的状态也不持久保存；伤口、感染、妊娠、依赖和拘束才保存进程。

情绪不是世界对人物内心的全知结论。它来自本人体验和事件评估，外人只能观察表达或听取陈述。梦、信仰体验、身份感受等主观项目只能保存为人物经历与自述，不能冒充客观事实。

情绪强度由触发事件增加，再按人物处境逐月衰减或被新事件强化。恐惧提高避险与寻求保护的权重，愤怒提高对抗与制止的权重，悲伤降低工作投入并提高陪伴需求，依恋提高接近与照护权重，羞耻/内疚提高隐藏、道歉或补偿权重，希望提高长期意图的维持概率。它们只能改变选择权重，不能直接命令人物复仇、原谅或信仰。

## 六、物质模型：格子仍只有物质，但世界不能只有格子

### 6.1 四层物质表达

```text
体素 Voxel       = 这个位置是什么物质
物品 MaterialLot = 可移动的某种物质及数量、来源
组装体 Assembly  = 若干部件怎样连接
活体 Organism    = 能代谢、生长、繁殖和患病的实体
```

格子继续只保存 `materialId`，不恢复肥力、植被、交通、休息次数等属性包。不同能力放在正确层级：

- 土壤肥力由土壤物质、腐殖物和养分循环表达；
- 道路由地表物质改变表达；
- 斧、车、船、织机和发电机是部件连接形成的组装体；
- 动物、可育种作物和病原体是活体或生物谱系，不是无历史的贴图；
- 房屋、桥梁、管网和电网从放置物与连接拓扑派生。

### 6.2 物质定义需要的最小性质

性质属于同类物质的定义，不属于单个格子：

```ts
interface MaterialDefinition {
  id: MaterialId;
  phase: 'solid' | 'liquid' | 'gas';
  density: number;
  hardness: number;
  toughness: number;
  porosity: number;
  flammability: number;
  thermalConductivity: number;
  electricalConductivity: number;
  opticalTransmission: number;
  solubilityTags: string[];
  chemicalTags: string[];
  biologicalTags: string[];
  consume?: { nutrition?: number; hydration?: number; toxicity?: number };
}
```

这些少量性质使同一原语在不同材料上产生不同结果。`separate + stone tool + wood` 可能得到木料，`expose + heat + ore` 可能得到金属，`combine + fiber` 可能得到绳与织物。具体化学、冶金、电气和生物规则仍是世界规律，不是人物动作。

### 6.3 组装体，而不是预置产品枚举

```ts
interface Assembly {
  id: AssemblyId;
  parts: Array<MaterialLotRef | AssemblyRef>;
  joints: Array<{ a: PartRef; b: PartRef; kind: JointKind; strength: number }>;
  occupiedVoxels?: VoxelPosition[];
  condition: number;
  sourceEventIds: EventId[];
  recordPayloadId?: RecordId;
}
```

工具、容器、武器、衣物、车辆、机器、建筑和记录载体共用这一模型。功能由部件材料、形状、连接、当前状态和已知使用方法共同产生，不保存 `isFactory` 或 `isTemple`。

### 6.4 能量与信号是稀疏流，不是格子属性

工业、基础设施、媒体和数字网络无法只靠静态物质表达。增加五种可传播量：

```text
热        heat
机械功    mechanical
化学势    chemical
电        electrical
光/信号   radiant/signal
```

它们只存在于正在运行的源、连接和汇组成的稀疏网络中，不给所有体素增加五个字段。水渠、风车、蒸汽机、电网、广播和计算设备共享“源 → 连接 → 转换 → 负载”模型。

### 6.5 非人生命不可省略

要覆盖捕猎、驯化、育种、畜牧、渔业、传染病、生态保护和生物多样性，至少需要：

```ts
interface OrganismState {
  id: OrganismId;
  speciesId: SpeciesId;
  lineageId: LineageId;
  position: VoxelPosition;
  bornAtMonth: number;
  body: { health: number; hydration: number; nutrition: number };
  heritableTraits: TraitValue[];
  conditions: ConditionInstance[];
  behaviorPolicyId: BehaviorPolicyId;
}
```

动物可以使用确定性本地行为，不调用 LLM；微生物和大规模植物可以按种群批次模拟。人类仍是唯一具有完整命题、承诺和制度能力的主体。

### 6.6 世界必须在无人行动时继续变化

人物原子动作不是世界变化的唯一来源。增加数据驱动的局部过程规则：

```ts
interface WorldProcessRule {
  id: WorldProcessRuleId;
  neighborhood: LocalPattern;
  rate: number;
  probability?: ProbabilityRule;
  effects: Array<MaterialEffect | EnergyEffect | OrganismEffect | AssemblyEffect>;
}
```

第一批过程族只有：

```text
重力、支撑与结构失效
液体/气体流动和渗透
传热、相变、燃烧和熄灭
腐败、发酵、污染和简单化学变化
植物生长、繁殖、死亡和土壤养分循环
病原传播、感染进程和免疫
能量与信号沿有效连接传播
```

它们仍遵守“格子只是什么物质”：温度、污染量和网络负载只在活跃区域或实体上以稀疏过程状态存在，不把每个格子恢复成大属性包。洪水、火灾、疫病、食物变质、停电、生态退化和基础设施老化因此可以在没有人物决定时发生，人物只能提前预防、当时应对或事后修复。

## 七、原子动作：由四类增为五类

原设计的 `move / transfer / act / speak` 已能覆盖生存和直接互动，但无法区分“路过时看见”与“持续测量”，也无法统一口语、手势、文字、音乐、广播和数字信息。因此改为：

```ts
type PrimitiveAction =
  | { kind: 'move'; to: PositionRef }
  | { kind: 'transfer'; object: PhysicalRef; quantity: number; from: HolderRef; to: HolderRef }
  | { kind: 'act'; operation: SourceOperation; targets: WorldRef[]; tool?: AssemblyRef }
  | { kind: 'attend'; target: WorldRef | RecordRef | ClaimRef; instrument?: AssemblyRef }
  | { kind: 'communicate'; content: RepresentationRef; channel: ChannelRef; audience: AudienceRef };

type SourceOperation =
  | 'exert'
  | 'separate'
  | 'combine'
  | 'expose'
  | 'ingest'
  | 'reproduce'
  | 'hunt'
  | 'dehydrate'
  | 'rehydrate';
```

`SourceOperation` 仍是封闭集合，但已随运行时扩展为九种：`hunt` 覆盖对动物的追踪与捕杀，`dehydrate / rehydrate` 是三体式乱纪元的主动脱水休眠与恢复（见[纪元、预言与生态](./three-body-era-ecology-v1.md)）。新增原语只允许是物质或身体层面的通用作用，不允许是"耕种、交易、选举"这类目的型动作。

### 五类动作的边界

- `move`：人物或受控组装体沿真实路径改变位置；
- `transfer`：能被物理持有的物质、物品、组装体或记录改变位置/持有者；权利变化必须来自被接受并被群体承认的规范事实，不能被这个动作凭空搬运；
- `act`：固定局部作用原语，效果由目标、工具和世界规律决定；
- `attend`：投入时间观察、测量、阅读、比较或核验，产生有来源且可能有误差的知识；
- `communicate`：通过可用频道向受众表达符号内容。

`reproduce` 只裁决同意、身体和空间条件，不读取“社会是否允许近亲”这类后成规范。亲缘距离通过后代遗传负荷影响初始属性、寿命压力和疾病易感性；人物在观察到真实后果后形成记忆与主张，再由本地规划和沟通逐步产生近亲回避。这样禁忌来自经验传播，而不是世界预装的行为黑名单。

自动看见附近事物仍属于感知，不消耗独立动作；`attend` 表示持续关注、测量和验证，是观察自然、实验、调查、审计、诊断、新闻和科学制度不可缺少的投入。

`communicate` 取代过窄的 `speak`。频道可以由嗓音、手势、触摸、实体记录、信使或设备提供；没有实际频道就不能远程广播。内容可以是：

```text
陈述或询问 Claim
提议、接受或拒绝 Agreement
承诺 Obligation
授予或撤回 Permission/Mandate
支持或反对 Selection/Rule
命令、请求或威胁
教授 Technique/Codebook
表演 Narrative/Pattern
```

这些是通信内容的语用结构，不是 `PlanMode`。交易、选举、教学、审判、祈祷、新闻、罢工和外交仍然是多月、多人的动作链。

开局不必预置成熟语言，只给人物共同的少量身体信号，例如指向、接近、退避和情绪表达。人物反复把新声音、手势或刻痕与眼前对象/事件配对，其他人通过 `attend + communicate(accept/clarify)` 学会同一对应后，才产生共享 `Codebook`。这样既允许最初交流，也保留第 21 项“创造语言”的真实形成过程。

休息仍不是第六种动作：本月未执行劳动且环境允许时进入恢复结算。等待、沉默、拒绝行动也通过意图和当月无动作表达。

## 八、知识、符号和记录：文化与科技的真正底座

只保存自然语言 memory 无法可靠支持文字、档案、法律、宗教、科学、新闻和计算。人物知识需要六种结构化对象：

```ts
type KnowledgeObject =
  | Claim       // 对世界的可真可假陈述
  | Technique   // 可重复原语序列与预期效果
  | Codebook    // 符号、声音、手势与含义的对应
  | Procedure   // 带角色、顺序和条件的共同做法
  | Metric      // 单位、计数、比较与误差方法
  | Narrative;  // 故事、价值解释、艺术或世界观表达
```

每个对象都必须保存作者/知情者、版本、来源事件、证据、置信度和传播链。不同人物可以持有互相冲突的 Claim，也可以使用不同 Codebook。

这套模型产生以下能力链：

```text
观察 + 记忆                 → 个人经验
Codebook + communicate      → 语言与教学
颜料/刻痕 + 载体 + Codebook → 文字与图像
实体载体 + RecordPayload    → 档案、契约、货币、身份凭证
试验 + Metric + Claim       → 科学知识
复制组装体 + 传播链         → 出版、媒体与数据网络
版本分歧 + 群体边界         → 方言、教派、学派与文化混合
```

遗忘只影响人物内存；真实记录可在人物死亡后继续存在。销毁、篡改、复制、保密和访问控制都必须作用于真实记录或授权关系。

### 8.1 未知技术必须经过盲试验

引擎可以根据眼前物质、工具和身体可达范围生成“可尝试的原语组合”，但不向人物泄露隐藏的 `InteractionRule` 或 `WorldProcessRule`。尝试时人物只选择：

```text
对哪个目标
使用哪个 SourceOperation
是否使用眼前工具/材料
愿意投入多久
为什么觉得值得尝试
```

真实输出由世界规则裁决，可能无效、有害或意外成功。人物通过 `attend` 比较前后事实，才把证据压缩为 `KnownTechnique`。`openness`、迫切问题、观察他人成功和可用剩余时间只提高尝试概率，不直接解锁结果。

文化和制度创新走同一原则：人物可以组合既有符号、叙事和规范提出新表达或新协议，但是否被理解、接受、重复和延续由其他人物的通信与行动决定。

## 九、社会事实：用一个规范内核生成市场、法律和组织

### 9.1 三种不能混淆的“拥有”

```text
possession  实际拿着或控制着
claim       某人主张自己有权
title       某群体按已接受规则承认该主张
```

偷窃只要求未授权转移；土地所有权、继承、租赁、抵押、征税和没收则需要主张、规则与群体承认。控制可能存在但不被承认，权利也可能被承认却无法执行。

### 9.2 一个通用规范事实联合类型

```ts
type NormativeFact =
  | Permission
  | Obligation
  | Prohibition
  | OwnershipClaim
  | Membership
  | Mandate
  | Liability
  | DecisionRule;

interface Agreement {
  id: AgreementId;
  parties: SubjectRef[];
  clauses: NormativeFact[];
  acceptedBy: SubjectRef[];
  validFromMonth: number;
  validUntilMonth?: number;
  status: 'proposed' | 'active' | 'fulfilled' | 'breached' | 'revoked' | 'disputed';
  recordRef?: RecordRef;
  evidenceEventIds: EventId[];
}
```

交换、借贷、婚姻约定、租赁、保险、雇佣、条约、职位授权、选举规则和宪法都只是不同条款组合。引擎不魔法执行协议；真实人物必须履行、监督、处罚、修改或违背它。

### 9.3 信任、情感与声誉是定向的

```text
bond(A → B)       依恋和亲近
trust(A → B)      A 基于所知证据对 B 履约/如实行为的预期
fear(A → B)       A 对 B 造成伤害能力与意愿的判断
dependence(A → B) A 的生存或目标多大程度依赖 B
reputation(G, B)  群体 G 中关于 B 的传播性评价
```

它们不是全局友好度。未被 A 看见、告知或从记录获知的行为不能改变 `trust(A → B)`。背叛、诈骗、污名、宣传、宽恕与和解因此都能保留不同人物视角。

### 9.4 通用共同体，而不是预置国家/公司/宗教

```ts
interface CollectiveState {
  id: CollectiveId;
  identityRepresentations: RepresentationRef[];
  membershipFacts: MembershipRef[];
  acceptedRules: AgreementRef[];
  mandates: MandateRef[];
  controlledAssets: HolderRef[];
  records: RecordRef[];
  sourceEventIds: EventId[];
}
```

共同体没有自己的手脚和全局大脑。所有动作仍由具体人物执行，并可附带 `onBehalfOf` 授权。家庭、互助会、行会、企业、宗教团体、军队、政府、国家与国际组织都由成员资格、共同记录、资源、角色和规则的不同稳定组合产生。

### 9.5 账户不是凭空的数值

债务、股份、预算、税收、保险、银行存款和数字货币需要通用账户：

```ts
interface AccountEntry {
  unit: MaterialId | MetricRef | ClaimUnitRef;
  debit: SubjectRef;
  credit: SubjectRef;
  amount: number;
  cause: AgreementRef | TransferEventRef;
  recordedBy: SubjectRef;
  recordRef?: RecordRef;
}
```

账户记录可能丢失、伪造、被争议或失去承认。实物货币仍在背包中；记账货币则依赖可信记录、发行者和群体接受。这样货币、信用和金融危机都能由同一底层产生。

## 十、空间、群体规模与长期时间

一张 84×52 地图不足以形成跨地域贸易、侨民、外交、殖民、全球生态或跨行星能力。空间模型需要保持体素局部真实性，同时增加层级：

```text
VoxelWorld/Chunk  局部生活、建造和交互
Region            多个持久 chunk 与自然边界
Route             人、货物、疾病、消息和能量的真实连接
Planet            气候、资源与远距离共同外力
```

领土、城市、国家和边界不是 Region 的固定属性，而是人物与共同体对空间的控制、命名、使用和争议投影。

人物仍按月保存历史，但每月执行 15 个本地规划刻度。状态、疾病、物质变化、动作执行、传播、履约检查、动作修复和能力观察均由确定性规则完成；本地规划器始终先选择可执行意图和下一原子动作。实时模型只可在少量关键上下文中从已经生成的合法候选内重选，长期战略、玩家交互、创造性表达与叙事继续使用受约束任务；后台快速演化不调用模型，因此不会因能力地图或人口扩展而线性增加 token。

大人口下，动物、作物、病原体和人物都使用可扩展的确定性策略；只有被选中的重大转折或玩家交互才进入模型任务。不能为了性能把共同体直接变成会瞬移资源的超级 Agent。

## 十一、千项地图的机制覆盖审计

下表判断的是“底层能否表达”，不是已经写好观察器。

| 能力带 | 主要编号 | 必需底座 | 设计结论 |
|---|---:|---|---|
| 生命、健康、家庭与照护 | 1–10、101–200、861–900 | 身体状态、生命周期、情绪、亲缘、照护动作、疾病传播 | 核心底座可表达 |
| 生存、食物、居住与日常 | 11–20、121–160 | 物质、组装体、摄入、暴露、私有背包 | 核心底座可表达 |
| 语言、教育、记忆、艺术、宗教与游戏 | 21–30、51–60、201–320 | attend、communicate、Codebook、Narrative、记录和共同程序 | 核心底座可表达；作品“好坏”和信仰真实性只能作为人物评价 |
| 农业、生态与其他物种 | 31–40、341–360、821–840 | 活体谱系、种群、土壤/水循环、疾病与遗传差异 | 核心底座可表达 |
| 手工业、交通、城市与基础设施 | 41–44、321–400、721–740、781–800 | 组装体、连接拓扑、能量网络、多区域 | 需要工程扩展；不新增人物动作 |
| 交换、市场、货币、金融与财富 | 45–50、421–480 | 授权、Agreement、账户、记录、共同体与多区域流通 | 核心底座可表达 |
| 劳动、社群、组织、治理、法律、行政与权利 | 61–67、77–87、401–420、481–640、881–920 | 共同体、成员、角色、规则、授权、义务、执行与争议 | 核心底座可表达 |
| 犯罪、军事、外交与和平 | 68–76、641–700、921–940 | 伤害因果、控制、集体授权、边界、承诺、见闻与责任 | 核心底座可表达；必须记录强制与受害者 |
| 迁徙、跨文化与全球网络 | 75、701–720、961–980 | 多区域、路线、语言版本、群体边界、疾病与物质流 | 需要多区域扩展 |
| 信息、新闻与科学 | 741–800 | 观察、测量、Claim、来源链、记录、复制和组织 | 核心底座可表达 |
| 工业、能源、即时传播与自动化 | 88–94、361–380、399、801–820 | 能量/信号网络、精密组装、算法记录、设备控制 | 需要能源—信号—计算扩展 |
| 灾害、公共卫生、崩溃与重建 | 15、76、841–880、941–960 | 环境过程、传播、制度稳定度、供应网络、历史版本 | 核心底座可表达 |
| 核、基因、太空、AI 与行星治理 | 95–100、981–1000 | 高级物理、生物、计算、行星与轨道模型 | 后期可选；第一阶段允许忽略 |

第一阶段把理论表达目标明确为 **954 / 1000**：审计 1–94、101–800、821–980；暂缓 95–100、801–820、981–1000 共 46 项。被暂缓的是核力量、地外空间、完整基因改写、数字网络、人工智能和行星/跨世代高风险治理。它们若提前做，会迫使系统用标签伪造缺失的核物理、分子生物、轨道、计算或行星层。

“954 项理论可表达”不等于“954 项正式覆盖”。前者表示底层事实与动作没有结构性缺口；后者仍要求每项拥有可裁决观察器和闭合证据链。

### 观察器使用组合 DSL，不写一千段流程代码

一千项定义仍然需要逐项表达语义，但可复用少量时序和关系算子：

```ts
interface CapabilityDefinition {
  id: string;
  attempt: EvidencePredicate;
  stabilize?: EvidencePredicate;
  decline?: EvidencePredicate;
  disappear?: EvidencePredicate;
  rebuild?: EvidencePredicate;
  dimensions: Array<'scale' | 'duration' | 'voluntariness' | 'benefit' | 'harm'>;
}

type EvidencePredicate =
  | EventMatch
  | Sequence
  | CoOccurrence
  | RepeatAcrossMonths
  | DistinctActors
  | DiffusionAcrossPeople
  | StableRoleAndRule
  | ResourceFlow
  | NetworkTopology
  | BreachOrRepair
  | ComparisonAcrossCases;
```

例如“市场”复用多人、重复月份、报价—接受—交割、共同地点和交换网络算子；“医院”复用多人照护、稳定场所、医者角色和健康改善算子；“革命”复用旧授权被大规模撤回、冲突、规则替代和新共同体稳定算子。定义只读取事实，不向人物暴露能力名称。

## 十二、代表性组合，验证没有隐藏的结果型动作

| 复杂能力 | 实际底层组合 |
|---|---|
| 接生与医疗机构 | 妊娠状态 + attend 诊断 + 材料/身体 act + 重复照护 + 场所 + 医者角色 +记录 |
| 语言与学校 | Codebook/可靠技术的明确教导 + 师生承诺 + 重复场所使用 + 知识变化 |
| 宗教 | Narrative + 自然解释 Claim + 仪式 Procedure + 表演/供奉 + 共同体 + 跨代传播 |
| 市场与货币 | 报价 Agreement + 条件转移 + 重复地点 + 多方流通 + Metric + 价格记录 |
| 银行与保险 | 账户 Claim + 存取承诺 + 风险条件 + 共同资金 + 记录可信度 + 违约/赔付 |
| 法律与法院 | 公布 Rule + 管辖成员 + 证据 attend + 申辩 communicate + Mandate + 裁决 + 人物执行制裁 |
| 国家 | 多地域共同体 + 成员/边界 + 税收义务 + 官职授权 + 公共资产 + 持续执行与被服从/反抗 |
| 战争 | 两个共同体 + 敌对 Claim + 动员授权 + 武器/补给 + 群体伤害 + 领土控制 + 停火承诺 |
| 科学 | 问题 Claim + 测量 Metric + 重复 attend/act + 失败记录 + 传播 + 他人复现 + 修订置信度 |
| 工厂 | 能量源 + 组装设备 + 重复 Technique + 角色分工 + 输入物流 + 批量输出 + 维修记录 |
| 新闻与宣传 | 收集 Claim + 来源链 + 编辑 Procedure + 记录复制/信号广播 + 受众知识和信任变化 |
| 崩溃与重建 | 供应、记录、信任、成员和规则的稳定度下降；地方实践替代；之后重新履约和复制知识 |

## 十三、DDD 边界建议

```text
domain/
  world/          体素、chunk、region、route、气候与灾害
  matter/         物质、物品堆、组装体、连接和衰变
  energy/         热、机械、化学、电与信号网络
  life/           活体、人物、生命周期、状态、疾病与遗传
  agency/         意图、五种原子动作、感知、情绪与局部决策
  knowledge/      Claim、Technique、Codebook、Metric、Narrative、记录
  social/         关系、授权、Agreement、共同体、角色、规则与责任
  economy/        持有、所有权、交换、账户、债务与份额

application/
  advance-month/  环境、15 个规划刻度、身体、传播、履约和事件落账
  plan-tick/      本地规划、动作编译、预演、修复与执行
  model-task/     异步长期建议、玩家交互、创造性表达与叙事
  communicate/    频道可达性、理解、复制误差和知识更新

projection/
  practice/       重复个人与多人行动
  institution/    被共享规则约束且能延续的实践
  capability/     1000 项版本化观察器与证据链
  narrative/      人物自己的解释、争议与历史书写
```

`capability` 只能依赖 domain event 和其他可重算投影，不能被 `decide-intent` 读取。

## 十四、实施顺序

### 阶段 A：完成生物个体闭环

1. 保留三项身体值，增加通用 Condition、派生身体能力和四个动机偏置；
2. 增加年龄、妊娠、出生、伤害因果、疾病传播和死亡遗留物；
3. 把 `speak` 改为 `communicate`，增加 `attend`；
4. 先验证生育、照护、杀戮、信任、偷窃、分享和知识学习。

### 阶段 B：完成可持续物质世界

1. 建立物质体素、物品堆、组装体和局部 InteractionRule；
2. 加入植物、动物、种子谱系、土壤养分、食物腐败与废弃物；
3. 验证农业、畜牧、衣食住、工具、火、医疗和生态反馈；
4. 文明应先能在多个种子下跨越 600 月，而不是固定十年灭绝。

### 阶段 C：完成语义与规范闭环

1. 实现 Claim、Technique、Codebook、Metric、Narrative 和实体记录；
2. 实现 Permission、Agreement、定向信任、持有/主张/所有权；
3. 实现通用 Collective、Membership、Mandate 和 DecisionRule；
4. 验证家庭、教学、宗教、市场、货币、选举、法律、奴役、反抗与组织更替。

### 阶段 D：完成工程和跨地域闭环

1. 增加组装体功能、能量/信号网络、Region 与 Route；
2. 验证基础设施、城市、远程贸易、国家、战争、外交、媒体和工业；
3. 最后才选择是否进入计算、核技术、太空与行星层。

### 阶段 E：逐项建立观察器

按能力地图的 55 个领域分批定义证据谓词。每项至少区分：

```text
首次尝试 → 多人重复 → 稳定实践 → 制度化 → 跨代延续
                                  ↘ 衰退 → 消失 → 重建
```

不追求让所有文明都点亮大多数事件；追求相同底座在不同种子、物质分布、人物偏置和历史冲击下产生不同路径，包括长期停滞、压迫、失败、崩溃与恢复。

## 十五、最终边界

- 不新增 `farm / trade / vote / teach / worship / research / war / govern` 等动作类型；
- 不把“状态”当职业、身份、阵营或文明等级；
- 不把格子改回属性包；高级能力进入组装体、活体、网络、知识和规范层；
- 不让规则或组织自己行动，每次执行都追溯到具体人物与授权；
- 不把人物自述当客观事实，也不否定主观体验本身；
- 不因观察器识别到制度就自动强制所有人服从；
- 不让一个人的发现全局解锁，知识必须观察、记录、教授、复制或被重新发现；
- 不把压迫、战争和灾害当作无损“成就”，必须保存强制、责任、受害和延迟后果；
- 不把一千项清单放进人物 prompt；它始终只是一组事后观察坐标。
