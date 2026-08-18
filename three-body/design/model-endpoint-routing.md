# 通用模型端点与协议路由

状态：后端基础设施已实现；模型设置页（`M`）可分别选择当前文明的本地 / 模型演进与本地 / 模型总结。模型演进会把少量关键选择与人物话语交给 `decision` 路由；模型总结会让 `narrative` 路由压缩当前月的规则纪事，本地总结则原样保留规则投影。两项设置保存后都从下一个月生效。`strategy` 与 `strategies` 仍是后续文明策略任务的配置扩展位。后台快速演化继续只运行本地规则。

## 边界

模型端点属于可选基础设施。本地规划器会先为每个人计算完整决定；模型只能在人物可感知事实生成的合法候选中重选，并由领域层再次组合、校验后才创建意图。调用失败、没有密钥、局域网主机离线或结果非法时直接保留本地决定。模型返回的叙事仍固定为 `projection-only`；未来策略输出必须作为待验证建议，不能直接修改 `SimulationState`。

调用方只声明用途：

```text
decision / narrative / strategy
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

配置文件可分别保存 `"evolutionMode": "local" | "model"` 与 `"summaryMode": "local" | "model"`。旧配置没有这些字段时，显式的 `routes.decision` / `routes.narrative` 继续保持原有模型行为；设置页首次保存后会写入明确模式。后端在每个实时月份开始时读取两项设置，因此对当前文明立即生效而不需要重开世界。`summaryMode` 只控制当前月玩家纪事是否交给模型压缩，事实提交和原始规则投影不受影响。

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

实时筛选策略：

- 开局初始意图、身体危险和已经生效的履约由本地规则立即决定；
- 必须回应的社会选择，以及存在多项合法方向的生活对话、空闲人物新方向、项目停滞或状态复核，可进入模型批次；
- 普通批次受滚动人月额度限制；未被选中的人物始终采用同月已经算好的本地决定；
- 模型只能返回当前 `optionId`、必要的 `followUpOptionId`、简短理由和人物话语；领域层再次验证候选存在、强制回应范围及对话与后续行动的因果一致性；
- 结构化 `accept / reject` 的自然语言若改变立场，丢弃措辞并保留规则原话，协议事实不受影响。

实时调用默认最多等待 12 秒、最多输出 600 token，可用 `MODEL_DECISION_TIMEOUT_MS` 和 `MODEL_DECISION_MAX_OUTPUT_TOKENS` 调整。失败不会回滚月份。完成的月度额度账本记录 endpoint、协议、模型、调用数和 token。后台 `/evolve` 与实验矩阵不调用该实时路径。

## 实时叙事总结

设置页选择“模型总结”且 `routes.narrative` 指向已配置端点时，实时会话会把当前月已经由规则生成的事实纪事压缩成一两句投影文本。模型看不到写权限，返回文本也要经过内部字段、人物、场景和系统措辞检查；失败时保留原始规则纪事。选择“本地总结”时不发起该模型请求，直接展示规则投影。叙事增强旁车仍是独立、非权威的显式任务。

## 多用途和文明策略扩展位

`routes` 为每种用途选择默认 endpoint，同一个配置可同时保留 Kimi、局域网 Qwen 和其他 API。请求 `/api/decide` 时也可通过 `endpoint` 指定端点；旧 `model: "kimi"` 参数继续兼容。

`strategies` 当前会被加载和验证，可为未来文明策略定义 endpoint、附加系统提示、温度和输出上限。它还没有进入演化主链。后续接入时必须继续遵守：事实提交后异步创建任务、输入绑定来源事实、返回稳定语义建议、在本地规则中重新验证。

## 兼容与状态

没有设置 `THREEBODY_MODEL_CONFIG` 时，后端继续读取 `KIMI_API_KEY` / `MOONSHOT_API_KEY`、`KIMI_API_URL` 和 `KIMI_MODEL`，行为与原接入一致。

叙事增强 API 的响应保留 `providerConfigured`，并新增 `modelEndpoint`，返回所选 endpoint id、协议、模型和配置问题，但不返回密钥或完整请求头。完成的旁车任务同时记录 `endpointId`、`protocol` 和 `model`。
