# ELAND 模块边界

这里采用单一模拟内核与单向输入 / 输出边界：

```text
UI / HTTP / optional model infrastructure
              ↓ commands / validated choices
        application use cases
              ↓
      simulation kernel
domain model and policies ↔ world grid / material primitives
              ↓ SimulationState + WorldEvent
 observer / projection / adapter → UI read model / report / GameFrame
```

`domain/` 与 `world/` 在模拟内核中互相协作：领域规则读取和修改体素世界，世界基元复用领域材料语义；两者都不能依赖 React、Three.js、HTTP 或模型供应商。`projection/`、`adapter.ts` 与报告只消费已经提交的状态和事件，不能写回模拟内核。

`world.physicalStructureIndex` 是从已提交建造事实与当前体素确定性重建的物理语义索引。当前 v2 只按有限的 `position + building material` 保存首次/最近绝对序号与最近来源，月提交只折叠本月权威 suffix，再按当前 grid 重算连通和住所几何。住所可达性与家庭准备度只能通过 `physicalStructuresOf`，施工连接通过 `constructedConnectionPositionsOf` 读取；planning overlay 只生成不写回的临时 preview。schema 17 的 `derived.structures` 仅保留为序列化兼容镜像；`regions`、`milestones`、`practices / institutions`、`functionalBuildings` 以及 `civilization.civilizationIndex / development` 全部属于观察边界。人物规划器不得把分数、时代、里程碑或观察器标签当成需要、奖励、配方或能力解锁。需要影响行动的设施条件必须回到当前体素、物质、项目、制度执行或来源事件重验。

结构连通默认仍只接受六方向面接触；唯一的功能连接例外是共同形成同一个真实 `shelterGeometry` 的建造屋顶与侧墙。住所必须留出可通行内部，因此这两类构件可能只沿边斜接；索引会把它们合为同一物理结构，但不会泛化合并普通斜邻工地。这样标准三构件住所投影为一个完成结构，不再同时留下伴生的两构件“未完成结构”。

## 目录地图

### world/ —— 世界基元

- `world/grid.ts`：84×52×12 体素世界、cellId/voxelIndex 索引、邻接、通行与确定性最小堆 A*；路径搜索复用 typed-array 工作区。体素仍为每次真实变化递增世界修订，但只有空气占用、站立支撑或移动成本发生语义变化时才失效站立 / 路径缓存；草地变裸土等通行语义等价变化保留缓存，夯土道路、固液变化与拓扑变化仍立即失效。缓存可丢弃且不进入权威状态。
- `world/generator.ts`：只负责生成初始自然事实与出生格；当前世界还会沿真实河道确定性生成并持久化两条有向 `water current` 段链，段是否可用仍由当前 Water 体素与上游连通性现场派生，不把 `active` 缓存成事实。

### domain/ —— 领域模型与规则

- `domain/model.ts`：`SimulationState` 聚合根（体素世界、掉落物、动物、人物、意图、协议、共同体、权限、容器、纪元预言、文明指数与派生观察）。人物决策上下文只暴露 `DecisionAuthorityState`：它在类型层移除 `derived` 与文明阶段、指数、发展观察字段；完整聚合仍可结构赋值，不复制状态或引入第二身份。
- `domain/person.ts`：人物权威状态（三项身体储备、过程状态、体素位置、私有背包、知识、有来源的丧亲经历与 optional `CharacterAgenda`）；脱水休眠在同一 episode 内区分低代谢 `dormant` 与受限补给 `recovering`，携带液体栈绑定同一实体容器。
- `domain/character-agenda.ts`：schema 17 optional nested 的有界长期关切。`aim` 是人物有来源的主观事实，`approach` 是可替换、可被真实 response / no-response 反驳的方法；一个 agenda 可关联多个 Intent / Project，但本身不能执行。状态恢复、容量淘汰、证据去重、Intent 绑定和“同 basis 无新事实不得盲重试”都在领域层保持确定性。
- `domain/trait.ts`：出生时一次确定且终身不变的十三种人物特质、固定先民配置、最多三项的确定性遗传与一项随机异变审计，以及寿命、能力、身体、生殖、记忆、配方与母脉效果的共享规则。
- `naming.ts`：姓氏传统、确定性后代保底姓名，以及模型 `givenName` 候选的字符、顺序和重名验收；模型不能改姓氏或绕过回退。
- `domain/material.ts`：物质定义与调色板。
- `domain/action.ts`：五种原子动作、十种 `SourceOperation`、`WorldRef` 与 `Intent` 类型。
- `domain/intent.ts`：意图选择的组装与校验。
- `domain/intent-follow-up.ts`：生活对话开场与后续物理行动的共同人物、项目或来源事实校验。
- `domain/action-executor.ts`：原子动作的稳定预演 / 执行门面；`domain/actions/` 分别承接库存、物质观察、机械动力、沟通、技术学习、丧葬与 attend 观察动作族；`attend-actions.ts` 统一拥有项目接任检查、度量 / 故障观察、记录阅读与实体核验。带精确技术、制造事件和预期材料的源绑定核验先检查实体物性及原来源，即使该实体后来写入另一项 `recordPayloadId` 也不会被当前文字内容劫持；没有这类核验请求时才读取记录。共享门面仍保留 `executePrimitiveAction`、`executeIntentAction`、`addDrop` 与 `addInventory`。person→ground 转移只允许投到人物当前 cell / z，不能远程落物；普通 `combine / exert / expose` 在扣减前拒绝把本人背包中带 `recordPayloadId` 的已写载体作为输入，空白载体仍可进入写入或其他合法动作；生殖动作必须绑定一份精确的有效协议，同一伴侣对同一自然月最多完成一次尝试，并在事实中保存协议与双方当时的关系快照。亲代普通移动只自动携带同处、清醒且未满 1 岁的婴儿；已有冷热伤害且正在真实住所内避护的婴儿不会被普通成人行程带到无遮蔽处，带来源的照护运输仍可在更紧急的取水、取食或入住所链路中显式携带未满 3 岁幼儿。休眠者不会隐式换位。
- `domain/calendar.ts`：唯一的月历换算规则（`PLANNING_TICKS_PER_MONTH = 15`）。
- `domain/action-option-semantics.ts`：所有生产 `ActionOption` 的 v1 typed semantics；义务、规划通道、用途、最低年龄、需要、对话 / 生殖 / 社会情境由动作结构和 typed payload 表达，option ID 只作身份、排序、选择与回放。规则规划器、年龄门禁、意图执行与服务端模型网关共享同一校验；仅旧存档迁移可解析 legacy ID。
- `domain/era-prediction.ts`：可行动的乱纪元预言窗口、听众信任门槛与休眠 / 唤醒的局部判断。
- `domain/life-stage.ts`：按月龄划分未满 1 岁完全依赖、1–11 岁受限自主、12–15 岁既有项目协作与 16 岁以上完整规划。
- `domain/survival-reflex.ts`：不消耗模型额度的吃、喝与紧急避险反射；1–11 岁儿童在严重身体或冷热压力下可走向当前确实可见的亲生照护者，动作以 `caregiverRef` 留下因果证据，不读取远方亲代位置。未满 3 岁的恢复期幼儿只摄入本人随身食水，不独自走向外部来源；幼儿因冷热压力已在真实住所内时也不会追逐外出的照护者。
- `domain/shelter-access.ts`：从可见或记得的真实结构中寻找当前仍可达的住所内部；家庭准备度另作更严格判断，只有当前可见且确认空余的真实内部位置计入 shelter 分量，记忆中的远处住所只保留未验证来源且贡献为 0。
- `domain/shared-living.ts`：结伴约定的稳定生活地点、不同格共同生活结算与有界返家目标；不追踪伴侣实时坐标，最后可履约窗口会为待建立关系的已接受约定形成承诺需要，并按履约优先协议打断普通工作。
- `domain/social-space.ts`：普通语音允许水平相邻一格且站立高度相差不超过一级；远处谈话优先走到听者附近占用更低的可达站位。精确站位超过两人只形成自愿疏散的柔性舒适需要，不扣健康、不强制位移，也不放宽物品交付、照护、生殖、施力与携带的同位边界。
- `domain/water-access.ts`：真实水体素的可达性与取水规则；无可见 / 记忆水源时只开启 `bounded-water-search-v1`，冻结最多四个初始可见前沿并依次耗尽，移动后的新视野不得自动把搜索目标继续向外拖，只有新的本人水源证据或真实饮水事实才能重开。水源帮助只从 helper 本人可见或记得的真实水体中选择双方都能到达同一岸边的位置，不用全局地图替请求者补路线。
- `domain/separation-rules.ts`：定义体素物质如何通过同一 `separate` 原语被采出或拆回。
- `domain/container.ts`：有体素位置和内部物品堆的空间持有者；本身不预设所有权。
- `domain/dependent-care.ts`：亲代可读取视野内 12 岁以下亲生子女的真实危机；只有会合后确有安全休眠、手中食物转移或携婴取水 / 入住所等可执行帮助时才接近并近身保护。同一照护 episode 以具体孩子 `personId` 保存目标，后续刻度先重验该目标，再考虑新进入视野的其他孩子；绕障暂时越过感知边界时，眼前健康孩子不能覆盖原目标。同一目的格有多名亲生子女时，只从未满 12 岁者中按身体储备绑定目标，成年人不因数组顺序冒充依赖者。未满 3 岁幼儿与亲代同处时，取水、取食、休眠恢复和入住所的移动携带 `dependent-transport-v1`，执行时重验亲子关系、同处、当月身体 / 条件来源并让双方沿同一路径移动；到达真实水源后，亲代还要完成近身帮助饮水，解除实际水分缺口后才恢复较低优先事务。孩子已经处于真实住所时，单独的冷热状态不再触发亲代会合或让亲代用“照护”名义为自己另找住所；食水、健康与休眠危机仍独立成立。目标可见但没有可站立路径时返回无合法反射，不越过近身门禁生成注定阻塞的转移。1–11 岁儿童的普通移动还受当前可见亲代的本地照护半径约束，已有普通意图越界时会放弃；它不读取视野外身体、不替代长期家庭意图，也不赋予满 1 岁儿童同步移动。远处未成年子女客观死亡不会自动解除 `reproductiveResponsibility`，亲代取得引用该死亡的有来源丧亲认知后才释放责任。
- `domain/mortuary.ts`：普通死亡后的一人一遗体、死亡知情来源、丧亲压力、墓穴与墓记事实。人物只能因局部看见遗体 / 有标记墓穴，或经有来源的死亡对话得知死讯；遗体不是普通材料，安葬状态也不由观察器补写。月末感知用可丢弃空间索引复用已经安葬且有墓记的稳定事实，开放遗体仍每月按当前位置刷新，最终按权威 remains offset 排序。三日凌空汽化是终局例外，不生成遗体或遗物。
- `domain/population-capacity.ts`：50 人软承载附近的受孕概率衰减与超载资源竞争；它是身体 / 生态约束，不进入人物目标或文明指数。
- `domain/structure.ts`：从可站立空气、头顶实体与侧向围护的真实体素拓扑计算结构效果。
- `domain/physical-structure-index.ts`：从已提交建造事件与当前体素重建 gameplay 可读的结构索引；月提交、创世和 schema 17 恢复显式刷新，观察投影只能消费它，不能反向拥有它。
- `domain/memory.ts`：旧存档兼容的有界自传经历写入与遗忘调度；任何经历至少引用一个可回放来源事件，规划器状态与编译诊断不能以自由文本冒充经历，也不再直接作为 Agent 模型输入。
- `domain/agent-memory.ts`：保存有来源的具体经历、模糊、遗忘、情境检索和多轮 `ConversationEpisode`，作为 Markdown 写入器的兼容 backing；程序性信念用稳定 action / goal family 与精确次数表述，不生成“这类事情”或小样本伪百分比；不再允许模型生成巩固摘要或删除原经历。
- `domain/person-mind.ts`：为每个 `PersonState` 维护一份 `person-mind-markdown-v1` 文档。本地 writer 把经历、信念、关切和最近思考确定性写入 Markdown，本地 compiler 再生成规则代码使用的瞬时 `PersonMindView`；一次真实动作失败只由其 `ActionFact` 进入经历，不再叠加一条 Intent 包装失败。Mental Act 模型只收到清理后的 Markdown，旧字段只作 schema 17 codec backing。
- `domain/mental-act.ts`：模型可持久化的主观心智动作，只包含目标、策略、假说、预期观察和来源；它证明“人物这样想过”，不证明假说或结果为真。自由策略可以留在最近思考中，但只有本地已选中的合法 durable option 或重验通过的 opaque probe 才能成为 agenda 的可执行方法，前者的持久化摘要由本地 option 覆盖。
- `domain/social-repetition.ts`：从人物本人保留的沟通记忆评估同受众、同语义主题的再次开口成本；新事实或与求助、照护、困境直接相关的显著生存危险可重新提高价值，正式 required response 与履约不进入这项软投票。
- 失败主题对话只引用具体的非沟通动作事实；同一意图里先完成的生活开场会从下一次失败 basis 中移除，后续物理目标未满足时按实际移动、转移、观察或物质操作描述，不能把旧对话摘要再嵌进新对话。
- `domain/social-learning.ts`：按目标人物与合作情境分别保存回应、意愿、可靠性 Beta 后验；只从协议回应 / 履约 / 违约、带真实贡献的共同项目和授权分配闭环更新。跨两个不同月份的成功才形成 person-local coordination practice，后续反证将其标为 contested；practice 只支持提议，不直接创建制度或权力。状态有界、来源精确保留，旧存档缺失时保持空先验。
- `domain/material-perception.ts`：把权威物质压缩为人物可感知的相态、外形、表面观感，以及拿取 / 核验后才知道的粗负重与刚性；不暴露配方、规则 ID 或预期产物。
- `domain/project-material-request.ts`：从追加式项目材料请求与真实转移事实派生 `open / fulfilled / expired / contributors-unavailable`，不另存第二套请求状态机；新转移精确绑定请求引用，贡献量以请求剩余量和项目当前缺口共同截断。
- `domain/spatial-knowledge.ts`、`domain/interaction-knowledge.ts`：人物的空间知识与交互/技术知识。
- `domain/interaction-rules.ts`：物质响应原语的数据驱动规则；库存制作、播种、容器改造与结构安装共享兼容执行操作，但使用不同的人物工艺语义，空气位置不会被表达成配方原料。
- `domain/mechanical-power.ts`：显式水流源、`WaterWheel → DriveShaft → Mill` 严格拓扑、安装计划与网络身份，以及安装、commissioning 故障、维修和运行的追加式来源事实；普通 Water 体素不能被猜成动力源，断流也不能由下游局部 Water 绕过。
- `domain/electrical-power.ts`：有限真实电网的发电源、绝缘铜导体、电阻负载、安装计划、网络身份与拓扑验证；机械作业仍不等于电力，必须由这条独立链产生运行、负载、故障和恢复事实。
- `domain/monthly-processes.ts`：无人行动也推进的世界 / 身体过程稳定门面；`domain/monthly/climate.ts` 承接纪元、气候、天气与预言，`wildlife.ts` 承接分阶段动物生态，`relationship-experience.ts` 承接共同活动和持续共同生活证据。冰面融化等自然表层变化若让同格人物失去站立支撑，只在该真实变化格上把人物移到半径 2 内最近可站立位置，并写入带来源变化的环境事实。妊娠、产后恢复、休眠与死亡等身体结算仍留在总门面，等待下一轮按生命周期再拆；动作阶段已经把健康降到 0、但尚未写入死亡事实的人也在同月完成一次死亡、遗体与遗产结算，不留下零生命幽灵。新生儿不再向全部历史人物预铺零值关系，只为出生时真实同地者、仍存活亲代和后续有来源互动建立稀疏关系边。实时宇宙传入的 `triple-sun-vaporization` 在第一个规划刻度内绕过住所、休眠与特质，使全部存活人物汽化、销毁随身库存且不生成遗体或遗物；普通 `fire` 仍逐月结算。全员休眠不会终止文明；新恒纪元、提前休眠所依据的预言失效，或恒纪元中的身体危险只在人物持有可饮物或能到达当前感知水源时，才使严重缺水的 `dormant` episode 转入不凭空增加储备的 `recovering`；没有补水可供性时继续低代谢并保持旁人救援机会。成人恢复者会先饮用随身真实水；真实补水 / 补食并达到三项最低储备 45 后才退出，乱纪元重临则沿用原 episode 返回 `dormant`。直接死亡会终结当前及全部暂停意图；休眠恢复若发现人物死亡或项目已经完成、阻塞、放弃、缺失，也按真实样本结算 `goalOutcome` 并清理中断边，只有真正恢复为 active 的意图暂不结算。
- `domain/animal.ts`：动物实体的位置、身体、繁殖与行为。
- `domain/kinship.ts`：由出生事实派生亲缘距离、遗传风险与人物有来源的风险认知强度；亲缘影响后代结果与人物选择，但不把动作改成非法。
- `domain/agreement.ts`、`domain/collective.ts`、`domain/permission.ts`、`domain/governance.ts`、`domain/declaration.ts`、`domain/record.ts`、`domain/social-facts.ts`、`domain/relation.ts`、`domain/relationship-evidence.ts`：协议、共同体、授权、治理规则、声明、实体记录、社会事实、定向关系账本与正式关系证据。新文明的先民因共同抵达从双向 `trust=10 / bond=10` 开始；旧存档保留已持久化数值。`founding` 只表示相识，不单独成为 company、companion 或生育提议的关系证据；预测、无关环境事实和未指向这对人物的行动同样排除。每条定向关系继续保留最近 24 条来源供近期情境与自然遗忘，另有界保留真实双方互动、直接照护 / 实质回应 / 履约、共同生活，以及明确接受 / 拒绝边界；decision boundary 按 `companion / reproduce × self / other` 语义槽位保存，同月不同方向的决定不会互相覆盖。正式关系读取前几类关系来由；接受 / 拒绝只形成软偏好，其强度随时间以及之后可回放的对话、照护、履约、共同生活等真实后果连续变化，不解锁能力、不改变关系分，也不删除合法候选。高频普通更新不能再挤掉关键关系来由；语义锚点不参加生活对话原样去重，不形成永久黑名单。有效生活对话的中性回应即使关系数值增量为 0，也保留为双方确实参与的关系来源；低压力闲聊仍不属于正式关系所需的直接亲密证据。提议因生存中断而延迟到原回应期限之后时，沟通执行会在成为 completed 事实前阻塞，并要求人物根据当前处境重新决定；接受 / 拒绝也必须仍指向本人未回应且处于有效期限的 proposed 协议，不能把聚合拒绝的无效回应记录成已完成表达。取水互助只结算当前行动意图精确绑定的协议，动作当时验证的水源 / 饮水事实写入版本化回执，后来的地形变化不能改写已经发生的履约，无协议绑定的生存反射也不能被倒推成帮助。关系数组只持久化非零、有来源或亲缘边；活人社会来源集合与关系查询使用可丢弃的进程内索引，异常原地改写必须显式失效。只剩一名在世成员的 `dormant` 共同体可经全体在世参与者明确接受新成员后恢复为 `active`。
- `domain/civilization-index.ts`、`domain/era-progression.ts`：文明指数与阶段的纯观察投影，不反向解锁能力。当前 v8 的最高阶段是 `ancient-civilization`（“古代文明”）；旧快照中的 `medieval` 与 `modern-civilization` 只作兼容输入并规范化为古代文明。
- `domain/decision-budget.ts`：实时关键重选的人月额度与 endpoint / token 审计；不得决定人物是否获得本地规划。
- `domain/cognition.ts`：人物私有的有界行动结果后验与结构化因果记忆 basis；只从已提交 `ActionFact` 学习，排除临时 option / intent / project / cell / person ID，无位移 move 不作为经验样本。没有执行过任何动作、只因重编译得不到下一原子动作而终止的 Intent 结算为 `not-evaluated`，不增加目标失败后验。
- `domain/history.ts`、`domain/event-index.ts`：绝对已提交历史 cursor、统一追加边界、事件流查询与选择性冷事实租约。热窗原地裁剪后会立即释放旧 hot index 的事件强引用，但真实接线仍须先由持久化层原子证明 CAS 并安装所有新转冷 lease。
- `domain/personality.ts`：创世人物把档案编译出的有界中心与种子差异混合；后代仍只走父母 baseline 继承。模块同时维护 HEXACO 有效值、行动证据与月末慢速变化；人格只调节已有合法候选、记忆注意或真实共同经历的转化效率。新生儿会按本人的有效宜人性与外向性取得 `3..9` 的弱初始信任值，但只由出生过程把它单向应用到出生时真实同地的人；后续共同活动按每个人的有效外向性与宜人性采用 `3..5` 刻度门槛，年轻人只在已有基础增量的月份获得额外信任，不凭人格或年龄直接创造关系对象。
- `domain/person-soul.ts`：从人物 ID、baseline HEXACO、控制 / 地位敏感度和创世档案的三个合成反应范式确定性重建只读 Soul v3；每个范式带一条短小合成 `exampleLine`，不是原作台词、能力或历史。另从有来源人格变化与当前召回记忆派生 `person-experience-layer-v1`；三条模型路径在输出前用 `character-turn-note-v1` 只激活一个 facet / reaction / example 和至多两个经历 cue，完整 Soul 不再常驻发送。所有层都不写入人物状态，不创造记忆、知识、动机、候选或世界事实。

### application/ —— 用例

- `infrastructure-api.ts`：只向持久化、会话与模型适配器暴露少量应用能力；产品与 UI 继续走 `simulation.ts`。`server/**` 不得深导入 `application/**` 实现路径，领域 codec / observer adapter 仍可读取稳定领域语义。
- `application/simulation/state-lifecycle.ts`、`controller.ts`：分别负责创世 / schema 恢复 / 报告和有状态控制器；application 只依赖自己声明的 `ObservationProjector` 输出端口，由外层 composition root 注入 projection adapter，不再运行时导入 `projection/`。投影器只收到递归只读、拆分 authority / previous observations 的快照并返回 observation patch；生产 adapter 在创建任何可写兼容模型前先取得 owned deep clone，普通结构镜像更新则走不构建完整聚合的窄路径。只有 `observation-state.ts` 的提交边界可以应用 patch，延迟物化也必须显式返回 `deferred`。`month-boundary.ts` 固定一次推进的 `atMonth = elapsedMonths + 1` 并编排月初、月末与生命周期结算；`tick-planner.ts`、`tick-executor.ts` 固定执行每月 15 个规划刻度；`intent-execution.ts` 承接意图生命周期与原子执行，并把 Action 执行结果与 Intent `goalOutcome` 分开结算：未受孕仍是 completed 动作但妊娠目标为 attempted-unmet，无真实受孕样本的提前阻塞是 not-evaluated，`attempt:*` 有界试验只按 ActionFact 评价 response，不把不存在的合成知识标成目标失败。父母在显式照护中成功携带未成年子女后，孩子原有的普通空间意图因起点被被动改变而以 `not-evaluated` 结束；这不是年龄或行动禁令，孩子下一次仍会按新位置重新规划。项目确认真实外部世界等待时，当前 episode 以 `suspended + waitingFor=world-change` 让出焦点且不写失败记忆，月内仍最多获得一次额外普通 deliberation；Project 后来完成、阻塞或放弃时，所有同项目的停泊 episode 按 exact completion / failure 来源结算，不再作为可恢复意图永久滞留，仍活动 Project 的等待保持不变。同一自然月内，仍未满足的保护性 child episode 会继续已经推进的普通移动目标，直到目标达成、动作失败、出现直接身体后果、新取水路线或可见野兽；学习期孩子短暂抵达精确照护者并恢复根食水 / 健康 Intent 后，会先让该根行动取得一次真实后果，再决定是否再次会合。这是 episode 连续性，不是冷却或切换次数限制。新意图用 `intent-lifecycle-v1` 区分默认的达成即结算、有界复核与显式状态维护；只有旧存档继续沿用 `stateGoalUntilMonth` 的兼容维护语义。项目、记录使用、已有返回链与带生命周期期限的意图可作为父意图；正式 required response、履约与保护性短任务通过 `suspend → child → resume` 返回同一意图 ID，规则、模型校验和玩家入口共享同一判定；普通生活回应仍是自主候选。根意图真实终结后每人每月最多获得一次额外普通 deliberation，`idle` 也消费；正式回应边沿不挤占普通额度。`model-review.ts` 管理模型复核与额度；模型路由拥有可选沟通时，月初和后续 tick 共用过滤该类候选的本地回退，仍完整保留生存、义务、生产与物理行动。模型模式在月初及真实沟通、观察、试验、失败后的下一 tick 前形成有界 MentalAct，每人每月最多两次并按 tick 批量请求；沟通子 Intent 完成后立即恢复父 Intent，同 tick 可继续兼容的移动、取得、制作或观察，狩猎、生殖与休眠转换仍互斥。候选、重编译、年龄门禁、协议生命周期与事件 ID 全程使用同一月份；只读查询仍读取最近已提交月，文明创世是显式的零月例外。
- `application/simulation/month-execution.ts`：普通月度快进与有限化身共用的暂存月生命周期。它把月初准备、逐个完整 planning tick 和月末结算拆成可组合边界；一个 tick 仍让稳定顺序中的全部人物行动，受控人物入口位于休眠、恢复、生存、照护和必要避护之后。异步模型路径可在 tick 边界应用新的 Decision；语言和身体后果分别写 ActionFact，但兼容动作可共享同一 actionTick。有限化身逐命令调用同一执行器，提前交还时本地跑完剩余刻度，二者都只在 `finishMonthExecution` 后提交一次。
- `application/player-embodiment.ts`：从受控人物当前身体、局部感知、相邻可站立格、真实 `DecisionContext`、Intent 与 Project 投影稳定 `optionId + choiceKey`；提供等待、继续意图、单条相邻边移动和现有建造 / 交互候选。命令在人物轮次重新编译并解析为 `TickActorControl`，最终仍由普通领域执行器校验材料、路径、场址、权限和动作后果。
- `application/player-embodiment-month.ts`：拥有有限化身月份的暂存复制、外部天象、月初准备、NPC 本地决策冻结与回放装配；服务端只通过 `simulation-runtime.ts` 的公共门面调用，不直接拼接月份内部模块或具体观察器。
- `application/rule-planner.ts`：模型缺席或失败时使用的保守策略，按生存反射、必须回应 / 履约、当前意图持续、自由选择四段工作；合法性在评分前处理，自由选择使用可解释的加法偏好，不再用长乘法门链。
- `application/model-decision/mental-act-context.ts`：把旧持久化结构投影为简洁的 `PersonMind + current + visible + availableSteps`；模型看不到本地候选分数，也不直接输出 `optionId`。
- `application/character-agenda.ts`：只把 decision 中显式的模型 `characterAgendaUpdate` / proposal 编译成新的长期关切；本地选择、Project 与多月 Intent 不再自动创建 agenda，只能绑定已存在的 item 并继续各自客观生命周期。当前没有玩家直接 agenda 写入入口，旧存档中的 `local-deliberation` item 继续兼容。更新支持 `create / revise / pause / abandon`，可随 `start / revise / idle` 返回；新 item 只有 Project、记录使用、丧葬或明确多月工作的合法 option 才能直接绑定 executable approach，一次性行动不能被包装成长程目标；绑定合法 option 时持久化方法必须使用该 option 的本地摘要，模型自由策略仍只属于 MentalAct。`create / revise` 暂无匹配合法 option 或 probe 时保留为 `missing-affordance / incubating`，不创建 Intent。probe 只允许 `observe / combine / expose / exert`，并重新验证本人持有的栈、当前可见对象 / 体素与 agenda / project 关联；无效引用不得借无关合法动作洗白。关联 Intent 的真实 `ActionFact` / goalOutcome 才能评价方法；无 probe 的 durable model approach 在客观 goal achieved 后把 agenda 结为 fulfilled，probe 只评价方法。无 ActionFact 终止与真实 world-change wait 都会 park，过期且无 executable episode 的 aim 会 suspended，让出容量但不伪造遗忘。
- `application/hibernation-rescue-options.ts`：从当前可见、可安全唤醒的休眠者和有来源预言 / 身体事实形成持续照护项目；同一 `休眠者 + condition + era sequence` 只形成一个项目，后续见证者加入为贡献者，不按 helper 复制项目。项目冻结最后确认位置，依次编译近身、取得或制作容器、前往本人可见或记得且仍真实可达的水源、装水、返回、补水与必要食物交付。没有实体容器、真实水体素或可达路径时保持可解释阻塞，不把长期关切文本当成已经执行的救援。
- `application/player-interaction-choice.ts`：把人物在主动建议对话中选中的当月合法方向编译为稳定语义键，并在最新上下文中本地重配；临时月份 / 表达 ID 变化不造成假失败，正式 required response、履约和 follow-up 仍由同一门禁约束。
- `application/cognition/need-agenda.ts`、`family-readiness.ts`、`option-appraisal.ts`、`bdi-deliberation.ts`：从局部 `DecisionContext` 和仍开放的长期关切派生动态需要，其中食物储备与饮水储备是两个带资源维度的独立缺口，身体稳态再精确区分健康、营养与水分；候选只能缓解同资源储备或对应身体压力，取得型候选还必须确认本人没有对应可摄入库存。项目来源的 need 精确绑定 `projectId`，社会自主 need 精确绑定具体 agreement / person，普通采食和无关关系不能冒领。普通正向生殖发起的 `needActivation` 只接受 `generativity`；`belonging` 与无关 `autonomy` 不能凭空激活正向选项。若本人已经形成与同一对象、同一关系主题的意图，对方先提出相同结果，则接受回应也承接这项具体自主选择；拒绝仍保留并可在身体、关系或家庭准备事实改变时胜出。撤回是普通可选决定，只由相对本人同意时的新准备度下降、新增子女责任、严重身体状态或对象一致恐惧形成动机；拒绝 / 撤回表达本身不缓解 belonging。家庭准备度只读本人当前可感知的食物、水、真实可达且有当前可见空余位置的住所、照护余量与气候安全，住所质量每次从 `weatherProtection / thermalInsulation` 重验；记忆中的远处住所对 shelter 分量贡献为 0。动作后验供预计努力与伤害，`goalOutcome` Beta 后验决定目标成功预期。`CharacterAgenda` 只保存 aim 与 approach；唯一当前 `Intent` 仍实现执行、持续、切换与急性中断，项目 / HTN 负责步骤展开，领域执行器负责硬合法性。
- `application/cognition/bounded-foresight.ts`、`foresight-deliberation.ts`：在廉价 appraisal 后只比较最多 4 个根、每节点 2 个后继、深度 3、一次人物决策 24 节点的本人主观后果；选择与 `applyDecision` 审计复用同一次 deliberation，required / commitment 与 follow-up 不另开前向树。无真实两难、无替代项或观察不改变下一选择时 VoI 为 0。前向调整和信息调整分别封顶 0.08 / 0.04，不能改写硬义务优先级或用无关想象越过急性生存需要；审计写入 `DecisionFact`。
- `application/cognition/social-expectation.ts`：从 typed cooperation context 读取 person-local 回应 / 意愿 / 可靠性后验；同情境多人候选保留后验最高两名并稳定轮换一名探索对象，required / commitment / withdrawal / reproduction 绕过。该值只是 `[0.82, 1.18]` 的软门控，不替代协议合法性。
- `application/reproductive-risk.ts`：把人物持有的近亲风险知识置信度连续映射为本地生殖选择成本；满置信度成本仍是可被关系与生活压力权衡的软偏好，不承担动作合法性。
- `application/age-planning.ts`：按生命周期过滤简单劳动、项目发起、社会协议与繁衍候选。
- 定居耕作的 world-change wait 只接受尚未成熟的幼苗；成熟作物必须进入收获或正常复核，不能让失去执行意图的旧项目永久保持 active。
- `application/project-pressure.ts`、`application/project-options.ts`：前者从本人及其局部可见事实形成项目压力，后者保留项目公共 API 门面。住所扩容会比较完整可见范围内的存活人物与真实可通行住所位置；局部容量不足时即使天气温和也可形成压力，一处容量已满的住所不再压制露宿者立项，局部重叠施工仍复用同一项目。项目完工只给交付最后功能性动作的人物记录 `NeedResolutionEpisode`；它在 12 个月内对同 `need + desiredFunction` 的新提案压力最多降低 45%，只表示本人近期观察到需要被缓解，绝不补造库存或住所，也不能单独重开已被拒绝的生殖配对。`application/projects/` 按生命周期、提案、局部感知 / 场地、材料计划、假说调查、物流搜索、步骤编译和完成证据拆分；这些模块共同编译项目行动，不复制领域规则。定居耕作没有附近人口硬门槛，固定在局部地块；缺种走真实种源，等待生长不猜配方，完成只读取本项目场址内的播种与收获历史。已有可种地不足六格时，人物可用本人真实持有的田间工具依次尝试草地、裸土或夯土；草地先变成裸土，裸土或夯土再变成可播种地，每种工具与目标的成功或无响应都单独学习。局部重叠项目在候选阶段复用、提交边界再校验；若同刻度另一个人物已创建等价项目，则合并受益者与触发事实并把意图重绑到权威项目。非所有者只在创建当月有界等待已有步骤，远处项目仍可并行。同一 need 的不同功能提案在接受前取得带 `desiredFunction` 的独立 ID；若全新机械安装计划仍指向旧粗粒度提案，计划 `projectId` 会随最终 ID 重绑并重算 plan key / network ID，而维护或可靠性项目继续引用原安装计划与原网络。材料协作只为固定场地的合金、铁器与明确公共厅堂项目开放；铁匠铺可由已观察到的青铜能力与烧结砖提出，后续铁料、还原、锻打和工具阶段必须返回真实 Smithy，并以逐段原料缺口、请求与真实交付接续。历史搜索只有与当前缺口完全一致且晚于最近进展，同时不存在协作、休眠、当月落地或作物生长等待时，才会进入耗尽候选；即使搜索或实体假说已经耗尽，也必须等到有效复核期限，并距最后真实进展或本次精确搜索 / 假说关闭至少 4 个月，才能把项目结为阻塞。等待期保留精确缺口、预约和同一项目身份，不重开相同 search campaign；期限前出现精确新来源时，原项目直接恢复普通物流与生产。终局失败后人物仍会把当时机会依据跨项目继承；同一 owner + desiredFunction 只有看见精确的新材料来源、取得与功能相关的可靠计划、发现新目标环境或新 verified response 才能重开，项目 ID、月份、压力、移动和相同来源改名都不算新机会。后继项目首步必须实际使用所声明 renewal；从未发生搜索 / 假说失败的普通 construction 提案保持原行为。材料能力另区分 `observed`、本人可合法取得的 `accessible portable` 与已经放入世界的 `placed facility`；旁人背包只能证明看见，不能证明本人已有工具或世界已有设施，可见但没有实体站立路径的掉落物也不能冒充可取得能力。生产工具按木 / 骨、石器、石锄、青铜、铁的真实效用等级比较；低级工具只部分缓解劳动压力，不能一票否决升级项目。`efficient-production`、`bronze-tooling` 与 `iron-tooling` 只有在项目来源的更优工具仍由 owner 持有、且对应制作技艺已通过源绑定复验达到可靠阈值后才完成。其他便携产物项目仍要求 owner 当前目标材料栈的来源事实与本项目 `actionEventIds` 相交，跨项目复用的旧产物与可靠技术不会被伪写成本项目完成证据。耐久记录优先回应作者本人实际听到、仍开放的项目知识请求：作者必须可靠掌握与请求产物精确匹配的技术，并且已超出与请求者的近距口授范围；候选仍只读作者亲历的请求事实和可靠知识。项目随后在固定场地写入空白载体；一旦所有者背包存在与本项目所有者、目标知识和写入事实精确匹配的已写载体，返回场地并投放到精确地面优先于仍活跃的旧搜索 / 物流，投放后沿既有 `project-completed` 收口。没有合格已写载体时，仍按原制造与物流顺序推进。
- 住所空位优先：本人暂时站在室外不等于缺房。完整可见、可达且未被可见人物占用的内部位置，或本人有来源记得且仍可到达的住所，会先提供入住所行动；恶劣天气只有在局部容量确实短缺或没有已知可达空位时才支持新住所项目。
- `application/projects/project-step-compiler.ts`：保留项目步骤公共门面；`project-material-requirement.ts` 从本人已知过程、可见成品和精确项目功能求解当前材料需求，`project-material-provenance.ts` 则要求精确 BOM 能追溯到本人可靠技术 / 记录或本人真实完成的配方事实，不能仅凭 activeProject / desiredFunction 写入 `missingMaterialIds`；有 provenance 的已知技术与实体项目仍沿用精确需求。`steps/construction.ts`、`cultivation.ts`、`care.ts` 与 `known-material-production.ts` 分别承接遮蔽构筑、定居耕作、治疗和共享已知物质生产步骤，避免总编译器继续按功能横向膨胀。质量比较缺少仪器时只提出“两个相同结构件 + 柔性悬挂件”的对称装置问题；已有仪器后只提出“稳定参考物 + 可见标记”的参考物问题。`project-material-questions.ts` 的类型只容纳可感知角色 / 性质，不能表达 material ID、rule ID 或预期产物；`project-hypotheses.ts` 按必需角色、人物本人对精确输入 / 工具的经验、同一试验的 response / no-response、信息相关性和可选性质排列有限试验，不再读取项目目标材料或施加正确答案加分。已核验产物只改善该实体的感知 profile；只有 operation、question、candidate 与当前有形来源组合都相同的真实 response 才能成为 learned evidence，不能把一个产物的成功复制给其他未试组合。campaign 的候选 / 尝试 / 关闭预算为 7 / 4 / 3；已经取得的仪器、参考物和已写载体不会被当作普通耗材。
- `application/projects/project-inquiry.ts`、`project-proposals.ts`：项目假说 campaign 是负责人本人对未知物质的主观尝试，只有当前负责人可选择其中的候选；贡献者仍可按明确请求交付材料、演示或使用自己已经掌握的可靠技术，但不会借用负责人未验证的个人猜想。人物已可靠掌握精确 `expose` 技术时，烧砖、炼铜和炼锡项目优先锚定与该技术所需热源一致且真实可达的设施；只有技术未知时才退回一般高温场址开展有界假说，避免项目场址与本人会反复使用的已知陶窑 / 铸造作坊互相拉扯。
- `application/action-options.ts`、`reproduction-options.ts`、`mortuary-options.ts`、`construction-options.ts`、`container-options.ts`、`separation-options.ts`、`social-options.ts`：各类合法可供性候选的生成；总门面只组合、去重、规划和排序，生殖协议 / 回应 / 撤回 / 尝试候选由独立 producer 承接且不能反向依赖总门面。普通生殖提议要求提议者对该对象有 `trust>=20 && bond>=20`、关系证据覆盖至少两个自然月，并含直接照护 / 亲密回应、履约、共同养育或明确支持证据；`founding`、预测、无关环境和只有低压力闲聊的来源不足。身体适格的回应者同时获得接受与拒绝，不要求其反向分数也达到 20 / 20；活跃协议同时提供继续与撤回，再由当事人依据本人关系、恐惧、人格、责任和已知风险选择。短期 company 请求也至少需要一条排除 founding 的真实双方关系事件。死亡照料从人物本人已知的具体死亡出发，依次编译悼念、搬运遗体、选择可达墓址、挖墓、入葬、使用同一掘土来源覆土，以及在拥有空白木板和合格工具时立墓记；遗物保持带死亡来源和原主人身份的普通实体栈。本人近期真实完成过分离生产劳动时，可达的更高级地面工具会以劳动节省形成明确取得候选；他人背包仍不可直接读取或拿取，只能在同格、持有者交易后仍保留不低于原最高生产能力的工具、请求者也有实体余量可交付时走既有自愿交换。工具取得意图固定精确 drop，移动后的木材、灌木、成熟作物与捕猎重编译会重新选择本人当前效用最高的适用工具，不会退回徒手或较弱武器。通用有形库存候选、自然假说、已知配方与项目子装配的消耗选择都会排除已带 `recordPayloadId` 的载体，避免规划器反复生成必被领域层拒绝的普通加工。固体放置的候选与领域执行器复用同一体素结合产物规则；无论放置是眼前 `nextAction` 还是移动后的 `completionAction`，目标空气体素当前被身体占据时都暂不生成整条可供性。项目只暴露一个当前原子步骤时，移动 / 物流结束后才重编译出的占位放置会保持 active 等待，不写失败事实；身体离开后下一 tick 恢复，提交时仍会重验。项目、记录使用与生活复核的嵌套 planning preview 继承外层当月 overlay，避免候选动作与提交前重编译因证据视图不同而分叉。失败重试与占位放置冷却由 `application/action-failure-retry.ts` 统一判定：它按动作、目标、数量、人物、项目、记录和关系组成稳定结构 basis；新状态从 terminal Intent 引用的真实 blocked / failed `ActionFact` 读取实际失败动作，自传 failure memory 只作旧状态和无动作失败的 0–6 月兼容；失败当月，完全相同的实际动作不会因换 goal / project 被第二次普通复议原样提交，跨月后再按完整 basis 与新来源判断；第 7 月恢复，正式必须回应与履约绕过冷却，无法还原结构 basis 的旧自由文本失败记忆不拦候选。
- `application/conversation-options.ts`：有来源生活对话的 opening / response 都是 optional conversation edge，response 只有仍在语音范围内才可选，不会过滤其他普通候选。opening 的有界 listener pool 按可解析处境、语音距离、共享项目、双方关系来源、亲近度与空间距离排序；同档对象按 `speakerId + atMonth` 在稳定 personId 序列中轮换，输入数组顺序不造成偏置，也不会形成固定三人。完整本地规划仍使用 failure / discovery / everyday 等真实来源菜单；模型请求隐藏这些预选 opening，并为 pool 中处于语音范围、且说话者持有可解析关系来源的每名听者最多编译一个 `topic=open` affordance。它收集本人记忆、知识与对该听者的关系来源，模型选择后才把 0～3 条来源重新绑定到动作；无关系 fallback 的陌生人不生成这个 open option。共同抵达只支持相识与 everyday；只有具体共同动作或已履行约定才支持 reminiscence，规则不预造 playful 小插曲或回应态度。正式提议的 accept / reject 仍由各自协议 producer 作为 required response 处理。
- 开放交谈的新鲜度：同一人物对仍记得的旧 `open` 来源不会再次暴露给模型，上一轮 opening / response ActionFact 也不能自我喂回成为新话题；提交前按最新记忆重验。最终台词返回 `continue` 时只在回合与时限内续接原 ConversationEpisode，`close / rupture` 才收束；已发生的沟通事实不被模型改写。
- `application/record-use-options.ts`：只为读者本人拥有的活跃项目及其真实技术缺口生成记录使用候选；来源限于本人背包与调用方已过滤的可见公共地面掉落物，不读取他人背包、知识或意图。V3 basis 冻结读者、项目、payload、技术和精确载体来源，但不提前冻结实验动作或输入栈；地面来源正常按 `move → acquire → read → prepare-experiment → experiment` 推进，其中移动不算取得，只有从精确掉落物成功转移到本人背包才算 `acquire`，来源消失或替换时不会另换载体。记录技术必须能以临时可靠知识编译为该项目的精确步骤，但阅读前不要求实验输入已齐备。阅读仍只形成不高于 54 的暂定技术知识；准备阶段每 tick 走普通项目物流，输入到位后才执行真实实验。现代观察只要求实验前低于 55、实验后达到至少 55 且确实上升；明确直接教学仍可到 60，但不会伪装成完整记录链。
- `application/mechanical-power-options.ts`：只让做过真实 Mill 辅助谷物分离劳动的人物关注本人当前可见、可达的水流段；成功 `attend` 后形成只属于本人的有来源观察。由此提出的项目只是冻结水流源与可见工地几何的试建假说，不泄漏隐藏配方、时代标签或观察器目标；未知部件仍走有预算的材料假说与验证。
- `application/electrical-power-options.ts`、`electrical-power-service-options.ts`、`electrical-power-maintenance-options.ts`：从人物亲历的机械服务、局部材料、已掌握操作和当前故障形成有限电网试建、带载使用与维护候选；网络、部件、位置、来源事实和替换件都需现场复验，不泄漏现代阶段门槛。
- `application/agreement-continuation.ts`：已接受协议的履约推进。水源帮助在接受前要求存在 helper 知道且双方都可达的同一岸边；helper 的到达或一次真实水源核验以 `agreement-contribution-recorded` 结束自己的贡献，requester 仍须沿同一路线真实饮水，不能把每个 planning tick 的重复观察累计成帮助。主动协助类协议的 helper 进入休眠时，履约期限按实际休眠月暂停；恢复后把同样月数加回期限，不能把不可行动期伪记成违约，也不能借暂停无限延长其他协议。

机械动力项目在同一冻结计划内新建 load、connector 与 converter：`WaterWheel` 位于冻结水流端点正上方，水平 `DriveShaft` 把它连接到新 `Mill`。部件安装严格复核计划、来源身份、网络、位置、拓扑及本人制造 / 核验来源，但不要求安装瞬间仍有活水；commissioning 与所有 operate 动作仍必须现场确认真实水流。首次完整试运转确定性暴露 `commissioning-misalignment`：动作以 `progressed` 保持持续意图，Seed 输入数量不变，轴成为 `BrokenDriveShaft`；此后必须制造并验证故障后产生的新 `DriveShaft`，再用 `BronzeTool` 维修。只有维修后的真实 `Seed → Food` 动力作业及其输入来源成立，安装项目才可完成。完成网络在本人局部可见、绑定水流仍有效、拓扑仍完整、本人持有真实 Seed 且可靠掌握操作时继续提供负载作业；只有成功负载才累计 condition 磨损。降到阈值后的下一次负载会在投入前产生实体 `worn-drive-shaft` 与 `BrokenDriveShaft`，不吞 Seed；人物必须近身检查形成个人诊断，才能提出独立维护项目，并用故障后制造、核验的新轴修理，最后再次带载运行才证明恢复。成功操作者可复用既有明确教导规则，把有作业来源的操作知识传给相邻语音范围内达到学习年龄的人；未学习者不能因看见网络而直接操作。临时失流会留下计划绑定的不可用事实并让同一项目等待；水流恢复后原项目重新编译 commissioning / operate，而不是因越过复核月永久终止。错水流源、错计划、错工地或拓扑变化仍在扣减输入前拒绝。这条链只证明持续机械传动、使用磨损、诊断维修与第二操作者传播，不证明电力、通信或计算。电力必须由独立的发电机—导体—负载拓扑产生。

电力、度量与记录复用仍由各自项目和物质规则产生真实事实，但不再组合成现代阶段观察，也不再进入前端成就卡或后端冷历史专用见证。水轮、金属传动轴、天平、标准秤砣、小型发电机与负载的制造、安装和使用规则保持不变；这些能力只作为世界中真实存在的高级实践，不影响人物目标或文明阶段。

可选社交发起不会再因为过去两个月出现过相似选项而从候选集中消失。人物记得自己曾向同一受众谈过同一主题、当前又没有新事实时，`social-repetition` 会降低排序；未回应、拒绝、保留或违约会进一步降低预期，新的可追溯事实，或与求助、照护、困境主题直接相关且显著恶化的生存压力，则可支持重新开口。同一人物对、同一需要的求助在 proposed / active 或本自然月已经回应时只是一项语义事件，不能换一个 Intent 在同月重复说；下一月若危险继续恶化仍可重新请求，没有额外冷却。协议 ID 幂等与一次正式回应仍是领域硬门禁；同一生活对话 basis 的去重只跟随双方当前仍持有的关系、旧记忆或 Agent dialogue basis，不因冷历史中曾经说过就永久封禁。

### projection/ —— 只读观察

- `projection/capability-milestones.ts`：v2 纯可回放因果观察器；含精确地图坐标和 world-specific 复杂事件，并以 strict/guarded、阶段门槛和完整 episode 隔离误报。死亡照料能力只在真实死亡、完整安葬和物质墓记来源闭合后出现；任何观察结果都不反向进入人物决策。
- `projection/derived-observations.ts`：从已提交权威状态与显式传入的物理结构索引派生 practices、institutions、regions、milestones 与 development 观察结果；`simulation-observation-projector.ts` 是 `ObservationProjector` 的外层适配器，只在脱离聚合根的读取壳上运行并返回 patch。当前 `cultivated` region 只表示仍存在的作物 / 幼苗 / 贫瘠地，服务物理疆域和容量。阶段观察器 v7 另从同一已完成定居耕作项目的 6 个不同播种格与 2 次成熟收获重验既成能力，并独立核验现代电力、度量和记录复用事实包。这些字段都只写观察投影，不参与候选或人物选择。
- `projection/player-narrative.ts`：从已提交事件筛选文明开端、纪元切换、重要天气、野兽袭击、死亡、出生、协议、关键技术和项目完成，并保留来源事件、涉及人物与可展开详情。动物死因必须由死亡来源链中的同对象袭击证明；同月袭击被死亡吸收后不会重复列史。
- `projection/live-speech.ts`：把每个已完成且具有可解析真实听者的口头沟通 ActionFact 投影为无显示文本的结构化 `speechAct` 草稿。普通 response 从 `conversation.referenceEventId` 建立 `replyToSourceEventId + requiresParentSpeech` 内部依赖；只有精确父 opening 已持久化为合法 SpeechLine，response 才进入模型请求。decision `utterance` 只是准备表达的意思；所有最终可见台词都经 Voice Contract 批次生成 `dialogueMove / disposition`，response 另保存 `replyToSpeechLineId`。合法 SpeechLine 作为原话写入双方 dialogue memory，但不反写动作事实、知识或关系。
- `projection/speech-history.ts`：只接受与 completed voice ActionFact 精确绑定、来源和参与者均可复验的模型 SpeechLine；同一 sourceEventId 的原话可显示在文明纪事与人物行动历史中。没有合法原话时只保留间接沟通摘要，不把规则 summary 冒充引号台词。
- `projection/society-world-cache.ts`：只读 WeakMap 投影缓存；复用静态 palette / biome，无体素变化时复用世界几何，有变化时仅复制并重算受影响列。

`server/evolution-artifacts.ts` 保留演化路径、检查点与事实报告的公共门面；假说活动审计、技术学习和 inquiry-opportunity 来源 / 更新审计分别集中在 `server/evolution-artifacts/hypothesis-metrics.ts`、`technique-learning-metrics.ts`与 `inquiry-opportunity-metrics.ts`，报告门面只组合稳定指标。记录使用仍保留原始阶段计数与独立违规项，但只有同时通过读者 / 项目 / payload / codebook、精确取得来源、阅读理解、实验产物、置信度从低于 55 上升到至少 55、动作顺序和项目进度守卫的 basis 才计入 `completeRecordUseChains`；普通移动和无记录语义的复合对话动作不会冒充记录阶段。

### server/ —— 接口与实时会话

- `server/main.ts`：只负责依赖组装、通用 HTTP 边界和启动关闭；`run-api.ts`、演进执行器与叙事增强分别依赖 `RunAccessStore`、`EvolutionExecutionStore`、`NarrativeEnhancementStore` 端口，不直接依赖 SQLite；Worker launcher 也只在这里注入。JSON 请求体默认上限 50 MiB，可用 `ELAND_MAX_HTTP_BODY_MIB` 在 1..512 MiB 内显式调整，供大型可迁移状态导入，不改变 SQLite 权威边界。`run-evolution-service.ts` 承接每个 run 的串行推进、12 月检查点与报告提交，`model-api.ts` 承接模型决策与设置接口。
- `server/model-decision-gateway.ts`：Mental Act v1 适配器。模型只读取 `PersonMind + current + visible + availableSteps`，输出目标、策略、假说、预期观察和可选 `firstStepHandle`；网关把句柄还原为兼容 `Decision`，application 再按最新局部事实重验。没有当前步骤的 pursue / investigate 会先形成 concern；JSON、越界句柄等协议错误可重试但不进入人物历史，材料机理、远处障碍、设施效果和他人选择必须经真实行动后才反馈。模型调用前不再预先计算本地选择，失败时才启用保守回退。`MODEL_CHARACTER_AGENDA_MODE=off` 仍可关闭 concern 更新。
- `server/sqlite-run-store.ts`：唯一拥有 run / checkpoint 的 SQLite 事务、revision + state hash CAS、批量检查点裁剪与不可达状态块回收。演化路径、事实报告和叙事增强的内容块读写由同数据库上的 `sqlite-run-output-artifact-store.ts` 承接，主 store 只保留同名委托 API。
- `server/run-state-codec.ts`：按 schema 3 分段编码 shell 与完整事件历史，校验内容寻址的节点链并恢复完整 `SimulationState`；旧 `v8-br-v1` 与旧 shell codec 只保留读取兼容。
- `server/elandSession.ts`：保留实时会话公共门面与兼容导出。`server/eland-session/session-step.ts` 编排 begin / step、幂等并发、权威月份、sky / cosmos 原子提交与模型回退；每月开始前一次性捕获当前分支已提交的 SpeechLine，供决策与 speech-only 精确回复链复用，本月新台词不会泄漏回自己的决定。空闲时会话与 controller 共享唯一已提交 `SimulationState`，异步模型月份只在隔离工作副本中推进，成功后再原子提交。`server/authoritative-cosmos.ts` 从已提交 `CosmosSnapshot` 确定性推进下一月天象；`server/live-observer-runner.ts` 只在存在有效在线观察租约时调度月份，最后一个观察者离线后最多完成当前原子月便暂停并保存。`timeline.ts` 负责 checkpoint / delta / seek / fork，恢复时历史块保留为 SQLite hash 引用，回放只按需读取最近年度 checkpoint 与其后 delta；`recovery.ts` 负责恢复校验；`frame-history-projector.ts`、`conversation-coordinator.ts` 分别负责帧历史与对话结果投影；`session-manager.ts` 负责 lease、TTL、LRU 与 SQLite 会话协调。实时分支真正提交到 12 的倍数月份时自动持久化，新时间线 Buffer 成功落盘后即替换为 hash 引用。
- `server/eland-session/embodiment-coordinator.ts`：在 committed authority 之外持有一个可恢复、可确定性重放的暂存月份，编排 begin / step / release、命令幂等与修订冲突。自由观察只读取 `EmbodimentView`；每个 step 执行完整世界 tick，走完第 15 刻或 release 本地补完剩余刻度后才通过会话原子提交一个月。
- `server/newborn-naming-service.ts`：在实时模型月份的出生事实对外提交前，按父母 Soul、有源近期经历和当前处境批量请求 `givenName`；本地验收后记录模型来源，失败保持确定性保底姓名，回放不再请求。

### scripts/ —— Agent 调试与实验入口

- `scripts/eland.mjs`：现有 HTTP API 的零新增依赖 CLI 适配器。`run` 管理后台持久化演化，`session` 管理逐月实时会话，两者保持不同的身份与并发语义；`inspect` 只从权威状态提取人物、项目、事件和文明摘要，不写回观察结果。
- `scripts/test-core.mjs`：默认 `npm test` 的精简工程门禁，依次运行架构边界、主模拟回归与共同生活回归；仓库只保留产品级契约与关键恢复测试，历史实验和一次性审计脚本不再留在主树。
- `scripts/check-eland-boundaries.mjs`：基于 TypeScript AST 检查 domain / world / application / projection 的运行时依赖方向、内核对 React / Three / HTTP 的渗透以及运行时强连通循环；同时禁止决策消费代码读取观察字段或用 `SimulationState` 断言绕过 authority，禁止生产观察 adapter 把共享 snapshot 断言回可写状态，扫描全部 server 源文件以阻止 `application/**` 深导入，并把 server 内部相对运行时依赖建图后检查跨文件 SCC / self-cycle；另保护 HTTP / Worker / codec / SQLite publisher 的端口，并阻止已抽出的领域、体素与人物 / 装饰 / 环境 / 相机层反向依赖其门面。既有项目不依赖文件名约定来获得这项观察字段保护，只有显式 observation boundary 在允许清单内；从 `three-body/` 运行 `npm run test:architecture`。
- CLI 写操作仍经过 HTTP 层、应用用例和持久化事务。脚本不直接打开 SQLite 写连接，不复制领域规则；完整命令与退出码见 [`../../../../docs/agent-cli-v1.md`](../../../../docs/agent-cli-v1.md)。

### 根级

- `character-profiles.ts`、`founder-persona.ts`：人物档案池及创世人格编译器；档案摘要通过通用语义信号形成 HEXACO / motive prior 与三个反应范式，开局再与种子差异混合。每局确定性抽取 5–12 位，或由配置指定最多 12 位；后代不读取原型档案。
- `population.ts`：开局年龄与寿命的确定性采样。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影；事件活动按追加游标增量累计，实体查找在每次投影中建立 Map，缓存不写回领域状态。
- `application/model-decision/`：通用模型决策的只读上下文边界。`decision-context.ts` 从权威状态投影完整 DTO，`recent-dialogue.ts` 只核验本人说过或听见的已提交原话，`capability-handles.ts` 建立单次请求的匿名能力句柄，`compact-context.ts` 对候选和上下文做有损裁剪。它们不绑定模型供应商，也不拥有 Intent 或世界事实；人物档案、有效人格、身体、有向关系、有源近期经历、长期关切和对话只能经这条单向投影进入服务端模型协议。
- `month-playback-buffer.ts`：保留基础动画与逐句台词的可读播放预算计算；观察页不再从浏览器发送逐月推进命令，服务端按在线观察租约和该预算控制提交节奏。
- `simulation.ts`：供其他层依赖的稳定公共门面。
- `simulation-runtime.ts`：外层 composition root，把 application 声明的观察端口连接到 projection adapter；兼容门面只转发，不把具体观察器重新引入应用层。
- `voxelKits.ts`：保留从真实物质 / 建筑事实到微体素外观的稳定门面；`voxel-assets/catalog.ts` 读取同一份可校验 catalog，`surface-decoration.ts` 只承接地表 underlay 与道路拓扑装饰，`decor-primitives.ts` 统一微体素 bucket 和稳定抖动原语。文明指数卡仍是只读阶段象征；现代代表卡的发电机、导体、负载、度量衡和记录架只作预览，不补造世界中尚未发生的事实。

`src/components/SocietyScene3D.tsx` 只编排场景、选择射线、后处理与各运行时层；`src/components/society-scene/cameraRuntime.ts` 独立拥有相机、轨道 / 沉浸控制器、入场 / fit 状态、键盘 / 滚轮 / 双指监听及其释放，不能反向依赖场景门面。`figureLayer.ts` 拥有人物实例的同步、回收、拾取代理与气泡布局；`speechPlayback.ts` 把已保存台词按 `planningTick` 和稳定插入顺序排列，为每句分配连续播放时段，同一进度只激活当前一句，不再截取最后三个人。`figureVisuals.ts` 只构建和释放单个人物视觉资源，`decorLayer.ts` 拥有 stable / settlement-era 实例批次、时代过渡、动物 / 火焰动画与资源回收。`environmentRuntime.ts` 通过相机更新前 / 后两个阶段管理天空、日照、云、流星与资源释放，天气粒子的资源和更新由 `weatherRuntime.ts` 承接；shader / 参数集中在 `environmentVisuals.ts`，地形和云只共享 `visualNoise.ts` 的稳定噪声。这些层都只读当前社会投影，不写回模拟状态。

`src/pages/ImmersiveGame.tsx` 只续期在线观察租约并轮询最新已提交帧，不再调用普通 `/step` 推进时间。服务端返回直接增量、跨月补丁或 authority 切换后的完整帧；前端始终接纳新的权威头，跨月缺口同时重同步纪事与文明指数。`SocietyScene3D` 继续在相邻权威投影之间播放人物、动物、环境与台词动画；页面隐藏、打开暂停式覆盖层、进入化身或关闭页面时释放活动租约，无观察者不会继续调度模型月份。

### 前端有限化身

- `src/pages/ImmersiveGame.tsx`：负责进入 / 逐刻命令 / 交还的体验状态机，始终以服务端 `EmbodimentView` 和已提交 `GameFrame` 为准，不在浏览器演算世界。
- `src/components/LimitedEmbodimentHud.tsx`：克制显示当月 15 刻、当前人物、准星、情境主操作 / 更多操作和交还自主；转头、查看目标与展开提示不消耗刻度，只有提交服务端选项才推进。
- `src/components/SocietyScene3D.tsx`、`src/components/society-scene/EmbodimentCameraController.ts`：把已投影人物锚点切换为第一人称镜头、Pointer Lock 和空间目标命中；WASD 只选择当前一条相邻移动候选，不能直接改写人物坐标或体素。

人物页主动对话由 `server/agent-interaction-gateway.ts` 调用 `interaction` 模型。玩家不需要区分普通对话与建议：服务端先从当前玩家原话保守判定 `actionChoiceRequested`。第一阶段 `agent-interaction-reply-v1` 只生成自然回复与来源审计；模型即使误带旧版 stance / choice 字段，也不会再让合法回复整体失败。纯问答不暴露其他人物尚待回应的 required choice，也不触发意图调用。只有门禁确认玩家明确提出行动请求后，才用独立的隐藏 prompt 从“玩家原话 + 已生成回复 + 当前合法候选”提取 `answer / consider / accept / decline`；解析失败静默保留回复，只有回复明确承诺且唯一匹配的 `accept + choice` 才进入行动链。服务端当场校验紧急生存、正式 required response、履约与 follow-up，并保存稳定语义键；下一次可行动月份只在最新候选中本地唯一重配，不再让模型重新决定。命中后才形成带 `sourceInteractionId` 的 DecisionFact / Intent；条件暂不允许时显示暂缓，候选消失或匹配不唯一时显示具体原因。人物卡继续读取真实 Intent 与 ActionFact，把后来定下、开始、被打断、做成或停下投影回原对话。

本地规则是服务端动作合法性、义务和后果权威，并在任何模型请求前编译完整合法候选。模型设置页（`M`）选择模型演进且真实配置 `decision` 路由后，可选 `talk` 的自愿表达与主观社会分叉由模型拥有；本地回退和后续 planning tick 都过滤这组候选，不用固定寒暄、教学、关系或治理提议替人物填空。急迫求水 / 求食仍可由规则发起，正式 required accept / reject、已接受承诺、履约、生存、生产和物理行动继续由本地处理。正式回应只在有两个以上合法 required option，或唯一 required option 带有两个以上语义匹配 follow-up 时交给模型；无选择空间时直接由规则提交。普通生活 opening / response 是 optional edge，即使只有一个方向也存在“做 / 不做”的模型选择，response 仍可与其他候选竞争并允许不回应。创世上下文可在普通有界容量内进入模型，生存危险和既定履约不进入；选择本地演进或未配置真实 endpoint 时恢复完整规则规划器，后台快速演化始终只走本地规则。模型只能在当前合法 option 中选择或 idle，领域层会重新验证完整 typed semantics、正式强制回应、复合对话的后续行动和意图组合；未知项目只投影感知 profile 与待试验问题，不发送精确 missing materials、material ID 或原始功能 tag，存在可审计计划 provenance 时才恢复精确需求。临时 option ID 只留在 DecisionFact 审计中，长期意图保存规则目标而不是模型文本。

实时月份中的说话先由规则提交为 completed `voice talk` ActionFact，并投影为只含沟通类型、话题、提议、引用、正式提议 stance 与来源的 `speech-act-v1` 草稿；规则不提供可显示原话，规则摘要也不充当隐藏原话或文本相似度锚。普通生活回应不携带规则预写的 supportive / listened / willing 态度。对不依赖精确父句的沟通，决策阶段已经给出且通过事实 / stance 校验的 `utterance` 在动作完成后直接原样复用，不为补 `dialogueMove / disposition` 再调用一次模型；其余 speech-only 请求才要求模型同时返回实际文本、会话 move 与 continue / close / rupture disposition。同月 opening → response 由 `conversation.referenceEventId` 建立依赖，服务端先生成并持久化 opening；只有精确父 SpeechLine 存在、参与者互为本轮说话人与听者时，response 才看到父原话并保存 `replyToSpeechLineId`。需要父句的 response 即使决策阶段携带 utterance，当前仍由 speech-only 根据父原话生成；缺父、不合法或参与者不匹配时不请求 response，也不显示孤儿引号台词，但权威 ActionFact 与间接记录仍保留。主动人物对话、决策 utterance 与 speech-only 共用稳定 Soul v3 与有来源 experience layer；有效人格、身体、关系、当前处境和当前可召回经历只改变注意与表达，不能替换已授权的话题、正式提议立场与事实。成功台词绑定原 ActionFact 进入 `GameFrame.speechLines`，不覆写 summary，也不写入记忆、关系、知识或意图。观察层按精确 `sourceEventId` 把已保存原话显示在同一条文明纪事与人物行动历史里，读档直接复用，不重新调用模型；没有合法模型文本时只显示间接沟通事实，绝不把规则摘要当成原话。下一月 decision 只可读取本人已说或听见、早于本规划月且仍可核验的至多四条 SpeechLine；同月新台词不会回流，历史原话也不能证明客观事实、同意或结果。

文明历史另先由规则层筛出文明开端、纪元切换、重要天气、野兽袭击、死亡、出生、协议、关键技术和项目完成等重大事件；选择模型总结时再调用 `narrative` 路由压缩本月纪事，选择本地总结时直接保留规则文本。没有重大事件的月份不产出纪事、不调用叙事模型，请求或校验失败时也保留规则文本。赶路、搬运、吃饭和普通失败只留在人物个人记录。意图的原子动作仍由规则引擎编译、预演、修复和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。

乱纪元与恒纪元的每次真实切换都是文明历史的最高优先级事件，投影必须同时说明哪个纪元结束、哪个纪元开始。这组更迭事实由规则文本直接进入历史，不传给模型；同月其他重大事件的模型概括也会另外保留。

文明纪事在表达层按真实来源和业务语义归并：同阶段重复的冷热伤害不反复记史，对称的结伴或生育约定只显示一次，项目完成会覆盖同源的原子动作，放置与制作使用不同句式；动物袭击只有出现在同一死者的死亡来源链中才可写成死因，同月已被死亡吸收的袭击不再重复。归并只改变玩家看到的文本，全部 `sourceEventIds`、涉及人物和事实详情仍会保留，并可在历史条目中展开查看。文明开端与结局由服务端写入史册，载入或恢复会话后不会消失。

实时会话为每个分支维护一份可重建的增量纪事投影，它位于权威 `SimulationState` 之外，人物和领域规则都不能读取。会话内用事件索引按 ID 读取因果来源，每月只处理新候选：六个月间隔内的有意义天气转折更新同一稳定条目；项目完成吸收该项目的完整行动链；同人同月围绕同一产物的制作与核验归为一段技术过程。稳定条目 ID 让实时客户端原位更新而不追加重复日志。恢复、回放和分叉时，该投影仅从已存帧及分叉点之前的事件重建，不把未来纪事泄入新分支。承担稳定 ID、结构化详情或跨月因果链的重大行动（包括项目与技术过程）不交给可选模型重写。

服务端模型配置与 `ollama-chat / openai-chat / openai-responses / anthropic-messages` 路由见 [`../../../design/model-endpoint-routing.md`](../../../design/model-endpoint-routing.md)。

玩家本地存档、实时会话恢复、文明/分支/月份一致性和宇宙快照边界见 [`../../../../docs/player-save-v1.md`](../../../../docs/player-save-v1.md)。

实时 `step` 由 Worker 内一次 JSON 编码后以 transferable buffer 交给 HTTP 层。连续同分支月份只返回基于上一已提交帧的 `SocietyPatch`；客户端基线不匹配时重新读取完整 `state`，不会自行推演或补造世界事实。`state` / `load` 首屏只返回最近 240 条纪事及其总数、最近 2400 个文明指数点；`SocietyState` 只投影 active intent，终态意图仍保留在权威状态与审计历史中。服务端旧帧由 SQLite 时间线块按需重放，不为当前首屏常驻整条压缩时间线。

`three-body/data/eland.sqlite3` 是唯一持久化事实源；运行时没有文件或混合存储回退。表、codec、事务、备份恢复与 2026-08-20 切换审计见 [`../../../../docs/sqlite-persistence-v1.md`](../../../../docs/sqlite-persistence-v1.md)。实时 Worker 在第一次真实请求时才启动，old generation 默认 1536 MB、硬上限 2048 MB，young generation 默认 64 MB、硬上限 128 MB；长程 Worker 在同一后端进程内最多一个 active 实例，old generation 默认且硬上限 2048 MB。可用 `ELAND_WORKER_OLD_SPACE_MB`、`ELAND_WORKER_YOUNG_SPACE_MB` 与 `ELAND_RUN_WORKER_OLD_SPACE_MB` 向下覆盖；`.env.local` 会通过服务端环境加载器生效。`ELAND_PERF_LOG=1` 可输出规则推进、投影、快照、Worker 编码和持久化的分段耗时。

长程 run codec 从根元数据派生绝对历史 cursor，按 schema 2/3 节点链逐段读取事件，并只用新 suffix 编码新的内容寻址根。领域状态另用观察器中立的 `world.historyCursor` 保存绝对事件数和末事件 ID；创建或受信任的完整旧状态恢复负责初始化，月提交、注入与结算统一先验证再追加，规划 overlay 不计入已提交数量。当前长程运行明确只走 full-state：恢复时完整水合 `world.past`，不再维护 hot window、cold pin、retention sidecar 或 continuation 分支。
