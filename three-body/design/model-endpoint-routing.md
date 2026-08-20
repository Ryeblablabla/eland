# 通用模型端点与协议路由

状态：后端基础设施已实现；模型设置页（`M`）可分别选择当前文明的本地 / 模型演进与本地 / 模型总结。模型演进会把少量存在真实选择空间的关键决定、实时月份中已经发生的口头沟通台词和本月后代取名分别交给 `decision` 与 `naming` 路由；模型总结会让 `narrative` 路由压缩当前月的规则纪事。本人物页的主动对话始终按需调用 `interaction` 路由，不受演进模式开关影响。`strategy` 与 `strategies` 仍是后续文明策略任务的配置扩展位。后台快速演化继续只运行本地规则。

## 边界

模型端点属于可选基础设施。本地规划器会先为每个人计算完整决定；模型只能在人物可感知事实生成的合法候选中重选，并由领域层再次组合、校验后才创建意图。人物台词只能在 completed `voice communicate` ActionFact 完成后绑定原事实生成，不覆写 ActionFact、规则 summary 或人物状态。调用失败、没有密钥、局域网主机离线或结果非法时，决策路径保留本地决定；台词路径保留沟通事实但不显示文字气泡。模型返回的台词与叙事固定为 `projection-only`。后代姓名是受限的已验证提议：出生先获得确定性保底姓名，模型只能提出 `givenName`，姓氏、顺序、字符、重名和一次性应用均由本地规则验收并记录在出生事实中；失败仍保留保底名。未来策略输出必须作为待验证建议，不能直接修改 `SimulationState`。

调用方只声明用途：

```text
decision（候选重选 + speech-only 台词）/ interaction / narrative / naming / strategy
                ↓
用途路由选择 endpoint id
                ↓
协议适配器构造请求并归一化文本与 token 用量
                ↓
任意 http(s) 域名上的模型服务
```

## 配置

复制 [`../model-endpoints.example.json`](../model-endpoints.example.json) 为 `model-endpoints.local.json`，再在 `.env.local` 中设置：

```bash
THREEBODY_MODEL_CONFIG=./model-endpoints.local.json
```

本地配置文件已被 Git 忽略。每个 endpoint 使用完整 `url`，所以不同用途可以指向不同域名、局域网地址或端口。当前协议值：

配置文件可分别保存 `"evolutionMode": "local" | "model"` 与 `"summaryMode": "local" | "model"`。旧配置没有这些字段时，显式的 `routes.decision` / `routes.narrative` 继续保持原有模型行为；设置页首次保存后会写入明确模式。后端在每个实时月份开始时读取两项设置，因此对当前文明立即生效而不需要重开世界。`evolutionMode: "model"` 同时允许关键候选重选、完成口头沟通的模型台词和本月新生儿提名；旧配置没有 `routes.naming` 时回退到 `routes.decision`。`summaryMode` 只控制当前月玩家纪事是否交给模型压缩。

| `protocol` | 请求协议 | 常用路径 |
|---|---|---|
| `ollama-chat` | Ollama 原生 Chat | `/api/chat` |
| `openai-chat` | OpenAI-compatible Chat Completions | `/v1/chat/completions` |
| `openai-responses` | OpenAI Responses | `/v1/responses` |
| `anthropic-messages` | Anthropic Messages | `/v1/messages` |

`auth` 支持 `bearer`、`x-api-key` 和 `none`。未显式填写时，Anthropic 默认使用 `x-api-key`，Ollama 默认无认证，其他协议默认 Bearer。`apiKeyEnv` 只保存环境变量名；实际密钥放在 `.env.local`。

`structuredOutput` 有两种取值：

- `prompt`：只靠系统提示约束 JSON，兼容性最好；
- `native-json`：使用协议的原生结构化输出字段。Ollama 使用 `format: "json"`，Chat Completions 使用 `response_format`，Responses 使用 JSON Schema；Anthropic Messages 当前仍依靠提示约束。

Ollama endpoint 可用 `thinking` 控制思考输出。叙事和结构化决策通常设为 `false`，避免输出额度被思考文本耗尽。endpoint 还可设置 `temperature`；局域网小模型的结构化决策建议使用较低温度。

## 实时关键决策与人物话语

设置页必须选择“模型演进”，并且配置文件显式包含 `routes.decision`，实时会话才会主动请求模型。旧 Kimi 环境变量仍可服务 `/api/decide` 兼容接口，但不会因为版本升级而自动改变现有文明行为。

候选重选路径：

- 开局初始意图、身体危险和已经生效的履约由本地规则立即决定；
- 必须回应只在同时存在两个以上合法 required option，或唯一 required option 需要 follow-up 且有两个以上语义匹配的合法 follow-up 时，才可进入模型决策批次；单一固定回应由规则直接提交；
- 其他生活对话、空闲人物新方向、项目停滞或状态复核也必须确有多个合法方向才进入重选；
- 普通批次受滚动人月额度限制；未被选中的人物始终采用同月已经算好的本地决定；
- 候选请求中的只读 Soul v2 与 HEXACO、需要、记忆、关系和风险一起参与模型在合法候选间的个人权衡；Soul 把稳定表达拆为 styleMatrix，并提供五个可按处境命中的 scene facet，每轮只激活最相关的一面；它不能生成候选、注入新事实或绕过必须回应、履约、follow-up 与物理校验；
- 模型只能返回当前 `optionId`、必要的 `followUpOptionId`、简短理由和人物话语；领域层再次验证候选存在、强制回应范围及对话与后续行动的因果一致性；
- 候选决定仍以 DecisionFact 进入权威历史；模型返回的台词不写入后续 ActionFact。

口头台词路径：

- 15 个 planning tick 和月末规则结算先完整提交；随后只扫描当月 `status === "completed" && action.kind === "communicate" && channel === "voice"` 且有听者的 ActionFact；
- 每个动作先投影为不含显示文本的 `speech-act-v1` 草稿，其中只保存沟通类型、话题、提议、引用、结构化立场与来源；规划 summary 不是对白模板，只作为“必须保留的意思”随请求发送并用于本地校验；
- 若该动作对应的已接受模型决定带有通过校验的台词，投影直接复用；没有决策需求的唯一合法回应和后续 tick 说话，按月进入同一 `decision` endpoint 的独立 speech-only 批次；
- 台词请求只读取说话者的档案、只读 Soul 与有效 HEXACO、本月提交后的当前身体和状态、说话者对听者的当前有向关系、当前处境以及有源近期经历；服务器先按 speechAct 话题与真实听者选择相关记忆，再用承诺、失败和一般重要性补足，并把年龄与 communication 能力投影为句式限制；核心 Soul 由人物 ID、baseline 人格和控制 / 地位敏感度确定性重建，只固定口吻与可激活侧面，不成为新事实或选择理由；这些人物值不是 action tick 精确快照，听者的私有记忆、隐藏知识和全局观察器也不进入请求；
- 人格、身体、关系和经历可以改变口吻，但只有本次 ActionFact 结构化内容与 `sourceFactIds` 授权的事实才能被说出；
- 只有成功模型文本才作为 `GameFrame.speechLines` 中的 `projection-only` 记录绑定 `sourceEventId`，不改写 ActionFact summary / result / diff，不写入人物记忆、关系、知识、意图或文明纪事；
- 结构化 `accept / reject` 的自然语言若改变立场，或批次缺项、超时、失败，该沟通不写入 `speechLines`、不显示文字气泡；普通陈述不再与规则摘要做文本相似度比较，ActionFact 本身始终有效。

实时候选决策默认最多等待 12 秒、最多输出 600 token，可用 `MODEL_DECISION_TIMEOUT_MS` 和 `MODEL_DECISION_MAX_OUTPUT_TOKENS` 调整。speech-only 服务每批至多 6 条、最多 3 批并发，默认每批最多等待 12 秒、整月所有台词批次合计最多等待 24 秒；可用 `MODEL_SPEECH_TIMEOUT_MS`、`MODEL_SPEECH_TOTAL_TIMEOUT_MS` 与 `MODEL_SPEECH_MAX_OUTPUT_TOKENS` 调整。取名只在本月确有出生时批量调用一次，默认等待 12 秒、输出 480 token，可用 `MODEL_NAMING_TIMEOUT_MS` 与 `MODEL_NAMING_MAX_OUTPUT_TOKENS` 调整。实现分别位于 `server/live-speech-service.ts` 与 `server/newborn-naming-service.ts`。

任一请求失败都不会回滚月份或撤销已经发生的沟通；取名失败只保留本地种子姓名。完成的月度 DecisionBudget 账本仍只记录候选重选的 endpoint、协议、模型、调用数和 token，当前不累计 speech-only 或取名 token；成功取名的 endpoint、模型、token、保底名与提议理由保存在对应出生事实。可见台词投影只记录 `source: decision-model | speech-model`；仅 speech-only 模型成功的台词另记录 `endpointId` 与 `model`。后台 `/evolve` 与实验矩阵不调用该实时路径。已保存的 GameFrame 与姓名回放时均不重新调用模型。

## 玩家主动人物对话

人物页“对话”子 tab 通过 `/api/eland/agent-conversation` 读取当前分支线程并发送消息。服务端从权威会话构造该人物带来源的局部语义上下文；前端投影不能作为模型事实来源。界面不区分聊天与建议，当前客户端统一发送 `requestKind=conversation`（字段仅为兼容旧记录保留）。服务端先保守识别玩家是否明确提出行动，再把角色回复与隐藏意图解析拆成两个模型请求。

- 第一阶段 `agent-interaction-reply-v1` 只生成 `reply + grounding + evidenceIds`。缺端点、缺密钥、超时或回复 / 事实依据非法时返回可见错误，绝不生成本地伪回复；模型误带的旧版 stance / choice 字段被忽略，不再拖垮合法回复；
- 旧配置没有 `routes.interaction` 或 `routes.naming` 时回退到已显式配置的 `routes.decision`，设置页下次保存会写出五种用途路由；
- 回复阶段使用 `MODEL_INTERACTION_MAX_OUTPUT_TOKENS=8000` 的默认上限；只有明确行动请求才追加 `agent-interaction-intent-v1`，其输出上限固定夹到 1000 token。等待上限都由 `MODEL_INTERACTION_TIMEOUT_MS` 控制，客户端不能提交任意 token 上限；
- 每轮回复都读取带 `sourceId` 的本人身体、当前动作、人格、只读 Soul、背包、知识与定向记忆、当前意图 / 项目摘要、可见人物和物资。服务器在同一请求前本地生成 `communication` 和 `personaFrame`：前者约束年龄与表达能力，后者只选择一个 scene facet，并引用按玩家话题 / 点名对象、承诺、失败与重要性选出的记忆；它不增加模型调用，不产生新内心事实，也不写回人物状态。事实性回答必须回传实际 `evidenceIds`，未知概念保持不知道；纯问题不暴露其他人物的 required choice，也不调用隐藏意图解析；
- “主”只表示稳定对话身份和本轮必须回应的对象，不自动赋予信任、亲近、服从、耐心解释或接受建议；这些态度必须来自 Soul、相关亲历与当前处境；
- 隐藏意图阶段只读取本轮玩家原话、已经生成的角色回复与当时合法候选，不得改写回复或补造未表达的承诺。只有回复明确接受玩家行动请求并唯一匹配一个合法 choice 才返回 `accept + choice`；解析超时、非法或无唯一匹配时静默保留回复且不形成行动。服务端仍当场校验 option、follow-up、必须回应与履约，并保存排除临时月份 / 表达 ID 的稳定语义 key；
- 下一次人物可行动时不再调用模型重新解释 guidance，只在最新候选中按原 ID 或稳定 key 做本地唯一重配。命中才提交带 `sourceInteractionId` 的 DecisionFact；必须先回应 / 履约时标为 `deferred` 并保留选择，候选消失或匹配歧义时标为 `blocked` 并保存原因；
- 对话、choice、结果、endpoint / model 和 token 用量随分支、热恢复与手动存档保存；新分支只继承分叉前历史，未落实 choice 不跨分支执行。

## 实时叙事总结

设置页选择“模型总结”且 `routes.narrative` 指向已配置端点时，实时会话会把当前月已经由规则生成的事实纪事压缩成一两句投影文本。模型看不到写权限，返回文本也要经过内部字段、人物、场景和系统措辞检查；失败时保留原始规则纪事。选择“本地总结”时不发起该模型请求，直接展示规则投影。叙事增强旁车仍是独立、非权威的显式任务。

## 多用途和文明策略扩展位

`routes` 为每种用途选择默认 endpoint，同一个配置可同时保留 Kimi、局域网 Qwen 和其他 API。请求 `/api/decide` 时也可通过 `endpoint` 指定端点；旧 `model: "kimi"` 参数继续兼容。

`strategies` 当前会被加载和验证，可为未来文明策略定义 endpoint、附加系统提示、温度和输出上限。它还没有进入演化主链。后续接入时必须继续遵守：事实提交后异步创建任务、输入绑定来源事实、返回稳定语义建议、在本地规则中重新验证。

## 兼容与状态

没有设置 `THREEBODY_MODEL_CONFIG` 时，后端继续读取 `KIMI_API_KEY` / `MOONSHOT_API_KEY`、`KIMI_API_URL` 和 `KIMI_MODEL`，行为与原接入一致。

叙事增强 API 的响应保留 `providerConfigured`，并新增 `modelEndpoint`，返回所选 endpoint id、协议、模型和配置问题，但不返回密钥或完整请求头。完成的旁车任务同时记录 `endpointId`、`protocol` 和 `model`。
