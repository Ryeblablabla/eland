# ELAND Mental Act 与 Voice Contract

状态：当前协议。文件名为兼容旧链接保留 `v2`。

稳定模板位于 `three-body/server/agent-prompt-templates.ts`。

## 三段职责

```text
Mind
  只形成意图，并发出唯一一句 utterance

Plan
  读取冻结意图，形成领域规划并选择当前可编译入口

Execution
  用本地规则把规划编译为 Intent / PrimitiveAction，校验并实现后果
```

Mind 不读取 `availableSteps`，Plan 不改写 Mind 的 goal、utterance 或 delivery。Execution 不替 Plan 选择另一个方向。兼容 `Decision / MentalAct` 只在服务端完成两阶段结果合并后形成。

## Mind 输入与输出

```ts
interface MindIntentionRequestContext {
  schemaVersion: 'mind-intention-context-v5';
  person: SemanticPersonBrief;
  situation: SemanticSituationBrief;
  origin?: {
    background: string[];
    initialIntention: string;
  };
  mind: {
    activeConcerns: string[];
    recentEvidence: string[];
    learnedConclusions: string[];
    relatedRecall: string[];
  };
  current: SemanticCommitmentBrief;
  recentDialogue: SemanticDialogueLine[];
  visible: SemanticLocalPerception;
  actionPossibilities: {
    availableNow: Array<{ kind: string; description: string }>;
    agency: string;
  };
  personalityPreset?: {
    type: MbtiType;
    name: string;
    summary: string;
    attention: string;
    innerTension: string;
    responseTendency: string;
    speechTendency: string;
  };
}
```

创世先民第一次形成方向时额外收到一次性 `origin`。`background` 只说明共同抵达、基本熟悉、随身物资与尚无持续工作等真实开局处境；`initialIntention` 从人物当轮性格注意方向确定性投影成宽泛初始意图。它不指定动作、配方或发展路线，Mind 仍需根据眼前事实把它具体化。第 2 月起不再注入，后续方向由真实经历接管。

人物仍以持久化 Markdown 作为本地唯一心智文档；请求投影不再把整份 Markdown、原始人格分数、身体小数、坐标和重复对象直接发给模型，而是确定性地拆成“当前关切 / 近期证据 / 已学结论 / 相关回忆”四个有界语义栏目。近期真实完成的普通行动在短期内也会作为证据保留，不必达到长期记忆的显著性阈值。句柄继续保留，服务端仍可把模型引用还原到精确来源。

Mind 还读取 `actionPossibilities`：这是由当前可编译步骤和动作空间归并出的粗粒度能力地图，例如“可观察具体对象”“可取得当前可达资源”“可交谈”“可继续现实项目”。它不包含候选句柄、具体步骤、排序或结果，因此只能阻止人物把当前不存在的操作当成立即可做，不能替人物选择行动。停留、休息和搁置始终是真实选项。

每个人物还从终身稳定的 baseline HEXACO 确定性取得一个 MBTI 角色写作预设。它位于单人 Mind 上下文末尾，只用抽象的注意、张力、反应与表达倾向帮助模型决定人物注意什么、怎样形成 goal、怎样说出 utterance；预设不再附带内容性的示例台词，避免不同人物反复模仿同一话题。这个标签不进入 Plan，也不改变能力、候选、合法性和世界后果。

身体储备、能力、关系、天气、物质外形 / 负重 / 刚性以及行动结果在进入请求前转成自然语言带宽，例如“当前不缺水”“动手操作能力普通”“坚硬而沉重的矿物外观”。精确数值仍留在权威状态与本地规则中，不因语义投影丢失。

Mind 输出只有意图与必要来源：

```json
{
  "utterance": "人物此刻形成的第一人称原话",
  "delivery": "whisper|normal|call",
  "goal": "人物此刻真正想达到、维持或弄清的事情",
  "orientation": "social|inquiry|survival|construction|acquisition|exploration|rest",
  "horizon": "momentary|ongoing",
  "evidenceMemoryHandles": ["m1"]
}
```

`situation.time` 说明月份和月内规划时刻。三体人没有与说话分离的私密思考；utterance 随最终 DecisionFact 传播。Mind 的 `current` 只含正在承担的事项摘要和社会承诺，不含执行进度、下一动作类型或项目材料状态。Mind 不输出 pursue / continue / wait、concern 生命周期命令、策略、实验、步骤句柄或本地规则结论。

## Plan 输入与输出

Plan 接收冻结的 Mind 意图，以及同一时刻的 current、visible、availableSteps、continuations 和 actionSpace。`availableSteps` 是 Execution 当前可以接纳的规划入口，不进入 Mind，也不是推荐排序；普通入口不设人为数量上限。Plan 必须保持 `orientation` 与 goal 的方向一致，没有直接入口时选择 `stay`，不能偷偷拿另一项合法行动替换。

```json
{
  "steps": ["领域规划步骤一", "领域规划步骤二"],
  "disposition": "act|continue|pause|abandon|stay",
  "firstStepHandle": "o2",
  "continuationHandle": "f1",
  "groundingFactHandles": ["q1"],
  "experiment": { "kind": "observe|combine|expose|exert|move" }
}
```

`steps` 按规划实际需要输出，不规定固定长度，也不增加“遇到第一项未知必须停止”一类协议规则。`firstStepHandle` 只是当前交给 Execution 的入口；现有 Intent / Project / HTN 负责把它编译为持续动作链并在每一步重新检查现实。

## Execution

Execution 沿用权威本地规则：解析请求句柄、建立或修订 Intent、逐 tick 编译 PrimitiveAction、执行并保存 ActionFact。它可以拒绝非法或已经失效的入口，但不能改写 Mind 意图、修改 Plan 文本或偷偷选择另一个方案。教学、预言、请求、提议、接受、拒绝等有世界后果的语言行动还必须由实际 `utterance` 明确表达；不匹配时只能保留为普通话语，隐藏载荷不会生效。

`delivery` 只改变电磁语言波的传播强度，不选择收件人。MentalAct 与 `talk` 都没有 `addressedTo`、`audience` 或 `channel`；任何人物是否感知、能否解码以及最终怎样理解，都在本地传播与解释阶段逐人结算。模型选择社会性 `talk` 时，ActionFact 复用 DecisionFact 的同一条波，不再额外说第二句。

## 失败边界

以下情况属于协议错误，可以立即要求模型修正：

- 非 JSON；
- 缺少 `utterance / delivery`；
- 不存在或跨人物的 handle；
- 必须回应时没有选择当前回应步骤；
- open conversation 使用了不属于该步骤的 grounding handle。

协议重试只说“格式或句柄不合法”，不能伪装成人物在世界中已经试错。

以下情况不得作为即时编译反馈：

- 材料能否结合；
- 建筑能否达到预期效果；
- 远处道路是否畅通；
- 容器或设施是否实际够用；
- 未观察对象当前是什么状态；
- 他人是否会同意；
- 长期项目最终能否完成。

这些都必须先生成观察、准备、询问或实际动作，再从 ActionFact 和人物可感知后果进入下一轮。

## Concern

Mind 不直接创建、修订、暂停或放弃 concern。它只用 `horizon=ongoing` 表明希望跨行动保留目标，兼容层据此形成 incubating concern；`momentary` 不会自动留下长期技术项目。concern 不证明其办法可执行，experiment 也不证明其预期成立。

没有入口或没有新结果的 concern 仍会保留在档案中，但不是下一轮的默认任务。没有新的相关 `recentEvidence` 时，Mind 被明确允许让它沉底并转向社会、探索、休息或其他生活方向，避免把“长期记得”误写成“每月必须继续”。

## Character Card

稳定 Soul、有效人格、当前 experience 和临场 turn note 先由本地投影为至多四条人物行为倾向，再进入 Mental Act 请求。原始人格数值、重复 Character Note 和完整 experience 不再常驻发送；语义化倾向仍只调节注意、边界和表达，不创造知识、候选、物品、关系和能力。

过去的 MentalAct 会进入 `mind.deliberations`，使人物能够继续或修正自己形成过的方向，而不是每次请求重新开始。

## Voice Contract

Voice 请求只发生在沟通动作已经真实提交之后。输入固定：

- speaker Character Card；
- listeners；
- speechAct；
- 已验证来源；
- 精确上一句和 recentDialogue；
- decision 阶段准备的 utterance（若有）。

Voice 只决定最终文字、dialogueMove 和 continue / close / rupture。它不能改变参与者、请求、接受 / 拒绝立场、承诺、知识和世界后果。

## 批量与回放

- 同月每个人物分别发起一次 Mind 请求；不同人物的上下文、人格预设和输出不出现在同一个模型请求中。
- 每项合法意图随后进入 Plan；多人 Plan 仍可按 agentHandle 批量调用，私有句柄严格隔离。
- 输出仍通过兼容 `decisions[]` HTTP envelope 返回；服务端内部合并 Mind 与 Plan 后形成兼容 MentalAct / Decision 壳。
- 已提交 MentalAct 与台词从历史回放，不重新调用模型。
