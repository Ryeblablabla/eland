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

`SimulationState.derived` 不是“全部都不可被规则读取”的同义词。`structures` 是从当前体素事实确定性重建的物理语义索引，住所可达性与项目预演会读取它，但不能把缓存当成独立事实源；`regions`、`milestones`、`practices / institutions`、`functionalBuildings` 以及 `civilization.civilizationIndex / development` 属于观察边界。人物规划器不得把分数、时代、里程碑或观察器标签当成需要、奖励、配方或能力解锁。需要影响行动的设施条件必须回到当前体素、物质、项目、制度执行或来源事件重验。

## 目录地图

### world/ —— 世界基元

- `world/grid.ts`：84×52×12 体素世界、cellId/voxelIndex 索引、邻接、通行与确定性最小堆 A*；路径搜索复用 typed-array 工作区，体素变更修订只供缓存失效与增量投影读取。
- `world/generator.ts`：只负责生成初始自然事实与出生格；当前世界还会沿真实河道确定性生成并持久化两条有向 `water current` 段链，段是否可用仍由当前 Water 体素与上游连通性现场派生，不把 `active` 缓存成事实。

### domain/ —— 领域模型与规则

- `domain/model.ts`：`SimulationState` 聚合根（体素世界、掉落物、动物、人物、意图、协议、共同体、权限、容器、纪元预言、文明指数与派生观察）。
- `domain/person.ts`：人物权威状态（三项身体储备、过程状态、体素位置、私有背包、知识）；脱水休眠在同一 episode 内区分低代谢 `dormant` 与受限补给 `recovering`。
- `naming.ts`：姓氏传统、确定性后代保底姓名，以及模型 `givenName` 候选的字符、顺序和重名验收；模型不能改姓氏或绕过回退。
- `domain/material.ts`：物质定义与调色板。
- `domain/action.ts`：五种原子动作、九种 `SourceOperation`、`WorldRef` 与 `Intent` 类型。
- `domain/intent.ts`：意图选择的组装与校验。
- `domain/intent-follow-up.ts`：生活对话开场与后续物理行动的共同人物、项目或来源事实校验。
- `domain/action-executor.ts`：原子动作的预演与执行；person→ground 转移只允许投到人物当前 cell / z，不能远程落物；普通 `combine / exert / expose` 在扣减前拒绝把本人背包中带 `recordPayloadId` 的已写载体作为输入，空白载体仍可进入写入或其他合法动作；生殖动作必须绑定一份精确的有效协议，同一伴侣对同一自然月最多完成一次尝试；亲代移动只携带同处、清醒且未满 1 岁的婴儿，休眠者不会隐式换位。
- `domain/calendar.ts`：唯一的月历换算规则（`PLANNING_TICKS_PER_MONTH = 15`）。
- `domain/era-prediction.ts`：可行动的乱纪元预言窗口、听众信任门槛与休眠 / 唤醒的局部判断。
- `domain/life-stage.ts`：按月龄划分未满 1 岁完全依赖、1–11 岁受限自主、12–15 岁既有项目协作与 16 岁以上完整规划。
- `domain/survival-reflex.ts`：不消耗模型额度的吃、喝与紧急避险反射；1–11 岁幼童在严重身体或冷热压力下会走向当前确实可见的亲生照护者，动作以 `caregiverRef` 留下因果证据，不读取远方亲代位置。
- `domain/shelter-access.ts`：从可见或记得的真实结构中寻找当前仍可达的住所内部。
- `domain/water-access.ts`：真实水体素的可达性与取水规则。
- `domain/separation-rules.ts`：定义体素物质如何通过同一 `separate` 原语被采出或拆回。
- `domain/container.ts`：有体素位置和内部物品堆的空间持有者；本身不预设所有权。
- `domain/dependent-care.ts`：亲代可读取视野内 12 岁以下亲生子女的真实危机；只有会合后确有安全休眠、手中食物转移或携婴取水 / 入住所等可执行帮助时才接近并近身保护。1–11 岁儿童的普通移动还受当前可见亲代的本地照护半径约束，已有普通意图越界时会放弃；它不读取视野外身体、不替代长期家庭意图，也不赋予满 1 岁儿童同步移动。
- `domain/population-capacity.ts`：50 人软承载附近的受孕概率衰减与超载资源竞争；它是身体 / 生态约束，不进入人物目标或文明指数。
- `domain/structure.ts`：从可站立空气、头顶实体与侧向围护的真实体素拓扑计算结构效果。
- `domain/memory.ts`：固定预算的情节、对话、承诺和失败记忆，负责遗忘与摘要。
- `domain/social-repetition.ts`：从人物本人保留的沟通记忆评估同受众、同语义主题的再次开口成本；新事实或与求助、照护、困境直接相关的显著生存危险可重新提高价值，必须回应与履约不进入这项软投票。
- `domain/project-material-request.ts`：从追加式项目材料请求与真实转移事实派生 `open / fulfilled / expired / contributors-unavailable`，不另存第二套请求状态机；新转移精确绑定请求引用，贡献量以请求剩余量和项目当前缺口共同截断。
- `domain/spatial-knowledge.ts`、`domain/interaction-knowledge.ts`：人物的空间知识与交互/技术知识。
- `domain/interaction-rules.ts`：物质响应原语的数据驱动规则（`InteractionRule`）。
- `domain/mechanical-power.ts`：显式水流源、`WaterWheel → DriveShaft → Mill` 严格拓扑、安装计划与网络身份，以及安装、commissioning 故障、维修和运行的追加式来源事实；普通 Water 体素不能被猜成动力源，断流也不能由下游局部 Water 绕过。
- `domain/monthly-processes.ts`：无人行动也推进的世界过程：气候与纪元、预言结算、妊娠 / 产后恢复等身体结算、动物生态，以及月初月末同处且无直接伤害配对的可追溯关系经验。全员休眠不会终止文明；恒纪元使旧 `dormant` episode 转入不凭空增加储备的 `recovering`，真实补水 / 补食并达到三项最低储备 45 后才退出，乱纪元重临则沿用原 episode 返回 `dormant`。
- `domain/animal.ts`：动物实体的位置、身体、繁殖与行为。
- `domain/kinship.ts`：由出生事实派生亲缘距离、遗传风险与人物有来源的风险认知强度；亲缘影响后代结果与人物选择，但不把动作改成非法。
- `domain/agreement.ts`、`domain/collective.ts`、`domain/permission.ts`、`domain/governance.ts`、`domain/declaration.ts`、`domain/record.ts`、`domain/social-facts.ts`、`domain/relation.ts`：协议、共同体、授权、治理规则、声明、实体记录、社会事实与定向关系账本。
- `domain/civilization-index.ts`：文明指数纯观察投影，不反向解锁能力。
- `domain/decision-budget.ts`：实时关键重选的人月额度与 endpoint / token 审计；不得决定人物是否获得本地规划。
- `domain/cognition.ts`：人物私有的有界行动结果后验与结构化因果记忆 basis；只从已提交 `ActionFact` 学习，排除临时 option / intent / project / cell / person ID，无位移 move 不作为经验样本。
- `domain/event-index.ts`：事件流查询索引。
- `domain/personality.ts`：HEXACO 六维初始化、有效值、行动证据与月末慢速变化；人格只调节已有合法候选。
- `domain/person-soul.ts`：从人物 ID、baseline HEXACO 与控制 / 地位敏感度确定性重建只读 Soul；它为三条第一人称路径提供稳定的内在声音，也可供可选模型在当前合法候选内形成一致的个人取舍，但不写入人物状态，不创造记忆、知识、动机、候选或世界事实。

### application/ —— 用例

- `application/monthly-simulation.ts`：月度模拟的稳定公共门面，保留创建、恢复、推进、报告与 controller API；具体职责拆到 `application/simulation/`，调用方不依赖内部编排文件。
- `application/simulation/state-lifecycle.ts`、`controller.ts`：分别负责创世 / schema 恢复 / 报告和有状态控制器；`month-boundary.ts` 固定一次推进的 `atMonth = elapsedMonths + 1` 并编排月初、月末与生命周期结算；`tick-planner.ts`、`tick-executor.ts` 固定执行每月 15 个规划刻度；`intent-execution.ts` 承接意图生命周期与原子执行；`model-review.ts` 只管理可选模型复核与额度，本地规则回退始终先成立。候选、重编译、年龄门禁、协议生命周期与事件 ID 全程使用同一月份；只读查询仍读取最近已提交月，文明创世是显式的零月例外。
- `application/rule-planner.ts`：每个规划刻度始终可用的正式本地目标选择器；硬门禁后委托因果 BDI，自主候选由动态需要、人格、亲历后验和当前意图共同决定。
- `application/player-interaction-choice.ts`：把人物在主动建议对话中选中的当月合法方向编译为稳定语义键，并在最新上下文中本地重配；临时月份 / 表达 ID 变化不造成假失败，必须回应、履约和 follow-up 仍由同一门禁约束。
- `application/cognition/need-agenda.ts`、`option-appraisal.ts`、`bdi-deliberation.ts`：从局部 `DecisionContext` 派生动态需要，把 HEXACO 用作注意 / 风险 / 坚持 / 探索 / 社会接近门控，读取同一目标人物的结构化情节记忆和本人 Beta 结果后验，并以唯一当前 `Intent` 实现持续、切换与急性中断。项目 / HTN 仍负责步骤展开，领域执行器仍负责硬合法性。
- `application/decision-factor-forest.ts`：旧报告与测试的诊断兼容门面；仍投影 need、care、commitment、learning、relationship、social-repetition、consent、feasibility、harm 的理由和来源，但规划器不再把九类数值直接相加。
- `application/reproductive-risk.ts`：把人物持有的近亲风险知识置信度连续映射为本地生殖选择成本；满置信度成本仍是可被关系与生活压力权衡的软偏好，不承担动作合法性。
- `application/age-planning.ts`：按生命周期过滤简单劳动、项目发起、社会协议与繁衍候选。
- `application/project-pressure.ts`、`application/project-options.ts`：前者从本人及其局部可见事实形成项目压力，后者保留项目公共 API 门面。`application/projects/` 按生命周期、提案、局部感知 / 场地、材料计划、假说调查、物流搜索、步骤编译和完成证据拆分；这些模块共同编译项目行动，不复制领域规则。定居耕作没有附近人口硬门槛，固定在局部地块；缺种走真实种源，等待生长不猜配方，完成只读取本项目的播种与收获历史。局部重叠项目在候选阶段复用、提交边界再校验；若同刻度另一个人物已创建等价项目，则合并受益者与触发事实并把意图重绑到权威项目。非所有者只在创建当月有界等待已有步骤，远处项目仍可并行。当前材料协作只为固定场地的合金项目开放。材料能力另区分 `observed`、本人可合法取得的 `accessible portable` 与已经放入世界的 `placed facility`；旁人背包只能证明看见，不能证明本人已有工具或世界已有设施，可见但没有实体站立路径的掉落物也不能冒充可取得能力。生产工具按木 / 骨、石器、石锄、青铜、铁的真实效用等级比较；低级工具只部分缓解劳动压力，不能一票否决升级项目。`efficient-production`、`bronze-tooling` 与 `iron-tooling` 只有在项目来源的更优工具仍由 owner 持有、且对应制作技艺已通过源绑定复验达到可靠阈值后才完成。其他便携产物项目仍要求 owner 当前目标材料栈的来源事实与本项目 `actionEventIds` 相交，跨项目复用的旧产物与可靠技术不会被伪写成本项目完成证据。耐久记录项目在固定场地写入空白载体；一旦所有者背包存在与本项目所有者、目标知识和写入事实精确匹配的已写载体，返回场地并投放到精确地面的步骤优先于仍活跃的旧搜索 / 物流，投放后沿既有 `project-completed` 收口。没有合格已写载体时，仍按原制造与物流顺序推进。
- `application/action-options.ts`、`construction-options.ts`、`container-options.ts`、`separation-options.ts`、`social-options.ts`：各类合法可供性候选的生成。本人近期真实完成过分离生产劳动时，可达的更高级地面工具会以劳动节省形成明确取得候选；他人背包仍不可直接读取或拿取，只能在同格、持有者交易后仍保留不低于原最高生产能力的工具、请求者也有实体余量可交付时走既有自愿交换。工具取得意图固定精确 drop，移动后的木材、灌木、成熟作物与捕猎重编译会重新选择本人当前效用最高的适用工具，不会退回徒手或较弱武器。通用有形库存候选、自然假说、已知配方与项目子装配的消耗选择都会排除已带 `recordPayloadId` 的载体，避免规划器反复生成必被领域层拒绝的普通加工。失败重试按动作、目标、数量、人物、项目、记录和关系组成的稳定结构 basis 比较：失败当月起 0–6 月压住同因果候选，第 7 月恢复；新来源或任一结构字段改变会立即重开，必须回应与履约绕过冷却，无法还原结构 basis 的旧自由文本失败记忆不拦候选。
- `application/record-use-options.ts`：只为读者本人拥有的活跃项目及其真实技术缺口生成记录使用候选；来源限于本人背包与调用方已过滤的可见公共地面掉落物，不读取他人背包、知识或意图。v2 basis 冻结读者、项目、payload、技术和精确载体来源；地面来源正常按 `move → acquire → read → experiment` 推进，其中移动不算取得，只有从精确掉落物成功转移到本人背包才算 `acquire`，来源消失或替换时不会另换载体。阅读只形成不高于 54 的暂定技术知识，真实项目实验再增加 18 并写入项目进度；明确直接教学仍可到 60。外部交付同一地面来源谱系，或人物此前已经读过该记录时，可依当前真实持有与知识继续，但不会补造缺失阶段，也不构成完整记录链。
- `application/mechanical-power-options.ts`：只让做过真实 Mill 辅助谷物分离劳动的人物关注本人当前可见、可达的水流段；成功 `attend` 后形成只属于本人的有来源观察。由此提出的项目只是冻结水流源与可见工地几何的试建假说，不泄漏隐藏配方、时代标签或观察器目标；未知部件仍走有预算的材料假说与验证。
- `application/agreement-continuation.ts`：已接受协议的履约推进。

机械动力项目在同一冻结计划内新建 load、connector 与 converter：水流端点保持 Water，`WaterWheel` 位于端点正上方，水平 `DriveShaft` 把它连接到新 `Mill`。首次完整试运转确定性暴露 `commissioning-misalignment`：动作以 `progressed` 保持持续意图，Seed 输入数量不变，轴成为 `BrokenDriveShaft`；此后必须制造并验证故障后产生的新 `DriveShaft`，再用 `BronzeTool` 维修。只有维修后的真实 `Seed → Food` 动力作业及其输入来源成立，项目才可完成。失流、错水流源、错计划、错工地或拓扑变化都会在扣减输入前拒绝继续。这条链只证明受限机械传动与维修闭环，不证明连续电力、通信、计算或信息时代。

可选社交发起不会再因为过去两个月出现过相似选项而从候选集中消失。人物记得自己曾向同一受众谈过同一主题、当前又没有新事实时，`social-repetition` 会降低排序；未回应、拒绝、保留或违约会进一步降低预期，新的可追溯事实，或与求助、照护、困境主题直接相关且显著恶化的生存压力，则可支持重新开口。协议 ID 幂等、一次回应、同一生活对话 basis 与 opening 的去重仍是领域硬门禁，不由分数替代。

### projection/ —— 只读观察

- `projection/capability-milestones.ts`：v2 纯可回放因果观察器；含 120 个精确地图坐标和 17 个 world-specific 复杂事件，并以 strict/guarded、阶段门槛和完整 episode 隔离误报，事实不反向进入人物决策。
- `projection/derived-observations.ts`：从已提交权威状态派生 structures、practices、institutions、regions、milestones 与 development 观察结果；只写观察投影，不参与候选或人物选择。
- `projection/live-speech.ts`：把每个已完成且具有可解析真实听者的口头沟通 ActionFact 投影为无显示文本的结构化 `speechAct` 草稿；只有已校验的模型台词才进入 `GameFrame.speechLines`，从不反写动作事实。
- `projection/society-world-cache.ts`：只读 WeakMap 投影缓存；复用静态 palette / biome，无体素变化时复用世界几何，有变化时仅复制并重算受影响列。

`server/evolution-artifacts.ts` 对记录使用保留原始阶段计数与独立违规项，但只有同时通过读者 / 项目 / payload / codebook、精确取得来源、阅读理解与可靠度、实验产物与 `+18`、动作顺序和项目进度守卫的 basis 才计入 `completeRecordUseChains`；普通移动和无记录语义的复合对话动作不会冒充记录阶段。

### server/ —— 接口与实时会话

- `server/main.ts`：只负责依赖组装、通用 HTTP 边界和启动关闭；`run-api.ts` 承接文明运行接口，`run-evolution-service.ts` 承接每个 run 的串行推进、12 月检查点与报告提交，`model-api.ts` 承接模型决策与设置接口。
- `server/elandSession.ts`：保留实时会话公共门面与兼容导出。`server/eland-session/session-step.ts` 编排 begin / step、幂等并发、权威月份、sky / cosmos 原子提交与模型回退；空闲时会话与 controller 共享唯一已提交 `SimulationState`，异步模型月份只在隔离工作副本中推进，成功后再原子提交。`timeline.ts` 负责 checkpoint / delta / seek / fork，恢复时历史块保留为 SQLite hash 引用，回放只按需读取最近年度 checkpoint 与其后 delta；`recovery.ts` 负责恢复校验；`frame-history-projector.ts`、`conversation-coordinator.ts` 分别负责帧历史与对话结果投影；`session-manager.ts` 负责 lease、TTL、LRU 与 SQLite 会话协调。实时分支真正提交到 12 的倍数月份时自动持久化，新时间线 Buffer 成功落盘后即替换为 hash 引用。
- `server/newborn-naming-service.ts`：在实时模型月份的出生事实对外提交前，按父母 Soul、有源近期经历和当前处境批量请求 `givenName`；本地验收后记录模型来源，失败保持确定性保底姓名，回放不再请求。

### 根级

- `character-profiles.ts`：人物档案池；开局按种子抽取 5–8 位或由配置指定。
- `population.ts`：开局年龄与寿命的确定性采样。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影；事件活动按追加游标增量累计，实体查找在每次投影中建立 Map，缓存不写回领域状态。
- `kimi-decider.ts`：实时关键决策发送给通用模型端点的局部事实 DTO；包含人物档案、有效人格、身体、有向关系与有源近期经历，但不暴露隐藏世界事实。历史文件名保留，但不再绑定 Kimi 供应商。
- `simulation.ts`：供其他层依赖的稳定公共门面。

人物页主动对话由 `server/agent-interaction-gateway.ts` 调用 `interaction` 模型。玩家不需要区分普通对话与建议：服务端先从当前玩家原话保守判定 `actionChoiceRequested`。第一阶段 `agent-interaction-reply-v1` 只生成自然回复与来源审计；模型即使误带旧版 stance / choice 字段，也不会再让合法回复整体失败。纯问答不暴露其他人物尚待回应的 required choice，也不触发意图调用。只有门禁确认玩家明确提出行动请求后，才用独立的隐藏 prompt 从“玩家原话 + 已生成回复 + 当前合法候选”提取 `answer / consider / accept / decline`；解析失败静默保留回复，只有回复明确承诺且唯一匹配的 `accept + choice` 才进入行动链。服务端当场校验紧急生存、必须回应、履约与 follow-up，并保存稳定语义键；下一次可行动月份只在最新候选中本地唯一重配，不再让模型重新决定。命中后才形成带 `sourceInteractionId` 的 DecisionFact / Intent；条件暂不允许时显示暂缓，候选消失或匹配不唯一时显示具体原因。人物卡继续读取真实 Intent 与 ActionFact，把后来定下、开始、被打断、做成或停下投影回原对话。

本地规划器是服务端人物行动权威，并在任何模型请求前先生成完整回退决定。模型设置页（`M`）选择模型演进并显式配置 `decision` 路由后，必须回应只在有两个以上合法 required option，或唯一 required option 带有两个以上语义匹配的 follow-up 时才交给模型重选；单一固定回应直接由规则提交。生活对话、空闲新方向、项目停滞或状态复核也必须确有多个合法方向才进入重选；选择本地演进时直接采用规则决定。开局、生存危险和既定履约不进入模型重选；后台快速演化始终只走本地规则。候选模型只能在当前合法 option 中重选，领域层会重新验证强制回应、复合对话的后续行动和意图组合；临时 option ID 只留在 DecisionFact 审计中，长期意图保存规则目标而不是模型文本。

实时月份中的说话先由规则提交为 completed `voice communicate` ActionFact，并投影为只含沟通类型、话题、提议、引用、立场与来源的 `speech-act-v1` 草稿；规则不再提供可显示原话，规则摘要也不再充当隐藏原话或文本相似度锚。尚无更细领域字段的客观陈述只把事实命题放入 `speechAct.subject`，不规定句式。决策阶段已生成合法模型台词时直接复用，其余草稿再按月进入同一 `decision` endpoint 的 speech-only 批次。主动人物对话、决策 utterance 与 speech-only 共用同一只读 Soul，避免同一个人在三条链路中出现三种性格。speech-only 模型从说话者有效人格、本月提交后的当前身体、对听者的当前关系、当前处境与有源近期经历中自主形成当下表达，这些值不是 action tick 精确快照；服务器另从人格、控制敏感度、身体压力、关系及真实伤害 / 背约 / 拒绝后重复施压证据派生 `relational-speech-frame-v1`，允许 warm、familiar、guarded、blunt 与有证据门禁的 confrontational。命令式和短促请求无需礼貌关键词，人物也不必默认寒暄、共情或解释完整；敌意则不能由低宜人性或低信任单独凭空产生。模型仍只能表达该动作已授权的话题、立场和事实。成功且通过沟通类型与结构化立场校验的台词绑定原 ActionFact 进入 `GameFrame.speechLines`，普通陈述不再与规则句子做文本相似度比较；台词不覆写 summary，不写入记忆、关系、知识、意图或文明纪事。模型失败时仍保留沟通事实，但不显示文字气泡，已保存帧回放时不重新调用模型。

文明历史另先由规则层筛出出生、死亡、关键技术、项目完成等重大事件；选择模型总结时再调用 `narrative` 路由压缩本月纪事，选择本地总结时直接保留规则文本。没有重大事件的月份不产出纪事、不调用叙事模型，请求或校验失败时也保留规则文本。赶路、搬运、吃饭和普通失败只留在人物个人记录。意图的原子动作仍由规则引擎编译、预演、修复和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。

乱纪元与恒纪元的每次真实切换都是文明历史的最高优先级事件，投影必须同时说明哪个纪元结束、哪个纪元开始。这组更迭事实由规则文本直接进入历史，不传给模型；同月其他重大事件的模型概括也会另外保留。

文明纪事在表达层按真实来源和业务语义归并：同阶段重复的冷热伤害不反复记史，对称的结伴或生育约定只显示一次，项目完成会覆盖同源的原子动作，放置与制作使用不同句式。归并只改变玩家看到的文本，全部 `sourceEventIds` 仍会保留。文明开端与结局由服务端写入史册，载入或恢复会话后不会消失。

服务端模型配置与 `ollama-chat / openai-chat / openai-responses / anthropic-messages` 路由见 [`../../../design/model-endpoint-routing.md`](../../../design/model-endpoint-routing.md)。

玩家本地存档、实时会话恢复、文明/分支/月份一致性和宇宙快照边界见 [`../../../../docs/player-save-v1.md`](../../../../docs/player-save-v1.md)。

实时 `step` 由 Worker 内一次 JSON 编码后以 transferable buffer 交给 HTTP 层。连续同分支月份只返回基于上一已提交帧的 `SocietyPatch`；客户端基线不匹配时重新读取完整 `state`，不会自行推演或补造世界事实。`state` / `load` 首屏只返回最近 240 条纪事及其总数、最近 2400 个文明指数点；`SocietyState` 只投影 active intent，终态意图仍保留在权威状态与审计历史中。服务端旧帧由 SQLite 时间线块按需重放，不为当前首屏常驻整条压缩时间线。

`three-body/data/eland.sqlite3` 是唯一持久化事实源；运行时没有文件或混合存储回退。表、codec、事务、备份恢复与 2026-08-20 切换审计见 [`../../../../docs/sqlite-persistence-v1.md`](../../../../docs/sqlite-persistence-v1.md)。实时 Worker 默认 old / young generation 上限为 1024 / 64 MB，可用 `ELAND_WORKER_OLD_SPACE_MB` 与 `ELAND_WORKER_YOUNG_SPACE_MB` 覆盖；`.env.local` 会通过服务端环境加载器生效。`ELAND_PERF_LOG=1` 可输出规则推进、投影、快照、Worker 编码和持久化的分段耗时。
