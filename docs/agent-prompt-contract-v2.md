# ELAND Mental Act 与 Voice Contract

状态：当前协议。文件名为兼容旧链接保留 `v2`。

稳定模板位于 `three-body/server/agent-prompt-templates.ts`。

## 两个模型职责

```text
Mental Act
  决定目标、策略、假说、预期观察、当前试探和是否交流

Voice
  为已经真实发生的沟通动作生成最终原话
```

模型不再直接输出 `start / revise / optionId`，也不再拥有 `memoryConsolidation`。

## Mental Act 输入

```ts
interface MentalActRequestContext {
  person: CharacterCard;
  situation: LocalSituation;
  mind: {
    markdown: string;
    signals: NeedSignal[];
  };
  current: CurrentCommitments;
  visible: LocalPerception;
  availableSteps: CurrentStep[];
  continuations: CurrentStep[];
  possibleExperiments: OpaqueLocalHandles;
}
```

`mind.markdown` 是该人物唯一的模型可见记忆文档，固定包含“当前关切 / 经历 / 信念 / 最近思考”。本地写入器负责把已提交事实写回文档，本地编译器负责生成规则代码需要的瞬时 AST；模型只能阅读，不能压缩、删除或改写。文档中的 `m1…m6` 与 `g1…g4` 是当次请求句柄，超出范围的条目只作背景。

`availableSteps` 没有本地候选分数和隐藏失败原因。它只说明当前一步可以尝试，不保证目标最终可行。

`situation.planningTick` 出现时表示这是月内事件触发的再次思考。上下文已经包含此前 tick 的真实行动、对话和记忆变化；模型必须回应这些新事实，不能假装月份重新开始。每次输出仍只形成一项 MentalAct。

## Mental Act 输出

```json
{
  "kind": "pursue|investigate|talk|reconsider|continue|wait",
  "goal": "人物此刻真正想达到或弄清的事情",
  "strategy": "当前准备怎样做，允许不完整和可失败",
  "assumptions": ["尚未证实的猜想"],
  "expectedObservation": "采取下一步后预计亲眼看到什么",
  "evidenceMemoryHandles": ["m1"],
  "firstStepHandle": "o2",
  "continuationHandle": "f1",
  "utterance": "talk 时准备表达的核心意思",
  "groundingFactHandles": ["q1"],
  "concern": {
    "kind": "create|revise|pause|abandon",
    "agendaHandle": "g1",
    "importance": 60,
    "horizonMonths": 12,
    "reason": "暂停或放弃时使用"
  },
  "experiment": {
    "kind": "observe|combine|expose|exert"
  }
}
```

`goal` 和 `strategy` 是 concern 的内容来源，不在 concern 中重复。`experiment` 只能引用本请求的 held、visible 或 voxel handle。

## 失败边界

以下情况属于协议错误，可以立即要求模型修正：

- 非 JSON；
- 未知 kind；
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

- `create` 不带 `agendaHandle`。
- `revise / pause / abandon` 必须引用已有 `g*`。
- `pursue / investigate` 没有当前步骤时，网关可以用 MentalAct 的 goal、strategy 和来源形成一个 incubating concern。
- concern 不证明其办法可执行；experiment 不证明其预期成立。

## Character Card

稳定 Soul、有效人格、当前 experience 和临场 turn note 只调节注意、边界和表达。它们不创造知识、候选、物品、关系和能力。

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

- 同月最多 12 个人物 Mental Act 可以组成一个 provider batch。
- 每个 agentHandle 的私有心智和句柄严格隔离。
- 输出仍通过兼容 `decisions[]` HTTP envelope 返回；服务端内部把 MentalAct 编译为旧 Decision 壳。
- 已提交 MentalAct 与台词从历史回放，不重新调用模型。
