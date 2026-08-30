# ELAND 人物 Prompt Contract v2

状态：v2 已接入月度决策、最终可见台词与玩家直接对话，稳定模板集中在 `three-body/server/agent-prompt-templates.ts`。本文记录人物决策与自然对话提示的结构，不用“多写几条禁止事项”替代人物状态、记忆与验证器。

文本“去 AI 味”只能辅助人工审阅生成结果，不是 Prompt Contract 的设计方法。Prompt 负责分配权威、提供情境和示范对话行为；“这个回复是否真的像人”最终由审阅者结合完整历史判断，不能外包给句长、词频、台词数量或格式通过率。

## 依据

OpenAI 的提示工程指南建议把 developer/system 指令按 Identity、Instructions、Examples、Context 分区，并用 Markdown / XML 划清动态内容；few-shot 示例需要贴近真实任务且彼此多样。Anthropic 的官方指南给出相同方向，并建议复杂 prompt 使用稳定、描述性的 XML 标签，优先告诉模型要做什么，而不是堆叠否定句。

角色 agent 的实现也呈现同一模式：SOTOPIA 将 agent goal、history 和 available actions 分开输入；Stanford generative-agent 的 utterance 模板只区分人物背景、对话历史、本轮任务和 JSON 输出。CPDC 2025 的对照实验显示，最好的 Rule-based Role Prompting 不是最长的自然语言指令，而是 Character Card / Scene Contract 加严格的 Action schema；其最终 dialogue prompt 明确分成 General Rules、Character Card、Scene、Recent Knowledge、Lore、Worldview 和 Dialogue History。

来源：

- [OpenAI Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [SOTOPIA](https://github.com/sotopia-lab/sotopia)
- [Stanford genagents utterance template](https://github.com/StanfordHCI/genagents/blob/main/simulation_engine/prompt_template/generative_agent/interaction/utternace/utterance_v1.txt)
- [Talk Less, Call Right](https://arxiv.org/abs/2509.00482)

## 两阶段合同

```text
Decision Contract
  Identity → Authority → Decision policy → legal options → JSON
                            │
                            └─ utterance 只是想说的意思

Voice Contract
  Character Card → Scene → exact parent line → evidence → final utterance
```

决策阶段决定是否说、对谁说、说话行为是什么、引用哪些本人来源；表达阶段只决定最终措辞、dialogue move 与 disposition。两者不能重新决定另一阶段已经拥有的权力。

## 稳定 Prompt 与动态 Context

稳定 system prompt 只保留：

- 角色与任务身份；
- 权威边界和优先级；
- 本轮 scene contract；
- 输出 schema；
- 3–5 个覆盖不同节奏的正例。

每轮变化的人格、Soul、关系、身体、记忆、上一句原话、合法候选和来源事实全部留在结构化 user JSON。静态前缀因此可缓存，人物私有上下文也不会混入 system prompt。

## Character Card

Character Card 不写“生动、真实、有个性”这类无操作性的形容词。它提供稳定人格维度、当前激活的一个 Soul facet、表达能力和本人长期关切。具体行为应由这些状态与 Scene Contract 共同得出，而不是由名字或现实原型推断。

人物姓名与结构化 ID 原样发送，不再换成 `P4 / P5` 或姓名占位符。这允许模型自然称呼，也允许名字带来有限的语气联想；Authority 仍要求本局没有提供的历史、技能、物品和关系不得被写成已发生事实。

## Scene Contract

Scene 明确提供当前听者、关系、天气与文明年龄、真实 speechAct、可引用经历、精确上一句和未解决 agenda。模型不需要从一段混合文字里猜哪些是事实、哪些是声音提示、哪些是输出规则。

## 记忆与长期关切

新发生、显著且未解决的亲历可以在人物仍有 active Intent 时触发一次长期审阅；审阅只记录“以后仍会影响选择的关切”，不会强迫人物立即放下当前工作。模型用 `sourceMemoryHandles` 引用当次 `m*` 记忆，网关还原为服务端保留的真实来源，application 再确认它仍是本人当下显著、未解决的记忆信号。

`create` 必须省略 `agendaHandle`；`revise / pause / abandon` 必须引用现有 `g*`。对当前确有关的小试验，probe 只能使用当次 held / visible / voxel handles，并精确区分 `observe / combine / expose / exert`；没有现实抓手的 aim 先进入 incubating，不伪造 Intent 或结果。

## Examples 与评估

示例只展示希望出现的行为，并覆盖低目的联系、直接回应、请求、试探、预测、沉默和结束；不能用五个同构“自然对白”让模型学到新模板。沉默与开口同样合法，但不再要求“非说不可”；陪伴、逗趣、缓和、确认关系和分享眼前小事本身就是真实动机。Prompt 修改必须固定模型版本，用相同输入夹具比较，并由人工判断回复是否真的接住上下文。格式通过率、事实越界和调用成本只是护栏。

2026-08-30 的第一次 12 月真实模型诊断只产生了 1 项 model-proposal agenda，且措辞接近示例、两次审阅都处于 missing-affordance。随后补齐 probe 句柄和执行闭环后，同种子 18 月诊断可产生 3～7 项 agenda，并把 observe / combine / expose 编译成真实 Intent 与 ActionFact；其中 response / no-response 能分别留下 supported / refuted 评价。较新的 18 月样本共使用 24 次 provider request、268,730 input token、7,778 output token，产生 8 次沟通动作与 588 次非沟通动作；这说明当前开销主要仍在决策上下文而非角色不停聊天。

这仍不是人物智能已经完成的证据。诊断同时发现：一是已有知识会让观察 Intent 在没有 ActionFact 时立即完成，旧逻辑曾把 DecisionFact 错当作支持证据，现已改为 parked；二是 refuted approach 的模型复盘曾被无关对话调用重置冷却，现改为按该次客观失败的月份计算，三个月后只保证一次有界复盘。

完成本地吞吐修复后，同种子 24 月真实模型审计产生 8 项 agenda、4 项多方法 agenda，并首次观察到一条完整闭环：孙悟空先尝试“石 + 食物”，真实 no-response 后保留 aim，模型随后改试“食物 + 铜矿石”，新方法被真实执行并再次被反驳；产物中的 `agendasWithExecutedModelRevisionAfterFailure=1`。本次共 32 次 provider request、350,921 input token、9,604 output token，11 次沟通动作与 587 次非沟通动作，沟通动作只占 1.84%。这证明协议已经能做到“重要记忆形成 aim → 合法 approach 真正执行 → 真实结果评价 → 失败后产生并执行不同 approach”，但只证明一条样本闭环，不证明所有人物都已智能。

该审计又暴露出 observe 语义过宽：模型可能用“观察草/土”包装与材料问题无关的推理，动作完成便被记为 supported。审计后已把所有 observe 结果改为“取得有源观察但结论未定”的 parked，三个月后再由模型解释；approach 文本由服务端按真实 probe 规范化，不能保留与动作不一致的漂亮计划；新 agenda 最短 6 个月，确保一次事实尝试和有界复盘来得及发生。这三项审计后修复只做了定向协议、执行和构建验证，尚未再次消耗真实模型做长跑。最终验收不能用 agenda 数量或文案自然度代替上述闭环，也不能把一次观察动作当成因果理解。
