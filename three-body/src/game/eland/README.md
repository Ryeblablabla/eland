# ELAND 模块边界

这里采用单一领域内的分层结构，依赖方向始终朝向领域模型：

```text
UI / HTTP / optional model infrastructure
              ↓
adapter / application use case
              ↓
domain model and policies
              ↓
world grid primitives
```

## 目录地图

### world/ —— 世界基元

- `world/grid.ts`：84×52×12 体素世界、cellId/voxelIndex 索引、邻接、通行与确定性最小堆 A*；路径搜索复用 typed-array 工作区，体素变更修订只供缓存失效与增量投影读取。
- `world/generator.ts`：只负责生成初始自然事实与出生格。

### domain/ —— 领域模型与规则

- `domain/model.ts`：`SimulationState` 聚合根（体素世界、掉落物、动物、人物、意图、协议、共同体、权限、容器、纪元预言、文明指数与派生观察）。
- `domain/person.ts`：人物权威状态（三项身体储备、过程状态、体素位置、私有背包、知识）。
- `domain/material.ts`：物质定义与调色板。
- `domain/action.ts`：五种原子动作、九种 `SourceOperation`、`WorldRef` 与 `Intent` 类型。
- `domain/intent.ts`：意图选择的组装与校验。
- `domain/intent-follow-up.ts`：生活对话开场与后续物理行动的共同人物、项目或来源事实校验。
- `domain/action-executor.ts`：原子动作的预演与执行；生殖动作必须绑定一份精确的有效协议，同一伴侣对同一自然月最多完成一次尝试；亲代移动只携带同处、清醒且未满 1 岁的婴儿，休眠者不会隐式换位。
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
- `domain/spatial-knowledge.ts`、`domain/interaction-knowledge.ts`：人物的空间知识与交互/技术知识。
- `domain/interaction-rules.ts`：物质响应原语的数据驱动规则（`InteractionRule`）。
- `domain/monthly-processes.ts`：无人行动也推进的世界过程：气候与纪元、预言结算、妊娠 / 产后恢复等身体结算、动物生态，以及月初月末同处且无直接伤害配对的可追溯关系经验。
- `domain/animal.ts`：动物实体的位置、身体、繁殖与行为。
- `domain/kinship.ts`：由出生事实派生的亲缘距离与遗传风险；只影响结果，不禁止动作。
- `domain/agreement.ts`、`domain/collective.ts`、`domain/permission.ts`、`domain/governance.ts`、`domain/declaration.ts`、`domain/record.ts`、`domain/social-facts.ts`、`domain/relation.ts`：协议、共同体、授权、治理规则、声明、实体记录、社会事实与定向关系账本。
- `domain/civilization-index.ts`：文明指数纯观察投影，不反向解锁能力。
- `domain/decision-budget.ts`：实时关键重选的人月额度与 endpoint / token 审计；不得决定人物是否获得本地规划。
- `domain/event-index.ts`：事件流查询索引。
- `domain/personality.ts`：HEXACO 六维初始化、有效值、行动证据与月末慢速变化；人格只调节已有合法候选。
- `domain/person-soul.ts`：从人物 ID、baseline HEXACO 与控制 / 地位敏感度确定性重建只读 Soul；它为三条第一人称路径提供稳定的内在声音，也可供可选模型在当前合法候选内形成一致的个人取舍，但不写入人物状态，不创造记忆、知识、动机、候选或世界事实。

### application/ —— 用例

- `application/monthly-simulation.ts`：创建文明、执行每月 15 个规划刻度、状态迁移、恢复状态和生成报告；含一部分里程碑观察器。
- `application/rule-planner.ts`：每个规划刻度始终可用的正式本地目标选择器。
- `application/player-interaction-choice.ts`：把人物在主动建议对话中选中的当月合法方向编译为稳定语义键，并在最新上下文中本地重配；临时月份 / 表达 ID 变化不造成假失败，必须回应、履约和 follow-up 仍由同一门禁约束。
- `application/decision-factor-forest.ts`：九棵可解释因果树（need、care、commitment、learning、relationship、social-repetition、consent、feasibility、harm）的投票排序；每棵树输出理由与来源，稳定随机值只破同分。
- `application/age-planning.ts`：按生命周期过滤简单劳动、项目发起、社会协议与繁衍候选。
- `application/project-pressure.ts`、`application/project-options.ts`：从本人及其局部可见事实形成项目压力，再编译材料、场地、物流、假说与完成证据。定居耕作没有附近人口硬门槛，固定在局部地块；缺种走真实种源，等待生长不猜配方，完成只读取本项目的播种与收获历史。
- `application/action-options.ts`、`construction-options.ts`、`container-options.ts`、`separation-options.ts`、`social-options.ts`：各类合法可供性候选的生成。
- `application/agreement-continuation.ts`：已接受协议的履约推进。

可选社交发起不会再因为过去两个月出现过相似选项而从候选集中消失。人物记得自己曾向同一受众谈过同一主题、当前又没有新事实时，`social-repetition` 会降低排序；未回应、拒绝、保留或违约会进一步降低预期，新的可追溯事实，或与求助、照护、困境主题直接相关且显著恶化的生存压力，则可支持重新开口。协议 ID 幂等、一次回应、同一生活对话 basis 与 opening 的去重仍是领域硬门禁，不由分数替代。

### projection/ —— 只读观察

- `projection/capability-milestones.ts`：v2 纯可回放因果观察器；含 120 个精确地图坐标和 17 个 world-specific 复杂事件，并以 strict/guarded、阶段门槛和完整 episode 隔离误报，事实不反向进入人物决策。
- `projection/core-milestones.ts`：旧 numeric-ID 观察规则，保留作迁移参考；运行时投影已由 capability observer 接管。
- `projection/live-speech.ts`：把每个已完成且具有可解析真实听者的口头沟通 ActionFact 投影为无显示文本的结构化 `speechAct` 草稿；只有已校验的模型台词才进入 `GameFrame.speechLines`，从不反写动作事实。
- `projection/society-world-cache.ts`：只读 WeakMap 投影缓存；复用静态 palette / biome，无体素变化时复用世界几何，有变化时仅复制并重算受影响列。

### 根级

- `character-profiles.ts`：人物档案池；开局按种子抽取 5–8 位或由配置指定。
- `population.ts`：开局年龄与寿命的确定性采样。
- `adapter.ts`：领域状态到 UI 读取模型的单向投影；事件活动按追加游标增量累计，实体查找在每次投影中建立 Map，缓存不写回领域状态。
- `kimi-decider.ts`：实时关键决策发送给通用模型端点的局部事实 DTO；包含人物档案、有效人格、身体、有向关系与有源近期经历，但不暴露隐藏世界事实。历史文件名保留，但不再绑定 Kimi 供应商。
- `simulation.ts`：供其他层依赖的稳定公共门面。

人物页主动对话由 `server/agent-interaction-gateway.ts` 调用 `interaction` 模型。玩家显式区分普通对话与“作为建议”：普通对话只拿到带 `sourceId` 的局部事实语义投影，固定为回答，不会形成行动输入；建议才额外拿到当前合法 choice，并在同一次模型回复中由 Soul、人格、身体、关系和记忆共同决定接受、保留或拒绝。语义投影不包含格子 / 体素坐标，把人物、散落物、容器、未完成建筑和当前可行方向分别表达；事实回答必须引用本轮来源，当前可行方向不能冒充永久技能。高置信定义询问若在本人知识、记忆与局部事实中没有来源，服务端直接回答不知道，不让模型训练知识越界。`accept` 必须绑定一个当下合法 choice，`consider` 只有真正选定 choice 才进入行动链。服务端当场按必须回应、履约与 follow-up 门禁校验，并保存稳定语义键；下一次可行动月份只在最新候选中本地唯一重配，不再调用第二轮模型重新猜 guidance。命中后才形成带 `sourceInteractionId` 的 DecisionFact / Intent；必须先履约时显示暂缓，条件消失或匹配不唯一时显示具体受阻原因。人物卡继续读取真实 Intent 与 ActionFact，把后来开始、被打断、做成或停下投影回原对话。聊天文字本身仍不写 `SimulationState`，普通问答、拒绝和没有 choice 的保留不会改变世界。

本地规划器是服务端人物行动权威，并在任何模型请求前先生成完整回退决定。模型设置页（`M`）选择模型演进并显式配置 `decision` 路由后，必须回应只在有两个以上合法 required option，或唯一 required option 带有两个以上语义匹配的 follow-up 时才交给模型重选；单一固定回应直接由规则提交。生活对话、空闲新方向、项目停滞或状态复核也必须确有多个合法方向才进入重选；选择本地演进时直接采用规则决定。开局、生存危险和既定履约不进入模型重选；后台快速演化始终只走本地规则。候选模型只能在当前合法 option 中重选，领域层会重新验证强制回应、复合对话的后续行动和意图组合；临时 option ID 只留在 DecisionFact 审计中，长期意图保存规则目标而不是模型文本。

实时月份中的说话先由规则提交为 completed `voice communicate` ActionFact，并投影为只含沟通类型、话题、提议、引用、立场与来源的 `speech-act-v1` 草稿；规则不再提供可显示原话，规则摘要也不再充当隐藏原话或文本相似度锚。尚无更细领域字段的客观陈述只把事实命题放入 `speechAct.subject`，不规定句式。决策阶段已生成合法模型台词时直接复用，其余草稿再按月进入同一 `decision` endpoint 的 speech-only 批次。主动人物对话、决策 utterance 与 speech-only 共用同一只读 Soul，避免同一个人在三条链路中出现三种性格。speech-only 模型从说话者有效人格、本月提交后的当前身体、对听者的当前关系、当前处境与有源近期经历中自主形成当下表达，这些值不是 action tick 精确快照；模型也只能表达该动作已授权的话题、立场和事实。成功且通过沟通类型与结构化立场校验的台词绑定原 ActionFact 进入 `GameFrame.speechLines`，普通陈述不再与规则句子做文本相似度比较；台词不覆写 summary，不写入记忆、关系、知识、意图或文明纪事。模型失败时仍保留沟通事实，但不显示文字气泡，已保存帧回放时不重新调用模型。

文明历史另先由规则层筛出出生、死亡、关键技术、项目完成等重大事件；选择模型总结时再调用 `narrative` 路由压缩本月纪事，选择本地总结时直接保留规则文本。没有重大事件的月份不产出纪事、不调用叙事模型，请求或校验失败时也保留规则文本。赶路、搬运、吃饭和普通失败只留在人物个人记录。意图的原子动作仍由规则引擎编译、预演、修复和结算；前端只能渲染读取投影，不能生成第二套地形、地点或道路。

乱纪元与恒纪元的每次真实切换都是文明历史的最高优先级事件，投影必须同时说明哪个纪元结束、哪个纪元开始。这组更迭事实由规则文本直接进入历史，不传给模型；同月其他重大事件的模型概括也会另外保留。

文明纪事在表达层按真实来源和业务语义归并：同阶段重复的冷热伤害不反复记史，对称的结伴或生育约定只显示一次，项目完成会覆盖同源的原子动作，放置与制作使用不同句式。归并只改变玩家看到的文本，全部 `sourceEventIds` 仍会保留。文明开端与结局由服务端写入史册，载入或恢复会话后不会消失。

服务端模型配置与 `ollama-chat / openai-chat / openai-responses / anthropic-messages` 路由见 [`../../../design/model-endpoint-routing.md`](../../../design/model-endpoint-routing.md)。

玩家本地存档、实时会话恢复、文明/分支/月份一致性和宇宙快照边界见 [`../../../../docs/player-save-v1.md`](../../../../docs/player-save-v1.md)。

实时 `step` 由 Worker 内一次 JSON 编码后以 transferable buffer 交给 HTTP 层。连续同分支月份只返回基于上一已提交帧的 `SocietyPatch`；客户端基线不匹配时重新读取完整 `state`，不会自行推演或补造世界事实。服务端历史帧仍由权威快照重放。

`three-body/data/eland.sqlite3` 是唯一持久化事实源；运行时没有文件或混合存储回退。表、codec、事务、备份恢复与 2026-08-20 切换审计见 [`../../../../docs/sqlite-persistence-v1.md`](../../../../docs/sqlite-persistence-v1.md)。`ELAND_PERF_LOG=1` 可输出规则推进、投影、快照、Worker 编码和持久化的分段耗时。
