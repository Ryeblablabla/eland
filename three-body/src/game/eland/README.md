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

`world.physicalStructureIndex` 是从已提交建造事实与当前体素确定性重建的物理语义索引。当前 v2 只按有限的 `position + building material` 保存首次/最近绝对序号与最近来源，月提交只折叠本月权威 suffix，再按当前 grid 重算连通和住所几何；bounded state 缺少与绝对 cursor 同封的 v2 provenance 时必须失败关闭，不能从热尾猜测。住所可达性与家庭准备度只能通过 `physicalStructuresOf`，施工连接通过 `constructedConnectionPositionsOf` 读取；planning overlay 只生成不写回的临时 preview。schema 17 的 `derived.structures` 仅保留为序列化兼容镜像；`regions`、`milestones`、`practices / institutions`、`functionalBuildings` 以及 `civilization.civilizationIndex / development` 全部属于观察边界。人物规划器不得把分数、时代、里程碑或观察器标签当成需要、奖励、配方或能力解锁。需要影响行动的设施条件必须回到当前体素、物质、项目、制度执行或来源事件重验。

## 目录地图

### world/ —— 世界基元

- `world/grid.ts`：84×52×12 体素世界、cellId/voxelIndex 索引、邻接、通行与确定性最小堆 A*；路径搜索复用 typed-array 工作区，体素变更修订只供缓存失效与增量投影读取。
- `world/generator.ts`：只负责生成初始自然事实与出生格；当前世界还会沿真实河道确定性生成并持久化两条有向 `water current` 段链，段是否可用仍由当前 Water 体素与上游连通性现场派生，不把 `active` 缓存成事实。

### domain/ —— 领域模型与规则

- `domain/model.ts`：`SimulationState` 聚合根（体素世界、掉落物、动物、人物、意图、协议、共同体、权限、容器、纪元预言、文明指数与派生观察）。
- `domain/person.ts`：人物权威状态（三项身体储备、过程状态、体素位置、私有背包、知识与有来源的丧亲经历）；脱水休眠在同一 episode 内区分低代谢 `dormant` 与受限补给 `recovering`。
- `domain/trait.ts`：出生时一次确定且终身不变的十三种人物特质、固定先民配置、最多三项的确定性遗传与一项随机异变审计，以及寿命、能力、身体、生殖、记忆、配方与母脉效果的共享规则。
- `naming.ts`：姓氏传统、确定性后代保底姓名，以及模型 `givenName` 候选的字符、顺序和重名验收；模型不能改姓氏或绕过回退。
- `domain/material.ts`：物质定义与调色板。
- `domain/action.ts`：五种原子动作、十种 `SourceOperation`、`WorldRef` 与 `Intent` 类型。
- `domain/intent.ts`：意图选择的组装与校验。
- `domain/intent-follow-up.ts`：生活对话开场与后续物理行动的共同人物、项目或来源事实校验。
- `domain/action-executor.ts`：原子动作的稳定预演 / 执行门面；`domain/actions/` 分别承接库存、物质观察、机械动力、沟通、技术学习与丧葬动作族，共享门面仍保留 `executePrimitiveAction`、`executeIntentAction`、`addDrop` 与 `addInventory`。person→ground 转移只允许投到人物当前 cell / z，不能远程落物；普通 `combine / exert / expose` 在扣减前拒绝把本人背包中带 `recordPayloadId` 的已写载体作为输入，空白载体仍可进入写入或其他合法动作；生殖动作必须绑定一份精确的有效协议，同一伴侣对同一自然月最多完成一次尝试，并在事实中保存协议与双方当时的关系快照；亲代移动只携带同处、清醒且未满 1 岁的婴儿，休眠者不会隐式换位。
- `domain/calendar.ts`：唯一的月历换算规则（`PLANNING_TICKS_PER_MONTH = 15`）。
- `domain/action-option-semantics.ts`：所有生产 `ActionOption` 的 v1 typed semantics；义务、规划通道、用途、最低年龄、需要、对话 / 生殖 / 社会情境由动作结构和 typed payload 表达，option ID 只作身份、排序、选择与回放。规则规划器、年龄门禁、意图执行与服务端模型网关共享同一校验；仅旧存档迁移可解析 legacy ID。
- `domain/era-prediction.ts`：可行动的乱纪元预言窗口、听众信任门槛与休眠 / 唤醒的局部判断。
- `domain/life-stage.ts`：按月龄划分未满 1 岁完全依赖、1–11 岁受限自主、12–15 岁既有项目协作与 16 岁以上完整规划。
- `domain/survival-reflex.ts`：不消耗模型额度的吃、喝与紧急避险反射；1–11 岁幼童在严重身体或冷热压力下会走向当前确实可见的亲生照护者，动作以 `caregiverRef` 留下因果证据，不读取远方亲代位置。
- `domain/shelter-access.ts`：从可见或记得的真实结构中寻找当前仍可达的住所内部；家庭准备度另作更严格判断，只有当前可见且确认空余的真实内部位置计入 shelter 分量，记忆中的远处住所只保留未验证来源且贡献为 0。
- `domain/shared-living.ts`：结伴约定的稳定生活地点、不同格共同生活结算与有界返家目标；不追踪伴侣实时坐标，最后可履约窗口会为待建立关系的已接受约定形成承诺需要，并按履约优先协议打断普通工作。
- `domain/social-space.ts`：普通语音允许水平相邻一格且站立高度相差不超过一级；远处谈话优先走到听者附近占用更低的可达站位。精确站位超过两人只形成自愿疏散的柔性舒适需要，不扣健康、不强制位移，也不放宽物品交付、照护、生殖、施力与携带的同位边界。
- `domain/water-access.ts`：真实水体素的可达性与取水规则。
- `domain/separation-rules.ts`：定义体素物质如何通过同一 `separate` 原语被采出或拆回。
- `domain/container.ts`：有体素位置和内部物品堆的空间持有者；本身不预设所有权。
- `domain/dependent-care.ts`：亲代可读取视野内 12 岁以下亲生子女的真实危机；只有会合后确有安全休眠、手中食物转移或携婴取水 / 入住所等可执行帮助时才接近并近身保护。1–11 岁儿童的普通移动还受当前可见亲代的本地照护半径约束，已有普通意图越界时会放弃；它不读取视野外身体、不替代长期家庭意图，也不赋予满 1 岁儿童同步移动。远处未成年子女客观死亡不会自动解除 `reproductiveResponsibility`，亲代取得引用该死亡的有来源丧亲认知后才释放责任。
- `domain/mortuary.ts`：普通死亡后的一人一遗体、死亡知情来源、丧亲压力、墓穴与墓记事实。人物只能因局部看见遗体 / 有标记墓穴，或经有来源的死亡对话得知死讯；遗体不是普通材料，安葬状态也不由观察器补写。月末感知用可丢弃空间索引复用已经安葬且有墓记的稳定事实，开放遗体仍每月按当前位置刷新，最终按权威 remains offset 排序。三日凌空汽化是终局例外，不生成遗体或遗物。
- `domain/population-capacity.ts`：50 人软承载附近的受孕概率衰减与超载资源竞争；它是身体 / 生态约束，不进入人物目标或文明指数。
- `domain/structure.ts`：从可站立空气、头顶实体与侧向围护的真实体素拓扑计算结构效果。
- `domain/physical-structure-index.ts`：从已提交建造事件与当前体素重建 gameplay 可读的结构索引；月提交、创世和 schema 17 恢复显式刷新，观察投影只能消费它，不能反向拥有它。
- `domain/memory.ts`：有界预算的情节、对话、承诺和失败记忆，负责遗忘与摘要；灵记只扩大本人预算与留存时长，不创造知识。月度主循环通过可丢弃 due 调度保持旧逐月折叠等价：活人每月维护，死者只在来源写入或精确预演确认会发生遗忘 / 摘要变化的月份维护；进程恢复和异常 ownership rewrite 允许一次保守全量重建。
- `domain/social-repetition.ts`：从人物本人保留的沟通记忆评估同受众、同语义主题的再次开口成本；新事实或与求助、照护、困境直接相关的显著生存危险可重新提高价值，必须回应与履约不进入这项软投票。
- `domain/social-learning.ts`：按目标人物与合作情境分别保存回应、意愿、可靠性 Beta 后验；只从协议回应 / 履约 / 违约、带真实贡献的共同项目和授权分配闭环更新。跨两个不同月份的成功才形成 person-local coordination practice，后续反证将其标为 contested；practice 只支持提议，不直接创建制度或权力。状态有界、来源精确保留，旧存档缺失时保持空先验。
- `domain/material-perception.ts`：把权威物质压缩为人物可感知的相态、外形、表面观感，以及拿取 / 核验后才知道的粗负重与刚性；不暴露配方、规则 ID 或预期产物。
- `domain/project-material-request.ts`：从追加式项目材料请求与真实转移事实派生 `open / fulfilled / expired / contributors-unavailable`，不另存第二套请求状态机；新转移精确绑定请求引用，贡献量以请求剩余量和项目当前缺口共同截断。
- `domain/spatial-knowledge.ts`、`domain/interaction-knowledge.ts`：人物的空间知识与交互/技术知识。
- `domain/interaction-rules.ts`：物质响应原语的数据驱动规则（`InteractionRule`）。
- `domain/mechanical-power.ts`：显式水流源、`WaterWheel → DriveShaft → Mill` 严格拓扑、安装计划与网络身份，以及安装、commissioning 故障、维修和运行的追加式来源事实；普通 Water 体素不能被猜成动力源，断流也不能由下游局部 Water 绕过。
- `domain/electrical-power.ts`：有限真实电网的发电源、绝缘铜导体、电阻负载、安装计划、网络身份与拓扑验证；机械作业仍不等于电力，必须由这条独立链产生运行、负载、故障和恢复事实。
- `domain/monthly-processes.ts`：无人行动也推进的世界 / 身体过程稳定门面；`domain/monthly/climate.ts` 承接纪元、气候、天气与预言，`wildlife.ts` 承接分阶段动物生态，`relationship-experience.ts` 承接共同活动和持续共同生活证据。妊娠、产后恢复、休眠与死亡等身体结算仍留在总门面，等待下一轮按生命周期再拆。新生儿不再向全部历史人物预铺零值关系，只为出生时真实同地者、仍存活亲代和后续有来源互动建立稀疏关系边。实时宇宙传入的 `triple-sun-vaporization` 在第一个规划刻度内绕过住所、休眠与特质，使全部存活人物汽化、销毁随身库存且不生成遗体或遗物；普通 `fire` 仍逐月结算。全员休眠不会终止文明；恒纪元使旧 `dormant` episode 转入不凭空增加储备的 `recovering`，真实补水 / 补食并达到三项最低储备 45 后才退出，乱纪元重临则沿用原 episode 返回 `dormant`。直接死亡会终结当前及全部暂停意图；休眠恢复若发现人物死亡或项目已经完成、阻塞、放弃、缺失，也按真实样本结算 `goalOutcome` 并清理中断边，只有真正恢复为 active 的意图暂不结算。
- `domain/animal.ts`：动物实体的位置、身体、繁殖与行为。
- `domain/kinship.ts`：由出生事实派生亲缘距离、遗传风险与人物有来源的风险认知强度；亲缘影响后代结果与人物选择，但不把动作改成非法。
- `domain/agreement.ts`、`domain/collective.ts`、`domain/permission.ts`、`domain/governance.ts`、`domain/declaration.ts`、`domain/record.ts`、`domain/social-facts.ts`、`domain/relation.ts`：协议、共同体、授权、治理规则、声明、实体记录、社会事实与定向关系账本；关系数组只持久化非零、有来源或亲缘边，高频查询使用可丢弃的进程内索引，异常原地改写必须显式失效。只剩一名在世成员的 `dormant` 共同体可经全体在世参与者明确接受新成员后恢复为 `active`。
- `domain/civilization-index.ts`、`domain/era-progression.ts`：文明指数与阶段的纯观察投影，不反向解锁能力。当前 v7 的唯一最高阶段是 `modern-civilization`（“现代文明（含信息能力）”）；旧 v1–v4 快照中的 `medieval` 只作兼容别名并规范化为古代文明。
- `domain/decision-budget.ts`：实时关键重选的人月额度与 endpoint / token 审计；不得决定人物是否获得本地规划。
- `domain/cognition.ts`：人物私有的有界行动结果后验与结构化因果记忆 basis；只从已提交 `ActionFact` 学习，排除临时 option / intent / project / cell / person ID，无位移 move 不作为经验样本。
- `domain/history.ts`、`domain/event-index.ts`：绝对已提交历史 cursor、统一追加边界、事件流查询与选择性冷事实租约。热窗原地裁剪后会立即释放旧 hot index 的事件强引用，但真实接线仍须先由持久化层原子证明 CAS 并安装所有新转冷 lease。
- `domain/personality.ts`：HEXACO 六维初始化、有效值、行动证据与月末慢速变化；人格只调节已有合法候选或真实共同经历的转化效率。新生儿会按本人的有效宜人性与外向性取得 `3..9` 的弱初始信任值，但只由出生过程把它单向应用到出生时真实同地的人；后续共同活动按每个人的有效外向性与宜人性采用 `3..5` 刻度门槛，年轻人只在已有基础增量的月份获得额外信任，不凭人格或年龄直接创造关系对象。
- `domain/person-soul.ts`：从人物 ID、baseline HEXACO 与控制 / 地位敏感度确定性重建只读 Soul；它为三条第一人称路径提供稳定的内在声音，也可供可选模型在当前合法候选内形成一致的个人取舍，但不写入人物状态，不创造记忆、知识、动机、候选或世界事实。

### application/ —— 用例

- `application/monthly-simulation.ts`：旧导入路径的兼容门面；真正的依赖组装位于外层 `simulation-runtime.ts`，创建、恢复、推进、报告与 controller API 保持不变。
- `application/simulation/state-lifecycle.ts`、`controller.ts`：分别负责创世 / schema 恢复 / 报告和有状态控制器；application 只依赖自己声明的 `ObservationProjector` 输出端口，由外层 composition root 注入 projection adapter，不再运行时导入 `projection/`。`month-boundary.ts` 固定一次推进的 `atMonth = elapsedMonths + 1` 并编排月初、月末与生命周期结算；`tick-planner.ts`、`tick-executor.ts` 固定执行每月 15 个规划刻度；`intent-execution.ts` 承接意图生命周期与原子执行，并把 Action 执行结果与 Intent `goalOutcome` 分开结算：未受孕仍是 completed 动作但妊娠目标为 attempted-unmet，无真实受孕样本的提前阻塞是 not-evaluated。新意图用 `intent-lifecycle-v1` 区分默认的达成即结算、有界复核与显式状态维护；只有旧存档继续沿用 `stateGoalUntilMonth` 的兼容维护语义。项目、记录使用、已有返回链与带生命周期期限的意图可作为父意图；必须回应、履约与保护性短任务通过 `suspend → child → resume` 返回同一意图 ID，规则、模型校验和玩家入口共享同一判定。根意图真实终结后每人每月最多获得一次额外普通 deliberation，`idle` 也消费；边沿回应不挤占普通额度。`model-review.ts` 只管理可选模型复核与额度，本地规则回退始终先成立。候选、重编译、年龄门禁、协议生命周期与事件 ID 全程使用同一月份；只读查询仍读取最近已提交月，文明创世是显式的零月例外。
- `application/simulation/month-execution.ts`：普通月度快进与有限化身共用的暂存月生命周期。它把月初准备、逐个完整 planning tick 和月末结算拆成可组合边界；一个 tick 仍让稳定顺序中的全部人物行动，受控人物入口位于休眠、恢复、生存、照护和必要避护之后。普通 `tick-executor.ts` 直接跑完 15 刻；有限化身逐命令调用同一执行器，提前交还时本地跑完剩余刻度，二者都只在 `finishMonthExecution` 后提交一次。
- `application/player-embodiment.ts`：从受控人物当前身体、局部感知、相邻可站立格、真实 `DecisionContext`、Intent 与 Project 投影稳定 `optionId + choiceKey`；提供等待、继续意图、单条相邻边移动和现有建造 / 交互候选。命令在人物轮次重新编译并解析为 `TickActorControl`，最终仍由普通领域执行器校验材料、路径、场址、权限和动作后果。
- `application/rule-planner.ts`：每个规划刻度始终可用的正式本地目标选择器；硬门禁后委托因果 BDI，自主候选由动态需要、人格、亲历后验和当前意图共同决定。候选意义只读 `action-option-semantics-v1`，不从 option ID 前缀或正则推断。
- `application/player-interaction-choice.ts`：把人物在主动建议对话中选中的当月合法方向编译为稳定语义键，并在最新上下文中本地重配；临时月份 / 表达 ID 变化不造成假失败，必须回应、履约和 follow-up 仍由同一门禁约束。
- `application/cognition/need-agenda.ts`、`family-readiness.ts`、`option-appraisal.ts`、`bdi-deliberation.ts`：从局部 `DecisionContext` 派生动态需要，其中食物储备与饮水储备是两个带资源维度的独立缺口，身体稳态再精确区分健康、营养与水分；候选只能缓解同资源储备或对应身体压力，取得型候选还必须确认本人没有对应可摄入库存。项目来源的 need 精确绑定 `projectId`，普通采食不能冒领公共储备项目压力。正向生殖的 `needActivation` 只接受 `generativity`；`belonging` 与 `autonomy` 不能激活正向选项，关系、人格、同意与风险只在激活后连续门控，拒绝或撤回仍可由 `autonomy` 驱动。家庭准备度只读本人当前可感知的食物、水、真实可达且有当前可见空余位置的住所、照护余量与气候安全，住所质量每次从 `weatherProtection / thermalInsulation` 重验；记忆中的远处住所对 shelter 分量贡献为 0。动作后验供预计努力与伤害，`goalOutcome` Beta 后验决定目标成功预期。唯一当前 `Intent` 实现持续、切换与急性中断；项目 / HTN 仍负责步骤展开，领域执行器仍负责硬合法性。
- `application/cognition/bounded-foresight.ts`、`foresight-deliberation.ts`：在廉价 appraisal 后只比较最多 4 个根、每节点 2 个后继、深度 3、一次人物决策 24 节点的本人主观后果；选择与 `applyDecision` 审计复用同一次 deliberation，required / commitment 与 follow-up 不另开前向树。无真实两难、无替代项或观察不改变下一选择时 VoI 为 0。前向调整和信息调整分别封顶 0.08 / 0.04，不能改写硬义务优先级或用无关想象越过急性生存需要；审计写入 `DecisionFact`。
- `application/cognition/social-expectation.ts`：从 typed cooperation context 读取 person-local 回应 / 意愿 / 可靠性后验；同情境多人候选保留后验最高两名并稳定轮换一名探索对象，required / commitment / withdrawal / reproduction 绕过。该值只是 `[0.82, 1.18]` 的软门控，不替代协议合法性。
- `application/decision-factor-forest.ts`：旧报告与测试的诊断兼容门面；仍投影 need、care、commitment、learning、relationship、social-repetition、consent、feasibility、harm 的理由和来源，但规划器不再把九类数值直接相加。
- `application/reproductive-risk.ts`：把人物持有的近亲风险知识置信度连续映射为本地生殖选择成本；满置信度成本仍是可被关系与生活压力权衡的软偏好，不承担动作合法性。
- `application/age-planning.ts`：按生命周期过滤简单劳动、项目发起、社会协议与繁衍候选。
- `application/project-pressure.ts`、`application/project-options.ts`：前者从本人及其局部可见事实形成项目压力，后者保留项目公共 API 门面。项目完工只给交付最后功能性动作的人物记录 `NeedResolutionEpisode`；它在 12 个月内对同 `need + desiredFunction` 的新提案压力最多降低 45%，只表示本人近期观察到需要被缓解，绝不补造库存或住所，也不能单独重开已被拒绝的生殖配对。`application/projects/` 按生命周期、提案、局部感知 / 场地、材料计划、假说调查、物流搜索、步骤编译和完成证据拆分；这些模块共同编译项目行动，不复制领域规则。定居耕作没有附近人口硬门槛，固定在局部地块；缺种走真实种源，等待生长不猜配方，完成只读取本项目场址内的播种与收获历史。局部重叠项目在候选阶段复用、提交边界再校验；若同刻度另一个人物已创建等价项目，则合并受益者与触发事实并把意图重绑到权威项目。非所有者只在创建当月有界等待已有步骤，远处项目仍可并行。同一 need 的不同功能提案在接受前取得带 `desiredFunction` 的独立 ID；若全新机械安装计划仍指向旧粗粒度提案，计划 `projectId` 会随最终 ID 重绑并重算 plan key / network ID，而维护或可靠性项目继续引用原安装计划与原网络。材料协作只为固定场地的合金、铁器与明确公共厅堂项目开放；铁匠铺可由已观察到的青铜能力与烧结砖提出，后续铁料、还原、锻打和工具阶段必须返回真实 Smithy，并以逐段原料缺口、请求与真实交付接续。历史搜索只有与当前缺口完全一致且晚于最近进展，同时不存在协作、休眠、当月落地或作物生长等待时，才会进入耗尽候选；即使搜索或实体假说已经耗尽，也必须等到有效复核期限，并距最后真实进展或本次精确搜索 / 假说关闭至少 4 个月，才能把项目结为阻塞。等待期保留精确缺口、预约和同一项目身份，不重开相同 search campaign；期限前出现精确新来源时，原项目直接恢复普通物流与生产。终局失败后人物仍会把当时机会依据跨项目继承；同一 owner + desiredFunction 只有看见精确的新材料来源、取得与功能相关的可靠计划、发现新目标环境或新 verified response 才能重开，项目 ID、月份、压力、移动和相同来源改名都不算新机会。后继项目首步必须实际使用所声明 renewal；从未发生搜索 / 假说失败的普通 construction 提案保持原行为。材料能力另区分 `observed`、本人可合法取得的 `accessible portable` 与已经放入世界的 `placed facility`；旁人背包只能证明看见，不能证明本人已有工具或世界已有设施，可见但没有实体站立路径的掉落物也不能冒充可取得能力。生产工具按木 / 骨、石器、石锄、青铜、铁的真实效用等级比较；低级工具只部分缓解劳动压力，不能一票否决升级项目。`efficient-production`、`bronze-tooling` 与 `iron-tooling` 只有在项目来源的更优工具仍由 owner 持有、且对应制作技艺已通过源绑定复验达到可靠阈值后才完成。其他便携产物项目仍要求 owner 当前目标材料栈的来源事实与本项目 `actionEventIds` 相交，跨项目复用的旧产物与可靠技术不会被伪写成本项目完成证据。耐久记录优先回应作者本人实际听到、仍开放的项目知识请求：作者必须可靠掌握与请求产物精确匹配的技术，并且已超出与请求者的近距口授范围；候选仍只读作者亲历的请求事实和可靠知识。项目随后在固定场地写入空白载体；一旦所有者背包存在与本项目所有者、目标知识和写入事实精确匹配的已写载体，返回场地并投放到精确地面优先于仍活跃的旧搜索 / 物流，投放后沿既有 `project-completed` 收口。没有合格已写载体时，仍按原制造与物流顺序推进。
- `application/projects/project-step-compiler.ts`：保留项目步骤公共门面；`project-material-provenance.ts` 要求精确 BOM 能追溯到本人可靠技术 / 记录或本人真实完成的配方事实，不能仅凭 activeProject / desiredFunction 写入 `missingMaterialIds`；有 provenance 的已知技术与实体项目仍沿用精确需求。`steps/construction.ts`、`cultivation.ts`、`care.ts` 与 `known-material-production.ts` 分别承接遮蔽构筑、定居耕作、治疗和共享已知物质生产步骤，避免总编译器继续按功能横向膨胀。质量比较缺少仪器时只提出“两个相同结构件 + 柔性悬挂件”的对称装置问题；已有仪器后只提出“稳定参考物 + 可见标记”的参考物问题。`project-material-questions.ts` 的类型只容纳可感知角色 / 性质，不能表达 material ID、rule ID 或预期产物；`project-hypotheses.ts` 按必需角色、本人 / 传播的 response 与 no-response 证据、信息相关性和可选性质排列有限试验，不再读取项目目标材料或施加正确答案加分。campaign 的候选 / 尝试 / 关闭预算为 7 / 4 / 3；已经取得的仪器、参考物和已写载体不会被当作普通耗材。
- `application/action-options.ts`、`mortuary-options.ts`、`construction-options.ts`、`container-options.ts`、`separation-options.ts`、`social-options.ts`：各类合法可供性候选的生成。生殖提议只要求提议者有可追溯关系，不再要求固定或双向分数；身体适格的回应者同时获得接受与拒绝，活跃协议同时提供继续与撤回，交给本地 appraisal 依据本人关系、恐惧、人格、责任和已知风险排序。死亡照料从人物本人已知的具体死亡出发，依次编译悼念、搬运遗体、选择可达墓址、挖墓、入葬、使用同一掘土来源覆土，以及在拥有空白木板和合格工具时立墓记；遗物保持带死亡来源和原主人身份的普通实体栈。本人近期真实完成过分离生产劳动时，可达的更高级地面工具会以劳动节省形成明确取得候选；他人背包仍不可直接读取或拿取，只能在同格、持有者交易后仍保留不低于原最高生产能力的工具、请求者也有实体余量可交付时走既有自愿交换。工具取得意图固定精确 drop，移动后的木材、灌木、成熟作物与捕猎重编译会重新选择本人当前效用最高的适用工具，不会退回徒手或较弱武器。通用有形库存候选、自然假说、已知配方与项目子装配的消耗选择都会排除已带 `recordPayloadId` 的载体，避免规划器反复生成必被领域层拒绝的普通加工。固体放置的候选与领域执行器复用同一体素结合产物规则；无论放置是眼前 `nextAction` 还是移动后的 `completionAction`，目标空气体素当前被身体占据时都暂不生成整条可供性。项目只暴露一个当前原子步骤时，移动 / 物流结束后才重编译出的占位放置会保持 active 等待，不写失败事实；身体离开后下一 tick 恢复，提交时仍会重验。项目、记录使用与生活复核的嵌套 planning preview 继承外层当月 overlay，避免候选动作与提交前重编译因证据视图不同而分叉。失败重试按动作、目标、数量、人物、项目、记录和关系组成的稳定结构 basis 比较：新状态从 terminal Intent 引用的真实 blocked / failed `ActionFact` 读取实际失败动作，自传 failure memory 只作旧状态和无动作失败的 0–6 月兼容；失败当月，完全相同的实际动作不会因换 goal / project 被第二次普通复议原样提交，跨月后再按完整 basis 与新来源判断；第 7 月恢复，必须回应与履约绕过冷却，无法还原结构 basis 的旧自由文本失败记忆不拦候选。
- `application/record-use-options.ts`：只为读者本人拥有的活跃项目及其真实技术缺口生成记录使用候选；来源限于本人背包与调用方已过滤的可见公共地面掉落物，不读取他人背包、知识或意图。V3 basis 冻结读者、项目、payload、技术和精确载体来源，但不提前冻结实验动作或输入栈；地面来源正常按 `move → acquire → read → prepare-experiment → experiment` 推进，其中移动不算取得，只有从精确掉落物成功转移到本人背包才算 `acquire`，来源消失或替换时不会另换载体。记录技术必须能以临时可靠知识编译成该项目的精确步骤，但阅读前不要求实验输入已齐备。阅读仍只形成不高于 54 的暂定技术知识；准备阶段每 tick 走普通项目物流，输入到位后才执行真实实验。现代观察只要求实验前低于 55、实验后达到至少 55 且确实上升；明确直接教学仍可到 60，但不会伪装成完整记录链。
- `application/mechanical-power-options.ts`：只让做过真实 Mill 辅助谷物分离劳动的人物关注本人当前可见、可达的水流段；成功 `attend` 后形成只属于本人的有来源观察。由此提出的项目只是冻结水流源与可见工地几何的试建假说，不泄漏隐藏配方、时代标签或观察器目标；未知部件仍走有预算的材料假说与验证。
- `application/electrical-power-options.ts`、`electrical-power-service-options.ts`、`electrical-power-maintenance-options.ts`：从人物亲历的机械服务、局部材料、已掌握操作和当前故障形成有限电网试建、带载使用与维护候选；网络、部件、位置、来源事实和替换件都需现场复验，不泄漏现代阶段门槛。
- `application/agreement-continuation.ts`：已接受协议的履约推进。

机械动力项目在同一冻结计划内新建 load、connector 与 converter：`WaterWheel` 位于冻结水流端点正上方，水平 `DriveShaft` 把它连接到新 `Mill`。部件安装严格复核计划、来源身份、网络、位置、拓扑及本人制造 / 核验来源，但不要求安装瞬间仍有活水；commissioning 与所有 operate 动作仍必须现场确认真实水流。首次完整试运转确定性暴露 `commissioning-misalignment`：动作以 `progressed` 保持持续意图，Seed 输入数量不变，轴成为 `BrokenDriveShaft`；此后必须制造并验证故障后产生的新 `DriveShaft`，再用 `BronzeTool` 维修。只有维修后的真实 `Seed → Food` 动力作业及其输入来源成立，安装项目才可完成。完成网络在本人局部可见、绑定水流仍有效、拓扑仍完整、本人持有真实 Seed 且可靠掌握操作时继续提供负载作业；只有成功负载才累计 condition 磨损。降到阈值后的下一次负载会在投入前产生实体 `worn-drive-shaft` 与 `BrokenDriveShaft`，不吞 Seed；人物必须近身检查形成个人诊断，才能提出独立维护项目，并用故障后制造、核验的新轴修理，最后再次带载运行才证明恢复。成功操作者可复用既有明确教导规则，把有作业来源的操作知识传给相邻语音范围内达到学习年龄的人；未学习者不能因看见网络而直接操作。临时失流会留下计划绑定的不可用事实并让同一项目等待；水流恢复后原项目重新编译 commissioning / operate，而不是因越过复核月永久终止。错水流源、错计划、错工地或拓扑变化仍在扣减输入前拒绝。这条链只证明持续机械传动、使用磨损、诊断维修与第二操作者传播，不证明电力、通信或计算。电力必须由独立的发电机—导体—负载拓扑产生。

现代阶段只读观察三项可回放闭环：`power:complete-network-useful-load`、`measurement:calibrated-comparable-mass`、`record:independent-experiment-reuse`。电力闭环要求拓扑有效的完整网络完成一次真实有用供电；部件制造、安装与拓扑已在同一项目内完成核验。水轮、金属传动轴、天平和标准秤砣各有数组不冲突、物理直觉一致的材料响应；小型发电机与负载仍分别使用 `MechanicalDynamo = DriveShaft + Copper`、`ResistiveLoad = Copper + FiredBrick`。所有部件都须真实制造、安装与使用。度量项目仍由至少 3 次、跨 2 个月的本人生产经验，以及当前实体中两个处于同一粗手感档的批次触发；生产经验可由近期情景记忆或本人带源技术知识中保留的生产 provenance 承接，但每次都重验动作的执行者、当前实体栈、操作与材料。缺少仪器和参考物时，人物只从对称悬挂与稳定参考的可感知功能假说继续，不读取 `BeamBalance` / `StandardWeight` 配方。记录闭环交叉核对真实项目、记录、读者/作者、知识/codebook、实验产物与置信度变化；自解码、阅读与准备本身都不算达成，只有真正产出预期实体，并使读者的技术置信度从低于 55 上升到至少 55，才构成现代证据。三项事实闭合后，在下一次权威观察提交时直接命名为“现代文明（含信息能力）”，没有额外稳定月份；不要求 CI、人口、年份或古代前置，也不向人物透露门槛。三项门槛刻意保持小型、可见、可操作和可回放，以明确成就反馈优先，不要求先复制历史上的工业规模。钢、混凝土、远距信号、计算与自动化作为现代内部后续成就，不参与晋级。

可选社交发起不会再因为过去两个月出现过相似选项而从候选集中消失。人物记得自己曾向同一受众谈过同一主题、当前又没有新事实时，`social-repetition` 会降低排序；未回应、拒绝、保留或违约会进一步降低预期，新的可追溯事实，或与求助、照护、困境主题直接相关且显著恶化的生存压力，则可支持重新开口。协议 ID 幂等、一次回应、同一生活对话 basis 与 opening 的去重仍是领域硬门禁，不由分数替代。

### projection/ —— 只读观察

- `projection/capability-milestones.ts`：v2 纯可回放因果观察器；含精确地图坐标和 world-specific 复杂事件，并以 strict/guarded、阶段门槛和完整 episode 隔离误报。死亡照料能力只在真实死亡、完整安葬和物质墓记来源闭合后出现；任何观察结果都不反向进入人物决策。
- `projection/derived-observations.ts`：从已提交权威状态与显式传入的物理结构索引派生 practices、institutions、regions、milestones 与 development 观察结果；`simulation-observation-projector.ts` 是 `ObservationProjector` 的外层适配器。当前 `cultivated` region 只表示仍存在的作物 / 幼苗 / 贫瘠地，服务物理疆域和容量。阶段观察器 v7 另从同一已完成定居耕作项目的 6 个不同播种格与 2 次成熟收获重验既成能力，并独立核验现代电力、度量和记录复用事实包。这些字段都只写观察投影，不参与候选或人物选择。
- `projection/player-narrative.ts`：从已提交事件筛选文明开端、纪元切换、重要天气、野兽袭击、死亡、出生、协议、关键技术和项目完成，并保留来源事件、涉及人物与可展开详情。动物死因必须由死亡来源链中的同对象袭击证明；同月袭击被死亡吸收后不会重复列史。
- `projection/live-speech.ts`：把每个已完成且具有可解析真实听者的口头沟通 ActionFact 投影为无显示文本的结构化 `speechAct` 草稿；只有已校验的模型台词才进入 `GameFrame.speechLines`，从不反写动作事实。
- `projection/society-world-cache.ts`：只读 WeakMap 投影缓存；复用静态 palette / biome，无体素变化时复用世界几何，有变化时仅复制并重算受影响列。

`server/evolution-artifacts.ts` 保留演化路径、检查点与事实报告的公共门面；假说活动的候选、尝试、响应和来源一致性审计集中在 `server/evolution-artifacts/hypothesis-metrics.ts`，避免报告门面继续横向膨胀。记录使用仍保留原始阶段计数与独立违规项，但只有同时通过读者 / 项目 / payload / codebook、精确取得来源、阅读理解、实验产物、置信度从低于 55 上升到至少 55、动作顺序和项目进度守卫的 basis 才计入 `completeRecordUseChains`；普通移动和无记录语义的复合对话动作不会冒充记录阶段。

### server/ —— 接口与实时会话

- `server/main.ts`：只负责依赖组装、通用 HTTP 边界和启动关闭；`run-api.ts` 承接文明运行接口，`run-evolution-service.ts` 承接每个 run 的串行推进、12 月检查点与报告提交，`model-api.ts` 承接模型决策与设置接口。
- `server/run-continuation-bundle.ts`：尚未接 Worker 的 bounded continuation 完整性 manifest codec；只封存 exact root/history authority、热窗、完整冷租约和五类 sidecar 内容引用，并不替代 SQLite CAS 或铸造可续跑权限。
- `server/elandSession.ts`：保留实时会话公共门面与兼容导出。`server/eland-session/session-step.ts` 编排 begin / step、幂等并发、权威月份、sky / cosmos 原子提交与模型回退；空闲时会话与 controller 共享唯一已提交 `SimulationState`，异步模型月份只在隔离工作副本中推进，成功后再原子提交。`timeline.ts` 负责 checkpoint / delta / seek / fork，恢复时历史块保留为 SQLite hash 引用，回放只按需读取最近年度 checkpoint 与其后 delta；`recovery.ts` 负责恢复校验；`frame-history-projector.ts`、`conversation-coordinator.ts` 分别负责帧历史与对话结果投影；`session-manager.ts` 负责 lease、TTL、LRU 与 SQLite 会话协调。实时分支真正提交到 12 的倍数月份时自动持久化，新时间线 Buffer 成功落盘后即替换为 hash 引用。
- `server/eland-session/embodiment-coordinator.ts`：在 committed authority 之外持有一个可恢复、可确定性重放的暂存月份，编排 begin / step / release、命令幂等与修订冲突。自由观察只读取 `EmbodimentView`；每个 step 执行完整世界 tick，走完第 15 刻或 release 本地补完剩余刻度后才通过会话原子提交一个月。
- `server/newborn-naming-service.ts`：在实时模型月份的出生事实对外提交前，按父母 Soul、有源近期经历和当前处境批量请求 `givenName`；本地验收后记录模型来源，失败保持确定性保底姓名，回放不再请求。

### scripts/ —— Agent 调试与实验入口

- `scripts/eland.mjs`：现有 HTTP API 的零新增依赖 CLI 适配器。`run` 管理后台持久化演化，`session` 管理逐月实时会话，两者保持不同的身份与并发语义；`inspect` 只从权威状态提取人物、项目、事件和文明摘要，不写回观察结果。
- `scripts/test-core.mjs`：默认 `npm test` 的精简工程门禁，依次运行架构边界、主模拟回归与共同生活回归；更窄的领域脚本仍按改动风险单独选择，不把 95 个历史实验全部塞进日常门禁。
- `scripts/check-eland-boundaries.mjs`：基于 TypeScript AST 检查 domain / world / application / projection 的运行时依赖方向、内核对 React / Three / HTTP 的渗透以及运行时强连通循环；从 `three-body/` 运行 `npm run test:architecture`。
- `experiment run`：按唯一前缀、种子和年数创建或恢复矩阵运行，使用绝对 `requestedEndMonth` 与完整 expected identity；默认单并发等待，矩阵 JSON 只用于离线交换和复核。
- CLI 写操作仍经过 HTTP 层、应用用例和持久化事务。脚本不直接打开 SQLite 写连接，不复制领域规则；完整命令与退出码见 [`../../../../docs/agent-cli-v1.md`](../../../../docs/agent-cli-v1.md)。

### 根级

- `character-profiles.ts`：人物档案池；开局按种子确定性抽取 5–12 位，或由配置指定最多 12 位。
- `population.ts`：开局年龄与寿命的确定性采样。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影；事件活动按追加游标增量累计，实体查找在每次投影中建立 Map，缓存不写回领域状态。
- `kimi-decider.ts`：实时关键决策发送给通用模型端点的局部事实 DTO；包含人物档案、有效人格、身体、有向关系与有源近期经历，但不暴露隐藏世界事实。历史文件名保留，但不再绑定 Kimi 供应商。
- `simulation.ts`：供其他层依赖的稳定公共门面。
- `simulation-runtime.ts`：外层 composition root，把 application 声明的观察端口连接到 projection adapter；兼容门面只转发，不把具体观察器重新引入应用层。
- `voxelKits.ts`：把真实物质和建筑事实翻译为微体素外观，并为文明指数卡提供只读的阶段象征。现代代表卡是“电力与知识站”，用发电机、导体、负载、度量衡和记录架强化成就感；它只是象征性预览，不补造世界中尚未发生的事实。

### 前端有限化身

- `src/pages/ImmersiveGame.tsx`：负责进入 / 逐刻命令 / 交还的体验状态机，始终以服务端 `EmbodimentView` 和已提交 `GameFrame` 为准，不在浏览器演算世界。
- `src/components/LimitedEmbodimentHud.tsx`：克制显示当月 15 刻、当前人物、准星、情境主操作 / 更多操作和交还自主；转头、查看目标与展开提示不消耗刻度，只有提交服务端选项才推进。
- `src/components/SocietyScene3D.tsx`、`src/components/society-scene/EmbodimentCameraController.ts`：把已投影人物锚点切换为第一人称镜头、Pointer Lock 和空间目标命中；WASD 只选择当前一条相邻移动候选，不能直接改写人物坐标或体素。

人物页主动对话由 `server/agent-interaction-gateway.ts` 调用 `interaction` 模型。玩家不需要区分普通对话与建议：服务端先从当前玩家原话保守判定 `actionChoiceRequested`。第一阶段 `agent-interaction-reply-v1` 只生成自然回复与来源审计；模型即使误带旧版 stance / choice 字段，也不会再让合法回复整体失败。纯问答不暴露其他人物尚待回应的 required choice，也不触发意图调用。只有门禁确认玩家明确提出行动请求后，才用独立的隐藏 prompt 从“玩家原话 + 已生成回复 + 当前合法候选”提取 `answer / consider / accept / decline`；解析失败静默保留回复，只有回复明确承诺且唯一匹配的 `accept + choice` 才进入行动链。服务端当场校验紧急生存、必须回应、履约与 follow-up，并保存稳定语义键；下一次可行动月份只在最新候选中本地唯一重配，不再让模型重新决定。命中后才形成带 `sourceInteractionId` 的 DecisionFact / Intent；条件暂不允许时显示暂缓，候选消失或匹配不唯一时显示具体原因。人物卡继续读取真实 Intent 与 ActionFact，把后来定下、开始、被打断、做成或停下投影回原对话。

本地规划器是服务端人物行动权威，并在任何模型请求前先生成完整回退决定。模型设置页（`M`）选择模型演进并显式配置 `decision` 路由后，必须回应只在有两个以上合法 required option，或唯一 required option 带有两个以上语义匹配的 follow-up 时才交给模型重选；单一固定回应直接由规则提交。生活对话、空闲新方向、项目停滞或状态复核也必须确有多个合法方向才进入重选；选择本地演进时直接采用规则决定。开局、生存危险和既定履约不进入模型重选；后台快速演化始终只走本地规则。候选模型只能在当前合法 option 中重选，领域层会重新验证完整 typed semantics、强制回应、复合对话的后续行动和意图组合；未知项目只投影感知 profile 与待试验问题，不发送精确 missing materials、material ID 或原始功能 tag，存在可审计计划 provenance 时才恢复精确需求。临时 option ID 只留在 DecisionFact 审计中，长期意图保存规则目标而不是模型文本。

实时月份中的说话先由规则提交为 completed `voice communicate` ActionFact，并投影为只含沟通类型、话题、提议、引用、立场与来源的 `speech-act-v1` 草稿；规则不再提供可显示原话，规则摘要也不再充当隐藏原话或文本相似度锚。尚无更细领域字段的客观陈述只把事实命题放入 `speechAct.subject`，不规定句式。决策阶段已生成合法模型台词时直接复用，其余草稿再按月进入同一 `decision` endpoint 的 speech-only 批次。主动人物对话、决策 utterance 与 speech-only 共用同一只读 Soul，避免同一个人在三条链路中出现三种性格。speech-only 模型从说话者有效人格、本月提交后的当前身体、对听者的当前关系、当前处境与有源近期经历中自主形成当下表达，这些值不是 action tick 精确快照；服务器另从当前 speechAct、人格、控制敏感度、身体压力、关系及真实伤害 / 背约 / 拒绝后重复施压证据派生 `relational-speech-frame-v1`。普通陈述默认 neutral；blunt 只在请求、拒绝、撤回等边界话语结合低宜人性、控制敏感或急迫压力时出现，低信任通常先表现为 guarded；warm、familiar 与有证据门禁的 confrontational 仍按关系和处境开放。命令式和短促请求无需礼貌关键词，人物也不必默认寒暄、共情或解释完整，但直接不自动等于不耐烦，也不应机械地以“别”开头；敌意不能由低宜人性或低信任单独凭空产生。模型仍只能表达该动作已授权的话题、立场和事实。成功且通过沟通类型与结构化立场校验的台词绑定原 ActionFact 进入 `GameFrame.speechLines`，普通陈述不再与规则句子做文本相似度比较；台词不覆写 summary，不写入记忆、关系、知识、意图或文明纪事。模型失败时仍保留沟通事实，但不显示文字气泡，已保存帧回放时不重新调用模型。

文明历史另先由规则层筛出文明开端、纪元切换、重要天气、野兽袭击、死亡、出生、协议、关键技术和项目完成等重大事件；选择模型总结时再调用 `narrative` 路由压缩本月纪事，选择本地总结时直接保留规则文本。没有重大事件的月份不产出纪事、不调用叙事模型，请求或校验失败时也保留规则文本。赶路、搬运、吃饭和普通失败只留在人物个人记录。意图的原子动作仍由规则引擎编译、预演、修复和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。

乱纪元与恒纪元的每次真实切换都是文明历史的最高优先级事件，投影必须同时说明哪个纪元结束、哪个纪元开始。这组更迭事实由规则文本直接进入历史，不传给模型；同月其他重大事件的模型概括也会另外保留。

文明纪事在表达层按真实来源和业务语义归并：同阶段重复的冷热伤害不反复记史，对称的结伴或生育约定只显示一次，项目完成会覆盖同源的原子动作，放置与制作使用不同句式；动物袭击只有出现在同一死者的死亡来源链中才可写成死因，同月已被死亡吸收的袭击不再重复。归并只改变玩家看到的文本，全部 `sourceEventIds`、涉及人物和事实详情仍会保留，并可在历史条目中展开查看。文明开端与结局由服务端写入史册，载入或恢复会话后不会消失。

实时会话为每个分支维护一份可重建的增量纪事投影，它位于权威 `SimulationState` 之外，人物和领域规则都不能读取。会话内用事件索引按 ID 读取因果来源，每月只处理新候选：六个月间隔内的有意义天气转折更新同一稳定条目；项目完成吸收该项目的完整行动链；同人同月围绕同一产物的制作与核验归为一段技术过程。稳定条目 ID 让实时客户端原位更新而不追加重复日志。恢复、回放和分叉时，该投影仅从已存帧及分叉点之前的事件重建，不把未来纪事泄入新分支。承担稳定 ID、结构化详情或跨月因果链的重大行动（包括项目与技术过程）不交给可选模型重写。

服务端模型配置与 `ollama-chat / openai-chat / openai-responses / anthropic-messages` 路由见 [`../../../design/model-endpoint-routing.md`](../../../design/model-endpoint-routing.md)。

玩家本地存档、实时会话恢复、文明/分支/月份一致性和宇宙快照边界见 [`../../../../docs/player-save-v1.md`](../../../../docs/player-save-v1.md)。

实时 `step` 由 Worker 内一次 JSON 编码后以 transferable buffer 交给 HTTP 层。连续同分支月份只返回基于上一已提交帧的 `SocietyPatch`；客户端基线不匹配时重新读取完整 `state`，不会自行推演或补造世界事实。`state` / `load` 首屏只返回最近 240 条纪事及其总数、最近 2400 个文明指数点；`SocietyState` 只投影 active intent，终态意图仍保留在权威状态与审计历史中。服务端旧帧由 SQLite 时间线块按需重放，不为当前首屏常驻整条压缩时间线。

`three-body/data/eland.sqlite3` 是唯一持久化事实源；运行时没有文件或混合存储回退。表、codec、事务、备份恢复与 2026-08-20 切换审计见 [`../../../../docs/sqlite-persistence-v1.md`](../../../../docs/sqlite-persistence-v1.md)。实时 Worker 在第一次真实请求时才启动，old generation 默认 1536 MB、硬上限 2048 MB，young generation 默认 64 MB、硬上限 128 MB；长程 Worker 在同一后端进程内最多一个 active 实例，old generation 默认且硬上限 2048 MB。可用 `ELAND_WORKER_OLD_SPACE_MB`、`ELAND_WORKER_YOUNG_SPACE_MB` 与 `ELAND_RUN_WORKER_OLD_SPACE_MB` 向下覆盖；`.env.local` 会通过服务端环境加载器生效。`ELAND_PERF_LOG=1` 可输出规则推进、投影、快照、Worker 编码和持久化的分段耗时。

长程 run codec 已能从根元数据派生绝对历史 cursor，按 schema 2/3 节点链逐段读取事件，并只用新 suffix 编码与旧 append 字节完全一致的新根。exact-successor stream 还能从 next head 的内容寻址 parent 链精确证明它到达 previous head/eventCount，只正序交付新 segment；事件递归冻结，suffix node/segment-reference 受 4096/16384 的相邻 checkpoint 硬上限约束。它只证明相对继承，previous root 仍必须由封闭 CAS/brand wrapper 提供，visitor 也只能暂存，不能提前发布副作用。领域状态另用观察器中立的 `world.historyCursor` 保存绝对事件数、热窗起点和末事件 ID；创建或受信任的完整旧状态收养负责初始化，月提交、注入与结算统一先验证再追加，规划 overlay 不计入已提交数量。该字段不参与人物选择、文明指数、时代门槛或化身执行 hash。持久化恢复尚未真正切成 hot window 与 pinned evidence，完整 `world.past` 仍会在长程 Worker 恢复时水合，不能视为长程内存问题已解决。

专用 bounded decoder 已能从 history head 逆向校验到 genesis，常驻量限制为一个节点、一个 segment、连续尾部热窗、显式绝对 ordinal pins 和 shell 的 `lastStep` 小索引；空历史、零热窗、重复 ID、坏 segment/尾摘要/累计数量都在低内存合成 fixture 中覆盖。它尚未接入 `SqliteRunStore.load` 或长程 Worker，因为机械项目、时代观察、文明指数与 checkpoint 仍需先迁移到精确 pins 和增量摘要；在这之前截断 `world.past` 会让文明规则失忆。

服务端 shadow retention projection 已能在不保留未命中事件体的情况下，提取机械 P0 所需的绝对 ordinal pins、结构化 unresolved demand、rule/model 与机械累计量，并固定一对“明确教学 → 受教者后续真实负载”见证；4096 条额外未命中合成事实不会扩大其驻留表。它还能把 recent-3、未闭合教学、存活人物见证、direct/selective/reproduction 需求和累计摘要封为带 hash 的 checkpoint basis，验证旧 authority、绝对 seal 与需求后只折叠新 suffix。动态 pending prediction、非出生新增人物和 reproduction selector 改写仍失败关闭，basis 也尚未与 run root 同事务持久化，所以 `continuationReady` 仍为 false。`SqliteRunStore` 的未接线 bounded 路径可以用不可变 basis 严格载入 schema 2/3，并通过绝对 suffix + revision/stateHash CAS 原子保存热窗状态；公共 full load/save 保持不变。

两个 server-only observer streaming foundation 也已建立，但都未接生产：derived projection 只跟踪当前结构/项目引用和显式 retained/future closure，10 万个无关唯一事件不会扩大 demand basis；civilization projection 只完成部分因果锚点与 milestone definition coverage。非单调 shell gate、development 稳定期、完整 detector、terminal report 累计和 exact-root CAS 仍未完成，二者均为 `continuationReady: false`。固定月份长程运行以后可以延迟昂贵的 observer 重物化，但仍需每月维护精确小型 sidecar；milestone endpoint 不得在缺少等价 accumulator 时采用 deferred 模式。terminal report 遇到 bounded hot tail 也会失败关闭，不会把局部历史冒充累计事实。

领域事件索引现可在进程外状态之外注册带 lease 的已验证冷事实，解析顺序固定为当月 planning overlay、连续热尾、选择性 cold pin；多个冷 pin 共用 ID 时取较晚绝对序号，通用 `worldEventFacts` 在有界状态下直接拒绝，绝不把 pins 与热尾冒充完整回放。机械动力项目只额外读取 `living-mill-labor:<person>:recent-3` 租约；11 条合成历史中，较新的无效 observation 来源也不能挤掉较旧有效事实，full 与 bounded 机械压力证据一致，RSS 约 76 MiB。服务端也有严格但未接控制器的封闭式 bounded adoption：入口复制并冻结 exact root chunk，内部从同一 owned root 完成 bounded decode、verified retention stream、带 pins 的二次 decode 与 verified physical stream；调用方不能注入 shell、projection 或中间状态。它随后验证当前 schema、零阻断 retention 缺口、逐 ordinal/ID pin 与已重绑 `lastStep`，hydrate grid 后强制从已验证 provenance 重算物理拓扑，不运行任何依赖全历史的迁移或观察投影。外部只得到冻结的 `continuationReady: false` receipt，不能取得或冒充普通 `SimulationState`。累计 observer、其他直接 `world.past` 聚合、retention/projection 的 CAS 持久化和 Worker 路由完成前仍不得改线或推进真实候选。

当前另有一条由 `SqliteRunStore` 封闭组合的显式 bounded 长程实验路径。单个 decoder / materializer 仍返回 `continuationReady: false`，但 store 用不可伪造的私有 generation token 把热尾、冷 pins、物理、derived observer、civilization observer、retention 与 checkpoint sidecar 组合为可原子发布的一个月；普通月和年度观察月分别走独立 controller，后者使用同一事实历史的 private root A 与 observer-materialized root B。`scripts/run-bounded-modern-evolution.mjs` 已使用该路径，普通 HTTP 长程 Worker仍保持 full-state 路由。retention 当前写 Brotli v2（规范 32 MiB、存储 8 MiB 硬上限，兼容读 v1），新生殖意图保存 agreement 已有 attempt ID 前缀作为基线；derived future closure 还包含尚未并入当前结构的有限 construction records，并对后续新增旧需求从 exact previous root 封存最后写入 / 缺席。新格式 checkpoint 最多增长到 256 个后批量保留最新 128 个，再回收不可达块。
