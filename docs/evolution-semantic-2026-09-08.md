# 语义步骤编译与 Qwen 短程试验（2026-09-08）

本轮连续演化使用局域网 `lan-qwen` / `qwen3.5:4b`。用户随后允许必要时少量调用 DeepSeek 做独立对照，正式演化仍以 Qwen 4B 为准；相关对照另记，不混入 Qwen 世界历史。目标仍是模型自主形成有后果的社会与文明，本轮重构和短程试验都不构成最终验收。

## 本轮重构解决什么

此前真实轨迹中，Plan 的文字说要询问同伴或试验材料，独立填写的 `o1/o2` 却指向观察、取材或另一项社交动作。编号格式正确并不能证明动作符合意图。现将主要链路改为：

`本人 Mind → Plan.currentStep（当前具体做法、真实对象、预期结果）→ World.nativeOperation → application 编译完整 ActionOption → 原生执行器 → 实际事件与后续认知`

Plan 不再另选一个与文字步骤分离的动作编号。World 将当前步骤绑定成有类型的移动、观察、取放、操作、发言、记录或项目请求；应用层复用已有过程与来源，保留目标、项目、记录、技术和准备步骤。最后仍产生真正的顶层 `move / attend / transfer / act / talk / inscribe`，使现有协议、知识、工程和记录后处理能够收到相应事实。开放组合效果仍保留，不能用 World 的成功描述替代实际执行结果。

涉及的主要实现包括 `application/native-operation.ts`、`application/model-decision/native-operation-context.ts`、`application/native-speech.ts`、`application/model-decision/social-proposal.ts` 和对应的模型协议。已有原生过程作为编译依据，不要求人物从菜单序号选行为，也不会在缺少材料或来源时凭空得到成品。

发言单独保持本人决定权：World 只请求执行 `speech`，具体原话、提议种类、当事人和条款来自冻结的 Mind。交换数量、期限、求助事项、共同体或规则等条款需要本人明确提出；接受、拒绝、退出、撤销和分享知识直接绑定真实引用。缺参时保留普通原话并返回具体编译反馈，不借用菜单默认的陪伴协议，也不因此封锁同时选择的身体行动。预测同样需要本人给出明确参数。一次已经执行的冻结原话不能在 Plan 续编中重复发送。

重构初期，普通 `assist` 协议只表达 water / food / shelter / company，不能完整表示“帮我扶住柱子”等任意共同事项，也不能自动把它改成 company。第六份样本前补入了保留本人原话与明确参与者的 `joint-action`，详见后文；这仍不代表任意任务已经具有可验证的共同成果或履行机制。显式 companion 约定地点已保留，不再被执行器默认地点覆盖。

## 第一份真实负样本

样本目录：`three-body/data/experiments/qwen-semantic-operation-seed31-20260908/`。

以文件为准：

- `provenance.json`：seed 31，从第 0 月初始状态运行至第 1 月，`resumedFrom: null`。端点为 `http://192.168.1.7:11434/api/chat`，协议为 `ollama-chat`。
- 冻结代码包 SHA-256：`fbf6229fee2f1aefbabf053de3bd2b25bc43e9565711a6fa607851761f368ab2`；初始状态 SHA-256：`fe64746222d633969bbc55752b425ce5c9b849a6dc7373a114ed4d0476d68526`。后续修改不能反过来算作这份历史已使用的新版本。
- `evolution.json`：实际运行时间为北京时间 2026-09-08 00:29:22 至 00:30:30，达到第 1 月后结束。
- `provider-calls.jsonl` 共 44 行，是 22 组 started / finished，而不是 44 次请求。实际调用为 8 次 Mind、11 次 Plan、3 次 World；全部是 lan-qwen / qwen3.5:4b，22 次 HTTP 状态均为 200，`done_reason` 均为 `stop`。
- `behaviour.json` / `agency-observation.json`：持久化了 3 次新 Mind 和 1 次 keep-current；没有 Plan 续编，没有顶层 ActionFact，也没有物理动作。状态中没有 intent、协议、共同体、造物或新知识；3 人存活，没有出生。
- `model-diagnostics.jsonl` 另记录 4 次 Plan 翻译失败，涉及柳如是、精卫各两次。提供者日志包含对应 4 次协议修复调用。

因此这不是网络或输出截断造成的空运行。模型返回了语言和结构化计划，但动作编译链路没有让它们进入真实执行。

## 人物意图如何停在编译边界

| 人物与来源 | 本人及 Plan 想做什么 | World 实际返回什么 | 最终事实 |
| --- | --- | --- | --- |
| 精卫；provider sequence 2 / 3 / 4；Decision `e-1-decision-jingwei-1-13` | 想找能遮蔽天气的住所；当前一步描述清点木材、石料，并询问同伴持物能否协助搭建。 | `nativeOperation.kind=move`，目标 `d3`，`withinDistance=0`，附 `references.projectHandle=project1`。绑定后目标为地面石料 `starter-1-2121`，项目引用为 `project-1-jingwei-shelter-capacity--function-weather-shelter`。 | `executionCompilation.status=unresolved`，错误 `missing-evidence`，字段为 `references`。没有执行移动，也没有取得清点或协作结果。 |
| 柳如是；provider sequence 5 / 6 / 7；Decision `e-1-decision-liu-rushi-1-12` | 想核实三人的资源，判断是否可以开始搭遮雨处；当前一步是走向同伴、示意清点并汇总。 | `move` 到 `p1`，`withinDistance=1`，附 `project1` 和 `native-source2`。绑定后是精卫及柳如是的遮蔽项目引用，来源事件为开局相识事实。 | 同样在 references 编译处 unresolved；实际没有移动或汇总物资。 |
| 尼尔·阿姆斯特朗；provider sequence 11 / 12 / 13；Decision `e-1-decision-armstrong-2-15` | 先核实同伴手中黏土、石头、木材数量，再判断共同建造的可能。 | `move` 到 `p1`，`withinDistance=1`，附 `references.projectHandle=project2`；绑定后是柳如是和尼尔的遮蔽项目引用。 | 同样 unresolved / missing-evidence，没有发生该移动。 |

三份持久化回执的具体错误都是：“当前没有与这些项目、记录或技术来源相符的可执行过程；需要核对具体来源及尚缺的材料或步骤”。直接卡点在携带来源的步骤请求与本地可执行过程的匹配，尚未走到地形、距离或材料的实际结算。不能把这类失败说成“人物尝试移动但遭到物理阻挡”。

另外 4 份 Plan 在一次修复后仍未形成有效决定，统一错误为“缺少合法的简短计划或行动引用”。日志能证明修复没有解决问题，但该错误没有指出具体字段；不能仅凭它断言某一个字段就是根因。例如第一批可保存和后续不可保存的 Plan 都填写了 currentStep.projectHandle，其存在本身不足以解释差异。

语义质量也仍未达标：清点资源不等于自己的食物库存达到某个数量，接近同伴也不等于获得其回应。柳如是的 Plan 将清点成果写成自己的食物至少 3 份及靠近两人；尼尔又把“两块黏土、一石、一木”描述成“至少 3 件”。这些都是模型期望或判据，不能作为世界已知需求、真实资源汇总或建造能力的证据。

## “0 动作”的统计边界

`behaviour.actions=[]`、报告 `communications=0` 指没有顶层 ActionFact / talk。三份持久化的新 Mind 仍各自产生了一次真实 `languageBroadcast`，且日志记录了其他人的接收结果。尼尔第一次还实际选择了 keep-current，没有产生新原话。

所以这份样本可以证明“模型能选择保留安排，且三次原话确实传播”，不能说人物完全没有发声；它同样不能证明任何交谈协议已成立、清点已完成或身体计划已执行。语言传播和动作编译必须分别检查。

## 验证边界与下一份样本

本轮已有针对原生语义编译与本人发言的定向回归。`test-native-speech.mjs` 验证显式交换提议先成为 proposed、另一人独立接受后才生效；知识发言产生听者待理解的 claim；缺参保留普通发言；预测参数及显式共同生活地点得到保留；同一冻结原话不会再次执行。上述是机制检查，不是自然社会行为已经出现的证据。

第二份 `qwen-semantic-preparation-seed31-20260908` 已结束，结果如下。两份均从初始世界单独开始，不能将它们与之后的修复拼成一次通过验收的历史。

第一份样本保留为负例。完整 Goal 仍未达成：这里没有设施功能、技术传承、多代后代或跨文明发展的连续证据。下一步应先让人物当前想做的具体事情正确进入执行，再依据短程结果决定是否扩展长程观察。

## 第二份真实负样本：动作开始执行，仍有错误反馈

`qwen-semantic-preparation-seed31-20260908` 从 seed 31 的第 0 月运行至第 1 月。开始于北京时间 00:48:07；冻结代码包 SHA-256 为 `d5fdec0f98acd4faeda565731ea1cfa2af11d50723403e70d94b437461fabaab`。这份版本放开了普通操作的项目背景引用，并修复附带 Plan 反馈导致有效步骤被丢弃的问题；它不包含下面列出的后续修复。

实际 129 次 Qwen 请求，43 Mind / 43 Plan / 43 World，没有服务端翻译失败。44 个模型决策机会产生 42 个新 Mind、1 个 keep-current、1 个 Plan 续编。仅有 5 个顶层动作事实，全部是 move：尼尔 1 次推进和 1 次到达，精卫 2 次到达，柳如是 1 次到达。没有真实取材、观察、造物、协议或出生，项目数仍为 0。

43 份编译审计中，22 份为带项目关联说明的已编译；7 份因为把 `self` 填成实物工具而 unresolved；6 份因为多附知识等来源而未匹配到整项能力；8 份没有符合指定距离的落脚位置或路径。22 份已编译不能算作 22 次动作：部分动作的到达条件本已存在，部分安排被新决定改变，实际行为必须看 5 份 ActionFact。

几个具体问题：

- World 的 sequence 36、72 把“拿取黏土、揉捏并搬石块”翻成 `act:combine`，对象和工具均为 `self`。当时 schema 误用通用实体枚举填写工具，执行器才在较晚阶段拒绝。这不是人物缺少双手。
- World 的 sequence 33、39 给移动附上 knowledge 引用。旧编译器把它理解为必须匹配完整学习工序，因而没有执行原本独立的移动。
- 编译器将完整 Plan 的第一段直接复制为原子动作摘要。尼尔实际上只移动，但 `recentlyFinishedWork` 却展示“拾取并揉捏黏土、搬石块、形成容器雏形”的 completed 摘要，污染后续认知。真实 ActionFact 的结果仍只记到达位置，没有材料变化。
- 项目关联说明以“未绑定项目工序”为重点，Qwen 在 sequence 35、71 将它误读成物理编译失败。必须清楚区分已编译待执行与 unresolved。
- 精卫的 `e-1-action-jingwei-34` 用“靠近柳如是 20 格、到访地形 5 格”作为“确认并准备能遮挡风雨的栖息地”的总体条件。条件在物理上成立，语义上却不足以证明有住所。`planAssessment.goal=satisfied` 在这里仅是模型自己写的代理判据成立，不能用于宣称目标或文明已达成。这一判据语义问题仍待处理。

## 依据负样本继续修复

后续源代码已将 native move 明确为身体移动：关联项目、记录、知识或协议不能令身体移动失效，也不能让一次移动暗中启动学习或项目工序。完整项目能力通过明确的 project 请求进入。普通动作摘要只描述真实原子操作，完整意图与步骤另存；关联说明也不再措辞成动作失败。

工具、仪器、容器和书写载体参数改为本次已点名的本人真实持物；徒手操作省略工具。生理和社会操作仍可使用 person/self 作为真实作用对象，未以工具约束取消这些能力。

Plan 的可选反馈现在接受本人真实编译失败 DecisionFact 的记忆作为来源；无根据的附带反馈被丢弃，不连带抹掉有效的当前步骤。定向回归从实际 unresolved 决策产生个人记忆，再证明修正步骤可被编译。

新增编译失败续编入口：失败发生在 Intent 创建之前时，按真实失败 DecisionFact 冻结原 Mind，月内只重新调用 Plan/World。没有占位 Intent、虚构 ActionFact 或重复原话。同一原意图下的相同问题不因进入下一 tick 自动无限续编；修改操作或出现新的实际行动结果可以提供新的依据。后来的新 Mind 也不会被旧 Intent 的续编覆盖。定向回归分别验证“修正后在当月完成真实观察”和“原样失败仅提供一次修正机会”。

持续目标也不再要求眼前手段本身必须持续数月。本人明确提出的 ongoing aim 可以绑定实际短暂移动或取材；有完整 Plan 时，局部库存或位置条件达到不直接关闭这个 aim，只有非空总体条件有实际 satisfied 结果才关闭。空总体条件保持未知。该修复仍不能解决上面模型自行写错总体代理判据的问题。

近期工作投影补入本人真实 ActionFact 的操作、结果与整体条件评估，同时按月内实际事件顺序选取最近经历，避免同月排序一直返回最早三项工作。执行前已有条件也单独显示，不冒充刚刚发生的观察或加工结果。移动原语的摘要、这些实际回执和完整 authoredPlan 分别保存。

上述修复还需下一份冻结版本的真实 Qwen 样本验证。单月失败样本和定向测试都不构成自然社会、造物积累或跨代文明发展的验收。

## 第三份真实负样本：发言与失败续编可达，社会仍空转

`qwen-semantic-feedback-seed31-20260908` 再次从 seed 31 初始状态到第 1 月，开始于北京时间 01:05:10；冻结代码包 SHA-256 为 `7566fd408560eac31ec170b5805e70bd993e4d43523aca0c4265809b862b4814`。该版本包含上述移动、摘要、真实回执、agenda 和无 Intent 续编修复，不包含之后的距离说明和判据语义检查。

实际 123 次 Qwen 调用，45 个模型机会，38 个新 Mind、5 个 keep-current、2 个 Plan 续编，没有协议翻译失败。26 份 ActionFact 为 24 次 talk 与尼尔的 2 次 move；没有取材、加工、造物、协议、共同体或出生。发言次数增加只能证明原生 talk 编译与执行通了，不能证明社会关系丰富。

40 份原生编译中有 23 份 compiled、14 份 context-association 背景说明、1 份缺少表达条款的可执行发言反馈，仅 2 份 unresolved。精卫的 `e-1-decision-jingwei-12-65` 确实根据 `e-1-decision-jingwei-11-62` 的编译失败在同月续编，引用原 Mind，没有 sourceIntentId 占位，也没有第二次 Mind 原话。这验证了新入口在真实模型链路可达，但这一次续编仍只是“靠近柳如是”，不证明已经取得回应或算清资源。

负面行为仍很明显：柳如是与精卫反复讨论两份食物的归属、补差价、凑齐人数和暂停搬运，未形成实际分工或物资转移。尼尔多次提出就地堆叠材料，却主要停在移动。World sequence 22 把移动到黏土的 `withinDistance` 写为 7，而当时距离正是 7；这表示允许留在原位置，并没有让本人接近材料。后续仅澄清接口含义：该参数是到达后允许剩余的最大间隔，不能照抄当前距离或当作行走步数，未设置任何强制建造目标。

语义判据问题再次出现：柳如是声称要明确资源归属、补差价和暂停搬运共识，Plan 的总体条件却仅是接近精卫 5 格。这与第二份样本的“住所=到访地面”同根。正在将充分性检查并入现有 World 调用：给它完整冻结目标、当前一步与 step/goal 判据，检查即使条件全真是否仍可能没有完成目标；不足或无法验证时保留实际动作，只将总体结果记为未验证。不会添加关键词门禁、文明脚本或新的模型评审轮次。

## World 判据检查与两次隔离重放

判据检查已接入现有 World 调用。`completionProposal` 带本人冻结目标、当前步骤及 Plan 提出的检查；World 可在原生操作或开放效果旁返回 `completionReview`。每项检查保存 `meaningReview`：`sufficient / insufficient / unverified` 及原因。生产 gateway 对缺失检查显式赋 unverified，Plan 自己填写的认证不被采纳。内核仍逐条计算实际条件真假，但只有语义检查充分且实际条件全真才认为对应目标满足。意见缺失、判据不足都不会删除物理动作或虚构失败。

同一冻结 Mind 的后续 Plan 可以纠正原先不足的判据；旧的错误条件不再被执行器强行永久冻结。总体自然语言目标仍保持本人原意。新造物从 produced-work 绑定实际实体会保留同组条件的语义检查。实际回执和近期工作的投影会把不足理由交回 Plan。相关定向检查覆盖了真实 assemble 在总体判据不足时照常发生、材料与事实保留，以及 Plan 自认证不生效。

隔离诊断目录为 `three-body/data/experiments/qwen-world-meaning-probes-20260908/`。两次均使用第三份样本保存的真实 World 上下文及它对应的 Plan，加入本轮语义检查协议和距离说明，以当前 World prompt 请求 Qwen；没有推进游戏状态。它们是定位接口的重放，不是新的完整社会验收。

- 原 sequence 110 的重放仍选择 speech，并明确给出“听见不等于同意，对方可能拒绝或无视”的不足理由。约 3.1 秒，输入 10408 / 输出 150 tokens。
- 原 sequence 22 的重放把移动到黏土的 withinDistance 从 7 改为 0，约 3.4 秒，输入 10971 / 输出 210 tokens。不过它判定造物条件不足时仍以“当前只是移动”为理由，混淆了当前执行阶段与假定条件全部成立的充分性检查。不能把这次说明当作判据语义问题已完全解决。

随后将 completionReview 放在原生操作之前，并澄清评审需要先假设所有给定条件成立，理由须针对具体条件覆盖程度，不能仅因当前尚未造完而判不足。仍使用同一次 World 请求，不增加循环评审或行为引导。

## 隔离技术诊断与人物经历

第二份样本结束时，柳如是、精卫、尼尔分别拥有 14 / 14 / 15 条 `memory:native-compilation`，以及 7 / 10 / 12 条 `plan-feedback` 知识。精卫在 sequence 10 的 Mind 请求同时看到重复的 compilationFeedback 和以记忆形式呈现的同一诊断。已确认这些内容污染个人记忆、已学 claim 和 Plan 修正；没有证据显示“编译／绑定／工序”等词直接进入真实 Mind 原话。

现保留 DecisionFact 的完整 compilation 和 MentalAct 的 Plan feedback 审计，停止将它们自动写成人物 episode 或带固定置信度的已学知识。Plan 可以直接用 `sourceCompilationEventIds` 引用本轮真实诊断，不需要先伪装成人物记忆。真实 ActionFact 的失败与 `rememberAction` 路径保持正常。

Plan/World 仍收到完整诊断；Mind 只看到最新本人决定确实尚未落实时的中性 pendingStep。成功编译的背景说明不会覆盖人物正在执行的动作文本，新成功决定也不会继续显示旧 pendingStep。诊断按 eventId 去重。定向联调确认这些变化不妨碍无 Intent 的当月续编。

`qwen-semantic-grounding-seed31-20260908` 的完整结果如下。

## 第四份真实负样本：没有假总体完成，仍有行动误译

该样本从 seed 31 初始状态至第 1 月，开始于北京时间 01:44:11；冻结代码包 SHA-256 为 `91b504ee439aafcd8294e1782a63ca081a661aab2fc07eb4374b5a4722552f9b`。121 次 Qwen 请求，37 个新 Mind、6 个 keep-current、2 次 Plan 续编，没有服务端协议翻译失败。

27 份动作事实为：23 次完成的 talk、精卫 1 次真实移动、2 次被物主阻止的 transfer、1 次以 self 为唯一对象而失败的 combine。39 份整体检查为 25 次 insufficient、14 次 unverified，没有再将近身位置或材料代理条件标成总体目标完成。三人的 `memory:native-compilation` 和 `plan-feedback` 知识计数均为 0，技术诊断分层在真实运行中生效。仍没有造物或生产积累。

尼尔明确提出了以 1 份食物交换柳如是 12 份木材的交换提议，截止月末为 proposed，只有提出者本人接受，没有另一方同意或实际交换。

两次被阻止的取物不能作为“自主盗窃社会已涌现”的证据：柳如是 sequence 22 的 Plan 只是请求对方展示、交接以检查食物；World sequence 23 却选择从精卫处直接拿取 2 份食物。精卫 sequence 28 也是向柳如是请求移交，World sequence 29 同样直接 transfer。物主抵抗是真实执行后果，但动作性质不是本人 Plan 明确选择的。此处的信任与恐惧数值还含执行器的固定关系变化，不能称为全部由模型自主解释的情感。

另有 12 份 unresolved 都是指定距离下没有落脚姿态或通路。多次请求把非体素实体的目标中心距离写成 0，身体占位让它不能重叠抵达。后续已将确实被占用或不可站立的实体中心转译成真实可接触邻位，保留原始 0 请求与实际落脚坐标，不伪造原中心条件已满足。显式体素精确空位的 0 语义和真正没有可达接触位置的失败保持不变。

## 请求与身体行动的选择权

先仅澄清 World 提示词，再用 `qwen-world-speech-probes-20260908` 重放上面的 sequence 23 / 29；两次 Qwen 仍选择 transfer，说明追加提醒没有解决这两个样本，负例已保留。

后续将当前步骤的性质交回人物自己的 Plan：`currentStep.kind` 明确选择 speech 或 physical。World 在 speech 下只能执行本人冻结的原话；physical 下保留原生物理操作及开放创造效果，包括本人明确选择的拿取或强夺，实际抵抗仍由执行器产生。这不是按词语过滤意图，也没有预定角色该合作还是偷窃，而是避免 World 把本人已选的发问改写成另一种行为。相关回归同时验证“发问不能变成取物”和“明确自行取物仍可到达原生执行器”。

## 用户授权后的单次 DeepSeek 对照

用户明确局域网只有 Qwen 4B，后续保持它为主要模型；随后允许必要时少量 DeepSeek 对照。实际只调用了 1 次 `deepseek-v4-flash`，目录为 `deepseek-world-speech-control-20260908`。使用与 Qwen 请求/取物重放相同的冻结 World prompt、场景、Plan 和 schema；提供者的结构化输出方式不同（Qwen native-json、DeepSeek prompt），所以不是严格消除所有变量的模型基准。

对照在北京时间 02:21:06 完成，约 2.4 秒，输入 11992 / 输出 172 tokens。DeepSeek 选择 observe，并正确指出两个 near-target 条件只能说明位置，不能证明对方展示或允许接触。它没有选择直接取物，但也没有忠实执行 Plan 的发言请求，因此这一次结果不能证明换模型就能解决行动选择权问题。

对照没有推进任何游戏状态，没有更改默认路由，没有成为 Qwen 演化的后备调用。之后两份正式试验仍使用 Qwen 4B 的冻结新版本，分别从初始状态开始。

## 第五份真实负样本：Plan 保留行为性质，仍主要重复发言

目录为 `three-body/data/experiments/qwen-owned-step-seed31-20260908/`。`provenance.json` 和 `evolution.json` 均记录从第 0 月至第 1 月，**这份实际只跑了一个月**，不能写成两个月。北京时间 02:42:02 至 02:51:39，`resumedFrom: null`；冻结代码包 SHA-256 为 `6d55b52fc6692d4a444ec42eb3abb8a28d161b4658b39bfe329ed108ce3a0d1e`，初始状态 SHA-256 为 `9f293bfa3f3db1df29937d4ca72260d62950580a7b530f2dee72b75791c30d84`。

提供者日志是 270 行、135 次真实请求：45 Mind / 45 Plan / 45 World，全部为 lan-qwen / qwen3.5:4b，HTTP 200、done_reason=stop。47 个模型机会留下 43 个新 Mind、2 个 keep-current、2 个 Plan 续编。45 份 Plan 选择 43 次 speech、2 次 physical；实际 43 份 ActionFact 全部是完成发言，没有身体动作。编译审计为 37 compiled、6 compiled-with-feedback、2 unresolved；最后两次均因来源不匹配，不能当作执行后的物理失败。

当前步骤性质现在不会被 World 从 speech 擅自改成拿取，但人物仍没有完成所说的物资操作。具体如 sequence 133 的精卫 Mind 原话是“我现在就去把 d2 那根木头和 d3 那边的三块石头搬过来”，目标为实际拿到材料；sequence 134 的 Plan 却选 speech，把第一步写成等待柳如是和尼尔将物资移交给自己。sequence 135 的 World 忠实执行了 speech。这个负例的偏差已发生在本人 Plan，不能继续归因于 World 越过步骤性质。

月末只有柳如是的 assist 食物求助、尼尔的 reproduce 提议各一份，均为 proposed，仅提出者接受；没有另一方接受或拒绝，更没有繁衍。43 份新 Mind 的总体判据评审为 42 insufficient、1 unverified，没有已验证的总体完成。项目、造物、容器、记录、共同体、新知识、出生均为 0，3 人存活。

## 两次 Plan 隔离探针：补充机制说明与缩减背景均未解决

`qwen-plan-delivery-probe-20260908/` 和 `qwen-plan-focus-probe-20260908/` 都重放第五份 sequence 134 保存的同一个真实 Plan 输入，不推进世界。两份 `input.json` 记录的编译包 SHA-256 均为 `1512161f25dc19405bacf62d038311b15189377d29c28a14185b7e5c574b4087`，与各自保存的 `runtime.mjs` 实际哈希一致。

- delivery：Plan 提示补充“本次 Mind 原话已随决定传播”的真实机制。北京时间 03:33:58 完成，7.090 秒，输入 12114 / 输出 613 tokens；仍选 speech，仍等待对方搬运，并把原话里的“我现在就去搬”解释成要求对方执行的指令。
- focus：保留相同的机制说明，再移除人物性格长文、未选关注事项、旧 authoredPlan 与旧判据评审，保留实际状态、结果、已学方法和来源。北京时间 03:42:32 完成，5.686 秒，输入 9318 / 输出 521 tokens；仍选 speech，改为先请求两人移交材料，理由是要先确认意愿。

两次均为 Qwen 4B，输入精简确实降低了这次请求的 token 数，但没有使该步骤进入亲自搬运。它们不能证明人物已开始行动，也不能证明压缩背景或再追加一句提示已经修复偏差。

## 第六份真实负样本：两个月出现取材，临时共同事项尚无回应

目录为 `three-body/data/experiments/qwen-joint-action-seed31-20260908/`。从 seed 31 初始状态独立运行到第 2 月，北京时间 04:14:39 至 04:39:48，`resumedFrom: null`。冻结代码包 SHA-256 为 `3980cf59587226db94957988f03b4e9418d39c68522f7ef31b6f94f89a45ad66`；初始状态 SHA-256 为 `48bef998a3670525301e036ff07b7adcbc81dfdd55f5326f38d933fe50060bee`。

该版本增加 `joint-action`：本人明确提出临时一起做的事情和参与者，summary 绑定实际原话，期限可省略。不能从未说出的 commitment、较大的 goal 或默认“十分钟”补合同条款；多人邀请各自回应，未听闻者不会直接得到协议引用。Plan 同时知道 Mind 原话会自动传播，但仍自主选择发言或身体行为。

日志共 514 行、257 次请求：79 Mind / 89 Plan / 89 World，全为 lan-qwen / qwen3.5:4b，HTTP 200、done_reason=stop。93 个模型机会留下 75 个新 Mind、4 个 keep-current、14 个 Plan 续编。89 份 Plan 为 63 speech、26 physical；实际 74 份 ActionFact 如下：

| 实际动作 | 第 1 月 | 第 2 月 | 结果 |
| --- | ---: | ---: | --- |
| talk | 42 | 21 | 63 次完成发言 |
| move | 1 | 6 | 6 次到达、1 次推进 |
| act:combine | 0 | 1 | 材料或目标不在近身范围，受阻 |
| transfer | 0 | 3 | 1 次成功、2 次受阻 |

这里有 11 次身体尝试；`agency-observation.activity.physicalActionCount=8` 只统计其中非 blocked 的 7 次移动和 1 次转移，另有 3 次受阻，不能混用这两个口径。`e-2-action-liu-rushi-64` 确实从地面木材堆 `starter-13-2373` 取了 1 份木材到柳如是手中。精卫的 `e-2-action-jingwei-55` 因物主持物不在无遮挡近身范围受阻，之后 `e-2-action-jingwei-78` 遭柳如是察觉并阻止；这些是实际取物后果，尚不能单凭计数认定自主偷窃语义已经通过验证。

89 份原生编译有 63 compiled、25 compiled-with-feedback、1 unresolved。柳如是第 2 月建立了一个 active 的 weather-shelter construction 项目，但没有完成项目、造物、结构、容器或记录；75 份新 Mind 的总体判据为 73 insufficient、2 unverified，没有已验证的总体完成。仍是原来的 3 人，0 出生、0 新知识、0 共同体。开始了项目、拿到了木材，与有了可用住所是不同的事实。

状态保存 36 份 joint-action：35 proposed、1 expired；19 份没有回应期限，另 17 份有明确期限。已过期的一份确实带 `expiresAtMonth: 1`，并非无期限邀请被自动过期。逐份对照提议 Action 的实际语言波，36 份 summary 均等于当次原话。所有协议都只有提出者接受，没有其他参与者接受、拒绝或形成共同成果。重复邀请数量增加反映的是未闭合的交谈，不能作丰富社会关系的验收。

## 原生发言缺少精确对话：已修机制，尚待新实跑

第五份 `state.json` 的 `memoryStore.items=[]`：43 次真实 talk 后，dialogue lane 和 exactUtterance 都是 0；sequence 134 的 Plan 请求也确实是 `recentDialogue=[]`。第六份并非完全没有对话记忆：共有 94 条 memoryStore 记录，其中 22 条 dialogue 均带 exactUtterance，另 72 条 prospective；但这不能说明所有原生发言已被正确保存。

确定断点在 `application/simulation/intent-execution.ts`：`applyDecision` 因 `immediateTalkConsumesDecisionLanguage` 跳过 `rememberDecisionLanguage`，以为紧接着的 talk 会处理同一句话。原生 talk 没有 UI speech-line 存储，也没有旧 `claim.conversation` 包装，因此真实波已经发出，精确对话 lane 却未建立。选择身体步骤时原有记忆入口仍可运行，解释了第六份存在部分精确对话记录，不能把问题说成模型完全没接收到语言。

现让每份真实 Decision wave 都经过已有 `rememberDecisionLanguage`，沿 sourceEventId 去重，不额外广播。`recent-dialogue.ts` 按同月实际事件时间与顺序合并 Decision 和后续 talk 的同一波，保留本人发言、确实听清的他人原话及本次再思考来源；最多四条，交给 Mind/Plan 的投影不再二次截成两条。旧对话仍经过个人可回忆性和精度衰减，合法的近期外部 committed lines 继续作为缺失存储的 fallback，不恢复多年以前已经淡忘的逐字文本。

`test-cognitive-reception.mjs` 的定向回归通过实际原生 speech 执行，核对无 UI store 时的 speaker、原话、source、连续四句问答顺序，同波不重复保存、不重复显示，远处未听见者不可读，近期外部记录可回退而远期逐字记录不能复活。此前 pendingPlan / keep-current 的回归仍保留。该修复晚于上述两份冻结样本，尚待新的完整 Qwen 实跑验证，不能把修复后的投影倒算进旧历史。

## 临时事项的生命周期投影与公开对象关联

第六份 sequence 10 的 Mind 已收到具体三人 joint-action、原话和 `replyBy: 未指定`，但同一投影还用了 electorate / support / opposition，并附通用的“未回应可能逾期、接受后未履行可能违约”说明。后续将临时事项改为 participantCount / acceptedCount / rejectedCount，区分“尚未回应邀请”与“已接受邀请”；没有回应期限就明确不自动过期，也不附默认履约期限或自动违约。缺少共同成果判据时，接受或一次动作不自动证明事项完成。原生发言摘要同时改为“发言：本人原话”，避免把原话描述的工作显示成已经完成。此处是领域事实投影修正，没有让任何人自动同意或优先回应；仍待新实跑观察其作用。

另一个已完成的定向接通是 `world-target-derivation.ts`：Plan 点名可见材料或人物时，World 可以引用同一次请求中已经公开的所在位置、承托表面、近身外显持物。只复用已暴露的真实 handle，并记录从哪个对象、哪种关系推得该引用；没有对应公开坐标就保留未解析，不补远处背包或容器内容。native 编译与开放 effects 使用同一套关联。

这部分验证已进入实际执行：`test-model-decision-context.mjs` 让 Plan 只点名眼前木材堆，World 用其已公开位置输出 consume 1 份木材和 assemble，经 gateway、applyDecision、executeActiveIntent 后确实产生 1 件 work，原木材堆数量减少 1。`test-native-operation.mjs` 还执行了对已选人物外显木片的真实观察，得到当前材料与数量，既未取得其物品，也未自动读到记录载荷或学会其中技术；持有人移远或物品消失后真实观察受阻。这证明公开位置和持物可以正确进入执行，属于指定输入的机制验证，尚不是 Qwen 自主组装出设施的实跑证据。

至此仍未达到用户要求的丰富社会和文明演进：最新完整历史只有两个月，缺少相互回应的共同事项、实际造物使用、技术传承、出生与跨代发展。后续新 seed 17 Qwen 样本应独立记录，不能把上述定向测试、隔离重放及不同冻结版本拼接成一次通过验收的连续演化。

## 第七份真实负样本：精确对话已进入记忆，意图仍会偏移

`qwen-dialogue-targets-seed17-20260908` 从 seed 17 初始状态到第 2 月，开始于北京时间 06:42:41。冻结包 SHA-256 为 `63cd8b8263cd573090a1ed24fffe35342b4734fe5e8cfef6afa1be423f9882de`，本次开始保留实际执行的 `runtime.mjs`，试验脚本也拒绝覆盖已有 provenance 的目录。该版本含精确对话、joint 生命周期投影和公开目标引用修复，不含下面的当次语言提交、Plan v4 与协议去重。

268 次请求全部使用 Qwen 4B（90 Mind / 89 Plan / 89 World），两个自然月共 83 个新 Mind、7 个 keep-current、6 个续编，没有协议翻译失败。第 1 月为 37 次完成的 talk、4 次完成的 move、1 次被物主阻止的 transfer；第 2 月为 39 次完成的 talk、1 次完成的 move、1 次完成的 attend。没有取材成功、造物或项目，3 人存活，没有出生。43 份 joint-action 为 38 proposed、5 expired，没有他人接受或拒绝。

精确语言记忆修复确实进入了真实链路：第 1 月结束有 86 条 dialogue/exactUtterance，第 2 月有 163 条，后续请求也携带实际听到的原话与事件来源。然而，记住话并不等于正确执行意图：sequence 10 木之本樱说“我负责拿木材搭架子”，sequence 11 Plan 却展开为先收集同伴食物。邻近两位人物此前确实谈过食物集中管理；Plan 混入他人的事项，不能把这些步骤当成樱本人已经选择的分工。

达·芬奇 sequence 13 将一次真实的物主抵抗解释成“触碰禁忌”，后续其他人物沿着这句话讨论静观、分工和安全距离。这不是编译器生成的全局禁令：其 m1 是娜乌西卡实际阻止未经授权取物的经历。应保留真实抵抗及人物的主观扩大解释，同时不能把反复讨论或自己声称“半小时已过去”算作完成物理观察或共同约定。

## 已发生的语言不再等待身体 Intent

本样本 sequence 10 的正式 joint-action 原话已经成为 `e-1-decision-sakura-kinomoto-2-17` 的语言波，随后被听者及樱自己的 recentDialogue 引用；但 sequence 25/26 的本人协议列表仍为空。第 1 月结束，该原始 Intent `intent-1-sakura-kinomoto-5` 仍为 suspended、nextAction=talk、actionEventIds 为空，找不到对应协议。sequence 7 实际是 expression，不能误作这份正式邀请的来源。

根因是先在 Decision 广播，随后依赖可被生存动作或新计划抢占的 talk Intent 才登记语言含义。现新增 application 的 `commitDecision`，按同一时刻的真实次序追加 Decision 与独立顶层 talk ActionFact，复用原 languageBroadcast，走既有协议、教学、预测等领域记录器。身体 Intent 独立执行，缺语言条款保留普通原话及诊断。keep-current 与原计划续编不再产生新语言；纯 speech 旧入口若使用同一原话，只引用这一个事实终结并进入现有续编队列。

生产 Plan v4 只安排语言以外本人要做的事，可以 stay、continue、pause、abandon 或 physical，并不要求一定动手。完整原话和本人声明的提议/回应由当次语言提交落实，不再排成一项重复发言工作。Plan 的人格文字去重，当前意图与他人话语、旧计划分清；Mind 中生存反应不再被命名为 ongoingCommitment，而是 ongoingActivity。

定向回归证明身体动作尚未执行时邀请已记为 proposed；改计划不会撤销已发邀请；另一人独立接受后才成为 active；同一句话只有一个实际来源，纯发言后可在当月续编。这些仍是机制检查，不是新版本真实社会验收。

## 新语言提交合同的两次 Qwen 隔离重放

`qwen-plan-declaration-probes-20260908` 保留第七份 sequence 11 / 35 原输入，替换为 Plan v4、已安排语言事件的说明、仅额外身体步骤的 schema，并去掉重复的本人原话和 Plan 人格段。没有推进世界，也没有调用 DeepSeek；这属于合同变化诊断，不是只变一条提示词的模型基准。

- sequence 11：约 4.1 秒，输入 8223 / 输出 329 tokens。Plan 改成靠近两位同伴，但仍先谈食物移交，未忠实保留樱本人拿木材的分工。此负例仍未解决，不能把 physical 标签当成正确行动。
- sequence 35：约 3.8 秒，输入 9683 / 输出 305 tokens。Plan 改为本人实际观察点名的木材与石块，没有再用向同伴复述代替观察；其判据为空，尚无实际 ActionFact，不能据此宣称观察已发生。

第七份第二月的 sequence 239 / 240 还分别达到 38930 / 40149 输入 tokens。只读核对发现 current.agreements 和 speechReferences 各展开同样 34 份协议（29 待回应、5 过期），两处合计 67496 字符，占各自上下文的约 84.5% / 83.2%。下一版将正文放在单一事实来源，保留全部协议引用与本人回应状态；不会截掉未回应事项或把历史失败删除来降低统计。新的连续运行尚待冻结后验证。

上述协议投影去重已完成：离线将同一规则作用于保存的 sequence 239 / 240 JSON，上下文字符分别从 79862 降至 53772（-32.7%），以及 81098 降至 55008（-32.2%）。两份仍各有完整 34 个协议、34 个 canonical 引用与逐项不变的 sourceFacts；10 条与真实来源原话完全相同的 summary 改成来源引用，听闻缺字造成的不同文本继续保留。这是离线字符数，不能写成新提供者 token 或智能水平的实测改善。

`qwen-declared-action-seed17-20260908` 已开始从初始状态运行第 1 月，冻结当次语言提交、Plan v4、act 参数角色和协议去重版本，仍只使用 Qwen 4B。待实际行为和对方后续反应形成后再记录结果。

## 第八份单月结果：取材可达，仍没有造物

`qwen-declared-action-seed17-20260908` 已完成，开始于北京时间 07:20:50，冻结包 SHA-256 为 `522c7549f70b8ba8c446f6bf7813f6ce44f4690568b404c5f234ad520c6865d5`。135 次 Qwen 请求为 45 Mind / 47 Plan / 43 World；43 个新 Mind、1 个 keep-current，没有成功提交的 Plan 续编，另有 2 次 Plan 翻译失败。

76 份顶层 ActionFact 需要按来源区分：43 份是当次语言提交的 completed talk；15 份 completed move 来自 survival-reflex（娜乌西卡 7、樱 8），不能计为模型规划成果。模型 Intent 有 5 次 completed move、1 次 completed attend、4 次 completed transfer 及 8 次 blocked attend。4 次 transfer 中只有樱的两次各取 1 份木材有效：`e-1-action-sakura-kinomoto-45` 和 `-53`，月末实际持有 2 份木材。达·芬奇的 `e-1-action-leonardo-95`、`-113` 是 from/to 均为本人，旧执行器却报告“食物改变了持有者”，不构成真实物资流转或社会交换。

月末 20 份 joint-action 全部 proposed，没有另一方接受。3 人存活，没有出生，0 Work；樱有 1 项 active weather-shelter 项目。语言与身体独立提交已运行，但这些数据尚不能证明合作成立、结构建成或文明推进。

新负例明确暴露出剩余的接口问题：

- 达·芬奇 8 次 blocked attend 都将本人食物库存填写成 instrumentStackId，结果为“仪器观察必须提交来源绑定的校准或测量动作”。本人常只是想观察，World 却把任意持物填成仪器；不能把这种接口误译当成反复进行有效测量。
- 樱第 9 刻（provider 79 / 80 / 81）的 transfer 要拾取 d6 木材，却因附有仍 proposed 的 joint-action agreement1 在 references 编译处失败。该协议仅是背景，不是取得木材的许可或技术能力。木材当时还距本人 5 格，移除错误关联障碍后仍需真实接近。
- 12 个 unresolved move 中，10 个选用人物 public-position 派生的 v，另有被人物占用的掉落物位置和同位脚下表面。解析器丢失实体来源后把它们当成必须精确站入的体素，重新触发了身体中心占位问题；显式指定的精确空位与靠近实体应继续分清。
- 两次 Plan 失败及各自修复输出（provider 122 / 123 / 134 / 135）均为七个合法 targetHandles 中重复了 p1，没有未知引用。旧 sanitizer 因这一重复丢掉整个步骤。后续已将步骤对象集合去重，原始输出保留；原生 act 消耗同一库存多份材料的重复语义不受影响，真正未知引用也不被静默删除。

自转移现已返回准确的 no-change 回执，保留库存、ID、记录载荷和来源，不制造交付、学习或关系成果。总体判据在交给 World 之前也已绑定回冻结 Mind.goal，避免同时出现替代目标说明；原条件与独立评审仍保留。它们都是该冻结运行结束后的修复，不能反写进本次历史。

## 保留安排时也能表达与回应

第八份仍有 43 个新主意图而只有 1 个 keep-current。旧接口要求想说新话就同时生成新目标，保持原安排则必须完全沉默，容易令交谈反复替换身体计划。后续 Mind v7 新增可选 `keep-current.declaration`：本人可以保留当前安排并说一句新话、接受或拒绝已有事项，也可以仍然沉默或另选目标。

归一化的 Decision.declaration 没有新 Goal、agenda 或占位 Intent，仍只调用一次 Mind；使用同一当次语言提交与真实记忆入口。身体 Intent 与原 Plan 来源不被这句新话替换，已有实际结果可以继续触发同月续编。定向验证包括独立接受提议、无身体工作时仅发言、保持完整旧 Intent/agenda，以及无重复语言；尚未用新冻结版本验证 Qwen 是否自主采用此分支，没有设置采用比例或行为权重。

## 长程文明目标仍有功能层缺口

本轮只读审计确认动态 Work 的真实功能目前主要是几何、承托、遮蔽、磨损、观察与继续加件。Work 没有通用库存、加工周期或动力端口；新造物被命名为箱子、工坊或水车，不会据名字自动连接已有 ContainerState、材料加工或机械/电力网络。已有这些网络确有真实输入输出、消耗、负载与损坏，但开放 assemble/modify-structure 尚未把任意复合结构接入其执行机制。

制造与传承本身已有来源链：真实 consume/assemble 记录材料、布局和制造经历；分享后需要独立理解，刻写后需要实际阅读；后来 knownMethods 可重新绑定新材料再尝试。当前能够传播“怎样造出这个结构”，尚不能普遍传播并运行“这个新设施怎样持续工作”。完整 Goal 后续仍需要把真实 Work 身份、组件状态和可运行过程接通，依据实际运行回执记录功能使用，而非按名称解锁文明或靠叙述宣称现代化。

## 下一版的原生语义与显示修复

已完成第八份负例对应的接口修复：普通 transfer 的 joint-action/proposed 协议是背景，不产生授权、接受或履约；native move 使用原始实体或 Plan 明确选定的体素，纯派生的位置引用仍可用于搭建定位；仪器参数由当前真实测量/校准 descriptor 的对象与仪器配对提供。肉眼观察不自动变成测量，无依据仪器返回具体编译反馈。原生 parser 的具体问题现在会传回 gateway，替代不指明字段的泛化错误。定向检查保留真实距离、抵抗、显式精确位置和高级测量能力。

说话来源也补齐两处关联：协议 sourceFacts 保留真实语言源，recentDialogue.declarationReferences 仅按同一事件关联对应协议，不靠相同文字猜测，也不替人物决定回应；live-speech 投影按同一语言波读取 outwardDeclaration，不再要求声明依附身体 Intent。投影回归确认独立 talk、spoken keep 和纯发言均显示一次本人原话，额外台词提供者调用为 0。

15 次 survival-reflex move 的来源已查清：均因同一只可见野猪，9 次处于现有警戒范围内，6 次则已离开范围且动物仍 forage，却因为旧逃离 Intent 保存动物 ID 而继续后退。例如樱的 `e-1-action-sakura-kinomoto-103` 已在 6 格外，仍退到 7，下一次又退到 8。没有找到一个已经编译成功的 assemble/modify 被这些动作吞掉；被关联的原步骤均为 move，部分未能编译。

后续仅删除“旧逃离记录可越过现有警戒范围”的豁免，保留当前近身危险与真实追击；既有流程可在威胁清除后结束保护子意图并恢复原工作。没有新增距离或时长阈值，没有移除动物行为。定向执行验证了退离后恢复同一个原工作、近身和当前追击仍受保护。这仍不是模型聪明起来的实跑证明。

接下来将从第八份真实第 1 月状态继续至第 4 月，保留原经历、提议、库存和原始失败。新运行会记录自己的冻结代码及 resumedFrom；这种跨版本延续是恢复与持续执行的诊断，不是最终版本从零运行的文明验收。

## 第九份延续诊断：第 1 月至第 4 月

`qwen-continuing-society-seed17-m1-4-20260908` 已完成，从第八份第 1 月状态继续到第 4 月，开始于北京时间 08:16:49，冻结包 SHA-256 为 `13bdc73fecb0a4e03a2bd86207a61096ddb4fd2ffc91097c6ba1ba75f23fb2ff`。245 次 Qwen 请求为 75 Mind / 85 Plan / 85 World，没有翻译失败。三个新增月份共 67 个新主意图、8 个带声明的 keep-current、18 个成功提交的续编。新接口确实被模型自主采用，但不能由此推断建造或合作成功。

第 2 / 3 / 4 月分别有 37 / 7 / 31 次真实语言事件。模型身体动作合计 24 次完成的 move、26 次推进的 move、3 次完成的 transfer、2 次受阻的 transfer；另有生存反射的移动和一次进食。第 4 月末仍为 0 Work、1 个未完成项目；40 份共同事项为 24 proposed、16 expired，没有他人接受。3 人存活，没有出生。

### 同一个临时编号被重分配，造成真实往返

第三月娜乌西卡前 14 个规划时刻走了 36 格，主要在 `(22,18,7)` 与 `(27,18,7)` 之间往返。这不是远路或陡坡，也不能当成她主动反复搬运：World sequence 113 / 132 / 142 / 146 的 d5 是 `(27,18,7)` 的石块，而 124 / 138 / 144 / 148 的 d5 变成 `(22,18,7)` 的铁矿石。旧 Plan 文字一直保留“抓取 d5 处石块”，后六次甚至属于同一 Mind 的续编；感知列表按距离重排后，旧文字被重新绑定到另一物体。

后续生产世界对象引用已改为实体身份的确定性短摘要，体素引用由稳定坐标生成，不依赖进程缓存、列表排序或视距排名。自身/他人看到同一持物使用相同身份引用，归属依据实际 owner；消失对象的引用不再复用。定向真实续编验证：移动/重排/对象增删及序列化重建后，旧原文仍引用同一 dropId。旧临时编号没有做自动兼容或回填，因此下一份从新世界开始。

时间层也需分清：本例平地 5 格路线成本 11，分两个 episode 走 3+2 格；不是一格一个 tick。当前定义是每月 15 个 activity episodes、名义 120 effort，没有米/秒或格距换算。一次动作提前结束后的剩余额度尚未继续利用，娜乌西卡前 14 个片段仅花 75.362 effort（名义 112）；这是独立的片段取整问题，不能用提高速度来掩盖实体身份错误。

### 能看见材料与场地，却被引用范围排除

provider 115 / 116 中，Plan 写明本人提起 h3 铁矿石，但 targetHandles 只列 self/d1/d5。World 仍看见 h3×2，操作输入 Schema 却完全排除它，最后输出 move 到 d1。这里不能说“只有移动可选”，因为 d1/d5 仍可操作；准确问题是不能落实已描述的本人 h3 输入。

provider 106 / 107 中，樱、所选石堆及本人持物都指向 `(37,19,7)`；assemble 唯一可选的 v1 是脚下表面 `(37,19,6)`，归一化锚点仍被本人占用。邻近 v3/v32 已经展示，却不允许用于施工。执行器其实支持先让出自身位置再继续，故不能说造物绝对不可达；问题在于材料选择和施工地点被不必要地绑定。

后续 World 可从 self 明确选择本人的真实持物作为材料/工具，以 actor-possession 记录来源；施工可选择已展示空间，以 perceived-placement 记录来源。没有自动选料、消费或生成坐标，其他人的持物范围未整体放开；native move 仍不接受未显式选择的派生位置。实际回归已在 Plan 只点名 self 的情况下，由 World 选择第三件持物和邻格空位，真实消耗 1 份并创建 Work；未使用材料和位置没有冒充已使用来源。仍待模型自主实跑验证。

`qwen-stable-world-seed17-20260908` 已从初始状态启动三个月观察，包含稳定实体引用与上述资源/施工位置修复。本轮仍以 Qwen 4B 为准，没有新增 DeepSeek 调用。

## 第十份三个月负样本：引用稳定后，取材仍未发生

`qwen-stable-world-seed17-20260908` 已完成，从 seed 17 第 0 月独立运行到第 3 月，`resumedFrom: null`；北京时间 09:17:02 至 09:56:01。`provenance.json` 的冻结包 SHA-256 为 `ed3d4fcc2ee9890bd8bd321947085cd20d4e68b63ca54d7076157a19a9103d17`，与保存的 `runtime.mjs` 实际哈希一致；初始状态 SHA-256 为 `2c3093a410ef03ec393d6c3d3aeb42800d7acb1317d5db7ec75cd79719ba824d`。这是新世界，不承接第九份的人物经历。

`provider-calls.jsonl` 有 772 行 started/finished、386 次请求：135 Mind、129 Plan、122 World，全部为 lan-qwen / qwen3.5:4b / ollama-chat，HTTP 200、done_reason=stop。World 返回 103 个 move、18 个 observe、1 个 transfer；这些是模型请求，不是已发生动作。按 `state.world.past` 核对，真实 161 份 ActionFact 为 135 次当次语言提交、16 次 completed attend、4 次模型 Intent 的 completed move，以及 6 次 survival-reflex 的 completed move。没有真实 transfer、act、造物或完成项目。报告的 physicalActionCount=10 不包含 16 次观察，也不能将其中 6 次生存反射计为模型规划成果。

唯一 transfer 的真实链条尤其不能误解为“取木材被规则拦下”。provider 195 的 Plan 要向木之本樱请求石磨或锯子，并承认她手中实际是食物；provider 196 的 World 却选择从她的口粮栈 `stack-sakura-kinomoto-ration` 向达·芬奇取 1 份 food，附上狩猎项目、木材观察知识与开局来源。持久化 `e-2-decision-leonardo-9-62` 为 references / missing-evidence，未创建该转移 Intent，也没有对应 ActionFact。木材观察不是取食物的加工能力依据，删掉这项检查只会让错误取食发生，不能修复原先请求工具的意图。

第 3 月末，三人仍只各持有 2 份食物，地面木材 `starter-13-2371` 仍为 12 份，位置为 `(19,28,5)`。35 份 joint-action 为 22 proposed、13 expired，均没有其他参与者接受或拒绝。4 条知识均为普通观察，摘要仍是“持续观察了一个对象”；它们不是经过验证的材料工艺。Work、项目、容器、记录、共同体、出生均为 0。

这份样本还暴露了材料表达问题：World 看见“木材、固体、长条结构、quantity=12”，却没有看到数量单位及单份物性的解释，后续语言反复把它当成需要三人合抬的一根大木头。实际 transfer 的数量是可以分别取用的份数，普通取材候选中的 3 份也不是负重上限。不能根据人物说要抬木头，反过来认定世界存在一根不可拆取的超重整木。

## 两次 owned-attempt 隔离探针：本人开始写当前尝试，仍会假定不存在的材料

目录 `qwen-owned-attempt-probes-20260908` 保存 `input-1/result-1` 和 `input-7/result-7`，分别重放第十份 sequence 1 的达·芬奇、sequence 7 的木之本樱场景。两份 input 的 sourceBundleSha256 都指向上述第十份冻结包；实际新提示的 SHA-256 为 `95db33afe61168a09b33bb44354b16fced37961c573df9b0d0a92c9a58e385bd`。探针改变了本人决定合同，新增本人填写的 nextAttempt，没有调用 Plan/World、没有推进状态，也不是固定随机性的配对效果基准。

- sequence 1：北京时间 10:24:29 开始，约 3.9 秒，输入 10515 / 输出 254 tokens。达·芬奇仍提出共同营地，但另外写出本人先走到平坦地面、收集松石并堆墙基的 nextAttempt。它只是本人写下的打算，没有真实移动或墙基。
- sequence 7：北京时间 10:24:33 开始，约 2.7 秒，输入 10992 / 输出 131 tokens。樱写出靠近同伴、观察其持物并组合石头与木材的 nextAttempt，却仍称“手中的石头”；该 input 的本人持物只有 2 份食物。这是仍存在的事实假定，不能把新增字段本身当作执行质量已提升。

两次都是 Qwen 4B，HTTP 200、done_reason=stop，没有 DeepSeek 对照。后续正式版本让本人先写 nextAttempt、Plan 继承这次具体尝试，并将 World 外部的身体移动命名为 `walk-to`，内部仍是 move；该命名明确移动的是本人，不会搬动被指对象。

同批修复还把材料份数语义放进 Mind/Plan/World 的公共投影；普通 drop 观察改为当前材料、份数、位置及可见物性，并保留真实观察来源。明确的 native drop→self 取材可以在同一 Intent 中先接近、再执行原数量转移，准备 move 不计取材成功；来源按稳定 dropId 复核，消失不能用同地另一堆替换。定向检查验证了“已有 2 份，再取 4 份”、原物移位及消失等边界。这些机制检查不构成模型会自主选取、加工或合作的实跑证据。

## 第十一份单月样本：两人各取到一份木材，尚未加工

`qwen-owned-attempt-seed17-20260908` 从 seed 17 第 0 月独立运行至第 1 月，北京时间 11:02:22 至 11:14:03，`resumedFrom: null`。冻结包 SHA-256 为 `725e0b558ec4cca667e5b4161f1b387e632628423a791801cde1cb2400de168b`，与保存的 runtime 实际哈希相符；初始状态 SHA-256 为 `069c75c2de70ac8c64cddce1e90ccec049c48602d29ec2e0ba5e48f3b80442d2`。它包含上述本人尝试、walk-to、份数说明与取材续接，不能把它的结果算回第十份。

129 次 Qwen 请求为 45 Mind、45 Plan、39 World，均 HTTP 200、done_reason=stop。45 份本人决定均保存 nextAttempt；Plan 为 39 act、6 stay。World 请求是 16 walk-to、18 observe、5 transfer。真实 69 份 ActionFact 则为 45 次语言提交、15 次 completed attend、3 次 Intent 的 completed move、4 次 survival-reflex 的 completed move，以及 2 次 completed transfer。39 份原生编译有 5 compiled、29 compiled-with-feedback、5 unresolved；编译通过仍不等于每个请求都已执行。

`e-1-action-leonardo-51` 和 `e-1-action-nausicaa-125` 各从 `starter-13-2371` 取 1 份木材，分别进入达·芬奇和娜乌西卡的库存。原堆由 12 降为 10，樱尚未取到木材。真实观察开始留下“木材共 12 份/11 份、位于（19，28，5）、单份长条结构”的摘要；本人对人的普通观察仍有旧通用文本。没有一次 act 加工、assemble 或新 Work，取到原木不能证明完成了纤维分离、强度测试或粘合剂试制。

月末有 2 个 active 项目：达·芬奇的 safer-hunting inquiry、娜乌西卡的 weather-shelter construction，均未完成。12 份 joint-action 全部 proposed，仍只有提出者接受。3 人存活，0 出生、0 功能设施、0 容器或记录。nextAttempt 已进入真实链路，但连续合作、有效实验与设施成果仍未出现。

## 第十二份同源续跑：保留第 1 月，继续到第 4 月

`qwen-owned-attempt-seed17-m1-4-20260908` 于北京时间 12:29:37 至 13:17:22，从第十一份第 1 月 `state.json` 继续至第 4 月。它与第十一份的冻结包 SHA-256 都是 `725e0b558ec4cca667e5b4161f1b387e632628423a791801cde1cb2400de168b`，两份实际 runtime 哈希也相同。`resumeContinuity.sameSourceAsParent=true`、`sameProviderAsParent=true`；`stateSha256BeforeBoundaryExtension=ebfe413870a489eb3e10befd92cf988766045010b74459b838dd9c8a190dc9cf` 与第十一份保存状态的文件哈希一致。延长观察边界后的 initialStateSha256 为 `a48574928aaf68b48b080e933e780c8f2ad89f1c7ae6500c9b133333f7f75419`，不能因这两个状态哈希不同就说人物或材料被重置。

这次是与第九份跨版本诊断不同的同代码、同模型历史续段，保留既有事件、库存与约定；仍不是文明目标验收。新增第 2～4 月共 397 次 Qwen 请求：135 Mind、135 Plan、127 World，均 HTTP 200、done_reason=stop。World 返回 76 observe、25 transfer、25 walk-to、1 project。135 份模型决定没有成功提交的 Plan continuation；127 份原生编译为 6 compiled、78 compiled-with-feedback、43 unresolved。这里的 unresolved 是应用层编译结果，不能算成已经撞墙或加工失败的 ActionFact。

新增事件与累计报告的口径如下，全部来自实际 ActionFact：

| 动作 | 第 2 月新增 | 第 3 月新增 | 第 4 月新增 | 本续段合计 |
| --- | ---: | ---: | ---: | ---: |
| 当次语言提交 completed talk | 45 | 45 | 45 | 135 |
| Intent completed attend | 15 | 17 | 13 | 45 |
| Intent completed move | 1 | 0 | 0 | 1 |
| Intent completed transfer | 3 | 4 | 5 | 12 |
| Intent blocked transfer | 0 | 0 | 3 | 3 |

因此本段新增 196 份 ActionFact；`report.json` 和 `agency-observation.json` 的 265 份是第 1～4 月累计，其中 262 completed、3 blocked，包含第十一份原有 69 份。累计 communications=180 同样包括第 1 月的 45 份。不能把两个目录当成彼此独立的四个月与单月样本相加。

逐条校验这 15 次转移尝试后，只有 11 条为实际正数量移转，共 13 份：4 次从地面取木材，共 6 份；6 次把本人木材放回地面，共 6 份；另有一次从樱取走 1 份食物。以下回执需要分别解释：

- `e-3-action-nausicaa-32`（World sequence 154）请求把本人 3 份木材转给同一本人。实际 quantity=0、transferNoChange=true，回执明确木材仍在原位置。这是 completed 的无变化动作，不是物资交流。累计报告 personMaterialTransfers=2 也不能解释为发生了两次人与人交换。
- `e-4-action-sakura-kinomoto-21 / -30 / -38`（World sequence 275 / 278 / 293）都把本人真实口粮栈 `i39abrxssuyv0e` 指定为 source，却填入 materialKey=clay。输入的 heldObjects 明示 Food 2 份、Wood 1 份；执行器返回“来源中已经没有这种物质”。没有黏土产生，这三次受阻都不是授权门禁或他人抵抗。
- `e-4-action-nausicaa-109`（World sequence 374）确实从樱手中取走 1 份 Food，authorized=false、unauthorizedTaking=true；记录了真实争夺，取用者胜出。然而，娜乌西卡的原步骤是要求同伴把黏土和铁石放到木料上，World 把它译成了拿食物。这能证明实际持有者抵抗和转移后果进入了世界，不能证明本人自主形成了偷窃食物的意图，更不能当成所说的材料协作已发生。

其中樱的真实取木材 `e-2-action-sakura-kinomoto-85` 来自较早的项目决定 `e-2-decision-sakura-kinomoto-10-72`（World sequence 84），而执行当轮新 World sequence 99 的取食物请求因 references 编译 unresolved，并未取代旧项目步骤。不能把同刻最新的 World 候选当成这次 Action 的来源。所有木材取放都发生在 `cellId=2371,z=5` 的同一地面木料位置附近，也没有形成新材料、造物或运输网络。

第 4 月末娜乌西卡持 Food 3、Wood 0，樱持 Food 1、Wood 1，达·芬奇持 Food 2、Wood 1。三人均没有黏土、铁矿石或纤维库存；没有 act 加工或 Work，不能由“敲击”“摩擦”“获取纤维”的声明认定试验已经执行。2 个项目仍 active、0 完成；48 份 joint-action 为 29 proposed、19 expired，均无其他参与者接受或拒绝，也没有真实共同成果。报告阶段仍是原始部落，3 人存活，0 出生、0 功能设施、0 容器或记录。

### 评审文本又被当成经历，目标来源仍反复重置

本段 sequence 1 的真实 Mind 输入中，`current.recentCompletionReviews` 重新展开旧 World 的充分性理由，其中把普通观察解释成能够产生形变或断裂；`recentlyFinishedWork` 又将一份 actualResult 仅为“木材 11 份”的观察标为 overallGoalAssessment=satisfied。这些是模型判据及评语被重新展示，实际 ActionFact 没有加工产物。nextAttempt 与更明确的观察摘要并未阻止这类虚假完成印象继续进入本人认知。

sequence 1～3 还有独立的能力问题：本人选择双手压木材，Plan 把地面 drop 当成手中物且当前步骤仍写“准备”，World 最终只观察。冻结包中的 `executeExert` 确实只支持工具作用地表、工具作用材料与体素，以及对其他人物施力，没有徒手弯折本人持物的结算。原生参数形状反映了该能力缺口；只放宽 schema 或 references 不会产生真实施力。开放 effects 仍是另一条表达物理变化的路径，但这一轮没有走通。

同段 135 个真实 Mind 输入中，126 次 current.reconsideration.reason 为 heard-language，只有 3 次带 ongoingActivity、43 次带 pendingStep。因此不能声称 135 次都打断了正在执行的长动作：很多时候短动作已经结束，或新的原语尚未编译成功，随后全量新决定又取代了原目标来源。身体执行的中断与整体目标的反复重置是两个不同问题，本段没有 Plan continuation 的事实也不能靠增加移动次数来掩盖。

本段结束后，当前源码已从 Mind 投影移除编译评审全文及 goalProgress / overallGoalAssessment 状态，仍给本人真实操作、实际结果和执行状态；Plan 的来源审计与判据保留。该改动通过了定向 context 回归，尚未进入下一份真实运行，不能宣称已改善行为。本人输出改为分别表达声明与是否改变意图的接口也仍在调整，不能将未冻结版本算入本段同源历史。

截至这十二份样本及相关隔离诊断，仍未达到用户要求的自然文明演进。最新完整连续历史只有四个月，已有真实移动、观察、少量物资取放和一次被错误意图翻译触发的争夺；尚无自主完成并使用的设施、可靠加工与技术传承、相互回应的持续合作、出生或跨代积累，更没有从原始社会进入农耕、古代或现代文明的证据。短程机制接通、HTTP 成功、编译通过以及模型写下的完成评语，都不能替代这些结果。

## 第十三份跨版本续跑：本人只提交改变的部分

`qwen-mind-delta-seed17-m4-6-20260908` 于北京时间 13:41:08 启动，从第十二份第 4 月状态继续，于 14:15:19 完成第 6 月；`evolution.status=completed`、reachedMonth=6，保存状态也为第 6 月。冻结包 SHA-256 为 `2fcefc805cd2966bb85f49dbc064b4b81ba5c726a15eeecdd881548d025e2a08`，parent 为 `725e0b…168b`，sameSourceAsParent=false、sameProviderAsParent=true。原状态扩展边界前的 SHA-256 为 `b9ffa68539949ead326bf8103ac95abba549f77f3d68de2bfea0e4e762a626a7`。保留原经历、材料与约定，属于跨版本延续诊断，不是独立 fresh 样本。

本版本的 Mind wire 是单一变更对象：`{}` 明确保留并沉默，`{declaration}` 只提交新原话，`{intentionChange, declaration}` 才建立或修改本人意图。仍由本人决定，未加入措辞相似度合并、行为权重或强制继续。领域层复用已有 MentalAct / 独立 declaration / 原计划续编机制。新意图必须有本人原话，保持三体语言事实；Plan 不代写。此前的全量 provider 格式退出生产接口，直接 fixture API 未扩大兼容改造。

同时，Mind 的动作回执只显示真实操作、执行状态和实际结果，不接收编译器充分性评语或其 goalProgress / overallGoalAssessment 结论。Plan 审计仍保留这些信息以便修正判据。现有 schema、continuation、context 定向回归及 server 类型检查通过；没有新增完整 CI。真实请求已由 Qwen 接受：开头两次选择仅声明，第三次选择新意图。人物仍声称同伴持有并不存在的黏土、铁石，不能把新格式被采用解释为认知准确或文明进步。以下分别记录第 5 月检查点和整段完成结果。

### 第 5 月阶段结果：保留与续编被选用，身体成果仍少

北京时间 13:57:07 已保存第 5 月检查点；首次阶段核对时读取的 `state.clock.elapsedMonths=5`，`evolution.status=running`、reachedMonth=5，当时第 6 月尚在运行。以下先单列第 5 月，整段结果另列。保存的 runtime 实际 SHA-256 也与本段 provenance 的 `2fcefc…e2a08` 一致。

第 5 月账本有 49 个模型决策上下文、121 次请求，对应 provider sequence 1～121：45 Mind、38 Plan、38 World，121 次均 HTTP 200。持久化决定为 34 个新 Mind、11 个带声明的 keep、4 个原计划 continuation。这证明本人保留安排同时说话、沿原计划续编的入口在新合同下被真实采用；它不证明身体产出提高，也不能把“少建新意图”直接当成文明进展。

真实 ActionFact 共 57 份：45 talk、6 attend、6 transfer；其中 55 completed、2 blocked，没有 move、act 加工或造物。4 个 completed transfer 中仅有一次实际正数量移转：

- `e-5-action-sakura-kinomoto-14`、`e-5-action-nausicaa-93`、`e-5-action-sakura-kinomoto-101` 均为本人库存转给同一本人。请求依次为 Food 1、Food 3、Wood 1，实际 quantity 均为 0、transferNoChange=true，回执明确物品仍在原持有者处。
- `e-5-action-sakura-kinomoto-57` 实际把本人口粮中的 1 份 Food 放到 `cellId=2371,z=5` 地面。仅此一次改变物资持有位置，没有取得新材料或加工成品。
- `e-5-action-sakura-kinomoto-50` 指定 Wood 栈 `stack-sakura-kinomoto-13-2`，却要求转移 Food，因来源中没有所指材料而 blocked。
- `e-5-action-nausicaa-58` 尝试从达·芬奇的口粮栈取 Food 1；达·芬奇察觉并阻止，回执包含 resistedBy=leonardo 和实际 takingContest。它与上一条材料/栈不匹配是不同的阻碍，不能一起归因为授权限制。

第 5 月末仍为 0 Work、2 个原有 active 项目、0 完成项目，3 人存活，没有出生。64 份共同事项为 41 proposed、23 expired，仍没有其他参与者接受或拒绝。樱只剩 1 份木材，原有 1 份食物已经放到地面；娜乌西卡持有 3 份食物，达·芬奇持有 2 份食物和 1 份木材。此阶段仍没有有效的材料加工、设施成果或文明层级变化。

本段冻结后，当前源码另将 Mind 的本人持物投影改为逐个真实 stack 的 ref、名称、份数和可感知属性，不再仅按名称/外观合并而失去库存身份。目的是让本人当前尝试和后续参数能点名同一物品，未自动选材或替换错误材料。这项后续投影不在本段冻结包内，不能用它解释第 5 月表现，也尚不能声称降低了错栈或错材料。

后续版本也改善了本人明确点名库存的 transfer 失败回执：若实际栈仍存在但材料不符，说明实际物品与份数，以及本次所请求的材料与份数；该栈耗尽或消失分别报告。仅描述该本人库存，不列举他人隐藏持物，不改变库存、授权、选择或执行结果。现有 transfer 定向脚本验证库存/地面/记录不变及原因区别，通过；本段冻结包尚未包含这项反馈修改。

### 第 6 月及整段完成结果：没有新增物理产出

第 6 月有 50 个模型决策上下文、121 次请求：45 Mind、38 Plan、38 World；留下 33 个新 Mind、12 个带声明的 keep、5 个原计划 continuation，没有协议翻译失败。47 份 ActionFact 均为 completed，但其中 45 份是当次语言提交，另 2 份均为无变化转移：`e-6-action-nausicaa-79`、`e-6-action-nausicaa-106` 都请求把本人 Food 3 份转给同一本人，实际 quantity=0、transferNoChange=true。没有其他身体 ActionFact，也没有观察、加工、新材料或造物。

第 5～6 月整个冻结段的新增口径如下：

| 项目 | 第 5 月 | 第 6 月 | 本段合计 |
| --- | ---: | ---: | ---: |
| 模型决策上下文 | 49 | 50 | 99 |
| 提供者请求 | 121 | 121 | 242 |
| Mind 请求 | 45 | 45 | 90 |
| 新 Mind | 34 | 33 | 67 |
| 带声明的 keep | 11 | 12 | 23 |
| 原计划 continuation | 4 | 5 | 9 |
| completed talk | 45 | 45 | 90 |
| completed attend | 6 | 0 | 6 |
| completed transfer | 4 | 2 | 6 |
| blocked transfer | 2 | 0 | 2 |

242 次请求为 90 Mind、76 Plan、76 World，均 HTTP 200。新增 104 份 ActionFact 为 102 completed、2 blocked；6 份 completed transfer 中有 5 份 self no-op。整段唯一实际正数量移转仍是第 5 月樱把 Food 1 份放到地面的 `e-5-action-sakura-kinomoto-57`，不能把 6 次 completed transfer 当成 6 次物资流动。最终报告中的 364 completed、270 communications 是第 1～6 月累计，包含此前历史，不能写成这两个月新增产出。

最终仍为 0 Work、2 个原有 active 项目、0 完成项目；88 份 joint-action 为 59 proposed、29 expired，逐项核对 acceptedByPersonIds / rejectedByPersonIds 后，没有其他参与者接受或拒绝。3 人存活，没有出生。第 13 轮的 delta 合同让保留与续编路径被实际选用，但没有解决行为贫乏，第 6 月甚至没有一次正数量物资移动或新的身体观察，不能验收自然社会或文明演进。上面的逐 stack 持物引用与错材料回执修改均晚于冻结版本，没有进入这两个月，也尚无新的连续试验证明它们改善了行为。

### 第二次单请求 DeepSeek 对照：选择施力仍不等于可执行

`deepseek-world-force-control-20260908` 于北京时间 13:43:57 对第十二份 World sequence 3 的冻结 prompt、场景、Plan 和 schema 做了一次 `deepseek-v4-flash` 请求，耗时 4.290 秒，20,701 输入 / 222 输出 token。沿用温度 0，输出上限从原 Qwen 1,200 调整为 1,600；供应商结构化机制也不同，因此不是严格配对基准。没有推进游戏状态、改变模型路由或触发第二次请求。至此用户授权后的 DeepSeek 对照累计两次，其余这些真实运行仍用 Qwen 4B。

原 Qwen 输出 observe；DeepSeek 输出 `act/exert`，但将地面木料 `d3p6yokbzz4zbf` 作为目标、本人木料 `i2r8k0b4vzidod` 作为工具，没有实现原意中的徒手压本人持物。保存的原 schema 和 exert 子 schema 均验证失败：现有原生施力参数不支持该地面 drop 组合。它对完成条件给出的“仅持有或靠近不能证明已施力”理由更贴近原条件，但没有编译成可执行动作，也没有产生形变或造物。此样本说明不能将换模型后的动词选择当成能力已接通；原始输出与验证结果分别保留在 `result.json` / `validation.json`。

### 直接使用开放分支根 schema 的第二次 Qwen 格式探针

`qwen-open-force-root-schema-probe-20260908` 于北京时间 14:00:15 仅请求 Qwen 一次，9.272 秒、12,489 输入 / 343 输出 token。原 schema 没有 `$ref`，因此直接把原 effects 分支作为 schema 根，分支内容、原场景、人物目标、模型和采样参数均未改，保留上一探针的隔离诊断说明。返回同时通过原 schema 与本次根 schema；原始响应、实际请求及差异单独留档。

这次输出 `knowledge` 与 `world-state(structural_integrity=flexible_but_not_brittle)`，声称木料受压轻微弯曲、有响声而未断裂。它证明 Qwen 在该限制格式下能够写出合法 effects，但仍指向地面 10 份木料 `d3p6yokbzz4zbf`，没有绑定本人另持的一份木料。没有实际执行，没有材料、库存、身体、形变几何或断裂结算，也没有完成条件评审。所写的韧性属性与声响只是这一 World 候选的断言；不能记作自主选择了开放操作、实际测定断裂阈值或自然演进成果。本次格式限制只用于诊断，没有进入正在进行的第十三轮。

### 第一次 Qwen 开放分支隔离探针：没有进入 effects，无法评估开放效果

`qwen-open-force-probe-20260908` 于北京时间 13:55:33 至 13:55:45，只对第十二份 World sequence 3 的原场景做一次 Qwen 4B 请求，约 12.6 秒，输入 19602 / 输出 255 tokens。原场景与推理参数保留；在原 schema 根部新增 required effects，保留原 oneOf 位置与 JSON Pointers，同时更新嵌入的 schema 并追加仅走 effects 的诊断说明。该探针人为限定分支，不能用来证明模型自主选择了开放创造。

响应 HTTP 200、done_reason=stop，却仍返回 native observe，没有 effects。`schema-check.json` 验证响应符合原 schema，却不符合新增约束后的 schema，具体是根 required 缺少 effects。没有执行任何游戏动作，也没有力、形变、断裂或耗材结果可供核验。这次只能记为未遵循新增分支约束，不能据此判断开放效果语言是否足以表达真实施力。后续直接采用 effects 根 schema 的结果单独记录，不计作本次请求的重试或成功。

## 第十四份独立两月样本：合并 WorldPlan，仍未忠实落实本人尝试

`qwen-worldplan-mechanics-seed17-20260908` 从 seed 17 第 0 月独立运行至第 2 月，`resumedFrom: null`，北京时间 15:01:32 至 15:16:53。`evolution.status=completed`、reachedMonth=2，保存状态也为第 2 月；以下统计完整两个月。冻结包 SHA-256 为 `6aa5ddc6ef5a42492d309d86c9d266f6684783c656d4d7db5a240cb76a6b5ee1`，与实际 runtime 哈希相符；初始状态 SHA-256 为 `70066b41e3b88bfe1e523698b390ec77487afbf084aff633a16c0834a3c70eae`。本样本没有承接第十三份的六个月历史，不能把新旧月份或物资成果相加。

### 本次冻结的架构与物理能力

正式链路由 `Mind → Plan → World` 合并为 `Mind → WorldPlan → 原生或开放效果执行器`。独立于本人 Mind 的 WorldPlan 在同一次回应中输出 `{plan,resolution}`，保留完整后续计划、当前一步及对应的实际操作；本人 goal、nextAttempt 和原话仍来自 Mind，语言继续独立提交。原计划续编也走同一个 WorldPlan。计划与动作不再跨两次模型调用转换，但这不是额外增加了一份独立评审，不能仅凭合并宣称意图更准确。

枚举阅读说明（enumGuide）将反复出现的相同 enum 抽为完整有序字典，正文用 enumRef 指向字典；只压缩供模型阅读的字段说明，提供者 request.format 仍携带原始完整 JSON Schema。这项改动本身没有删除物理操作、改变允许引用或放宽实际验证。真实请求中已出现枚举字典和相应说明；不同世界轨迹之间的 token 总数不能作为它的严格配对效果证明。

本人持物现在逐真实 stack 展示稳定 ref；本人明确点名库存却请求错误材料时，失败回执会区分实际物品/份数与请求物品/份数，耗尽和消失另报。近期实际行动回执也带对应事件 ID，便于区分当次声明、所选操作和已发生结果，不靠文字相似来认定完成。

新增的 `material-mechanics.ts`、`actions/held-force-actions.ts` 为单个本人 held、无工具/体素的 `act/exert` 提供真实徒手弯曲：材料族采用明确的游戏归一化参数与单份名义几何，不将 hardness 冒充弹性模量，也不声称是 SI 木材常数；依据本人操控与身体状态计算载荷、弹性回弹、残余形变、损伤和断裂。断裂只把原来一份分成多个守恒的 segments，不凭空增加材料或生成工具。物态随人与人、地面、容器和自然掉落保存，受损材料不无条件并回完好材料；人物得到对这一份物品的定性受力观察，精确计算留在审计，不直接获授技术。

上述力学已通过实际原语的定向验证，包括石材弹性恢复、木料残余弯曲及后续断裂、一份守恒和状态转移保留。本次两个月主轨迹没有 act/exert、heldBend 回执或机械状态物品；不能把这些指定输入的机制验证写成 Qwen 已经自主施力、断木或发明工具。

### 两个月的真实调用与动作

provider 日志共 306 行 started/finished、153 次请求：90 Mind、63 WorldPlan，全部 lan-qwen / qwen3.5:4b / ollama-chat，HTTP 200、done_reason=stop。没有另外的旧 Plan/World 请求。账本与实际保存决定的口径如下；modelContexts 包含翻译失败，规则生存反射的决定另计：

| 项目 | 第 1 月 | 第 2 月 | 合计 |
| --- | ---: | ---: | ---: |
| 模型决策上下文 | 49 | 48 | 97 |
| 提供者请求 | 74 | 79 | 153 |
| Mind / WorldPlan 请求 | 45 / 29 | 45 / 34 | 90 / 63 |
| 新 Mind | 23 | 29 | 52 |
| keep（其中带声明） | 21（20） | 15（15） | 36（35） |
| 原计划 continuation | 4 | 3 | 7 |
| 翻译失败 | 1 | 1 | 2 |
| completed talk | 43 | 44 | 87 |
| Intent completed move | 1 | 2 | 3 |
| Intent progressed move | 0 | 1 | 1 |
| survival-reflex completed move | 4 | 1 | 5 |
| completed transfer | 4 | 6 | 10 |
| blocked transfer | 3 | 0 | 3 |

真实 ActionFact 为第 1 月 55 份（52 completed、3 blocked）、第 2 月 54 份（53 completed、1 progressed），合计 109 份。没有 attend、act、开放效果造物或新项目。4 次模型 Intent 移动与 5 次生存反射移动要分别归因，不能全部算作模型规划进展。

娜乌西卡的 `e-1-action-nausicaa-47 / -54 / -62` 从 `starter-13-2371` 实际取到 5、3、4 份 Wood。第三次原动作请求 5 份，但当时仅剩 4 份，执行器按真实存量结算；原堆的 12 份木材全部进入她的库存，没有新增材料。第 2 月她在 `e-2-action-nausicaa-47 / -55 / -85 / -92 / -99 / -106` 各把 1 份木材放到 `cellId=1949,z=5` 的同一地面位置，合计放下 6 份、自己剩 6 份。取材与放置真实发生，但没有生火、加工或设施结果。

`e-1-action-leonardo-26` 还确实从娜乌西卡取走 Food 1，authorized=false、unauthorizedTaking=true，存在双方争夺的 takingContest。它的来源决定 `e-1-decision-leonardo-2-20` 中，本人 nextAttempt 是评估材料搬运距离并等待对方携食物靠近，未明确选择偷取；WorldPlan 却把 currentStep 改成从两位同伴取食物。相近的 `e-1-action-nausicaa-24` 也把本人“提议交换、询问帮助”落实为直接取达·芬奇口粮，结果被他察觉并阻止。这两例的世界后果是真实的，但不能把错误翻译造成的未经授权取物当成自主犯罪语义已经涌现。合并调用尚未解决请求、等待与亲自取物之间的偏移。

### 引用失败不能靠合并范围掩盖

第 1 月 provider sequence 16 的 currentStep 只点名地面铁矿石 `d386ie3v9mu1nc` 和木料 `d3p6yokbzz4zbf`，resolution 却返回 walk-to 水体体素 `vg_q_4`。水体可在整体上下文中出现，但没有被这一具体步骤选为移动目标；该返回被绑定检查拒绝，没有对应移动事实。`model-diagnostics.jsonl` 记录了这次樱的翻译失败；第 2 月另有一次同类诊断。

没有把 resolution 的所有引用自动并入 currentStep 来消除失败。后述本人持物回放表明，这样会同时放行“步骤明确选手中木料，操作却走向另一堆地面木料”的错误，而不是落实原意。这里需要保持实际对象一致，不能将 format 合法等同于对象绑定正确。

同月 `e-1-action-nausicaa-70`（从 `stone-2365` 自取 Stone 3）和 `e-1-action-nausicaa-96`（尝试从该石堆给达·芬奇 Stone 1）都因真实近身取物条件不满足而 blocked。后续仅修正 native drop→self 的无路反馈：找不到可达接触位置时不再退回一个远距 transfer，明确区分“物资仍在但没有可达接触位置”和“原物消失、耗尽或材料不符”。它没有制造道路、瞬移或放宽触及距离，也没有扩展成给任何人的运输系统。这项后续修复不在 `6aa5dd…` 冻结包内，不能反写成上述石料尝试已经成功。

### 一次已完成的 held-intent 回放：新能力可用，模型仍选错对象与动作

`qwen-worldplan-held-intent-replay-20260908` 于北京时间 15:16:31 至 15:16:42，仅请求 Qwen 一次，约 10.6 秒，输入 21730 / 输出 793 tokens。它从第十二份旧真实选择 `e-2-decision-leonardo-1-9` 取得本人 goal/nextAttempt，配合第十一份第 1 月真实状态（SHA-256 `ebfe413870a489eb3e10befd92cf988766045010b74459b838dd9c8a190dc9cf`）和新编译器/力学做隔离回放；不另造 Mind，不推进主世界。回放 runtime SHA-256 为 `7a1c98fe0e26a2353d375b20208f1fc24bf51662978ad45d8dd623abf223acd8`，与其保存文件一致，不能混同主样本的 `6aa5dd…`。

返回符合构建时的 schema，却在 Plan.currentStep.targetHandles 点名本人木料 `i2r8k0b4vzidod` 后，又输出 walk-to 地面木料 `d3p6yokbzz4zbf`。绑定结果为“原生操作的类型、对象或来源引用无法绑定本轮实际内容”，offlineExecutionPerformed=false。没有实际施力、形变、断裂或断裂阈值测量；模型还把已持有木材的条件自评为足以证明压力测试目标，不能采信为完成。该回放运行在自动合并 resolution 引用范围的提议之前，后者也未获采用。

第 2 月末仍为原来的 3 人，0 出生、0 Work、0 项目，13 份 joint-action 为 12 proposed、1 expired，没有其他参与者接受或拒绝。娜乌西卡持 Food 1、Wood 6，樱持 Food 2，达·芬奇持 Food 3，另 6 份木料在地面。主轨迹虽有材料取放，仍缺本人意图忠实执行、实际加工、相互回应的合作与设施成果，不能验收文明演进。thinking 模式单请求对照另记，本节没有纳入或预判其输出。

### 同一 Qwen 4B 的 thinking 对照：预算耗尽，没有最终答复

`qwen-thinking-held-intent-replay-20260908` 先经只读 `/api/show` 确认模型报告支持 thinking，再沿用上一份 held-intent 回放的冻结实际请求，只把 `think` 改为 true、`num_predict` 改为 8192、超时改为 120 秒。没有修改目标、物资、人物或主试验配置，也没有调用 DeepSeek。

唯一一次推理请求从北京时间 15:29:37.057 至 15:30:47.124，耗时 70.066 秒；HTTP 200、done_reason=length，输入 21,728 / 输出 8,192 tokens。输出预算全部耗尽时最终 content 仍为空，thinking 有 32,966 字符。没有最终 JSON、可编译动作或离线执行，也没有重试；内部思考不能作为世界事实或行为成果。主试验已于 15:16:53.591 结束，因此该长请求没有与主试验推理重叠，不能将主试验的两次引用错误归咎于这次排队。

主配置仍保留 thinking=false。本样本仅说明在这份请求与预算下开启 thinking 未能产生最终答复，不证明该模式普遍无用，也不构成换模型或放宽实际结果标准的依据。后续重点仍是减少意图到操作的语义偏移，而不是把模型的描述、有效 JSON 或计算量当成智能证据。

## 第十五份独立一月样本：出现真实安装，仍需区分本人意图、项目流程与功能使用

`qwen-owned-modes-seed17-20260908` 从 seed 17 第 0 月独立运行至第 1 月，resumedFrom=null，北京时间 16:48:16 至 16:55:33 完成。`evolution.status=completed`、reachedMonth=1，保存状态也为第 1 月。实际 runtime SHA-256 为 `2c1671e637b4ae1be3ae6a3279af8a60837a438d18363c42f734d8647b36369f`，与 provenance 一致；初始状态 SHA-256 为 `069c75c2de70ac8c64cddce1e90ccec049c48602d29ec2e0ba5e48f3b80442d2`。这是 fresh 样本，不能与第十四份两个月的库存和动作累加。

### 进入本次冻结版的职责修改

Mind 在自己的 nextAttempt 之外明确提供 attemptMode 与真实对象引用，领域保存为 typed attempt；本轮新选择只出现 act 和 observe。初次观察范围由服务端附加 perceptionOnly，允许对选定对象观察或靠近，不把观察意图自动解释成取物、施力或启动整个项目。此标签由模型选择，程序并未证明它与本人原话、nextAttempt 一致。

`executionBasis` 明确表示复用本轮已描述的完整方法，绑定到领域内部 references；`backgroundReferences` 只表示本人已知的事实或共同事项。后者不参与完整能力匹配，不授予知识、同意或项目进度。普通原语没有 executionBasis 时直接编译，不因碰巧共享对象和动作而隐式继承项目或记录学习链；project 仍是显式高级入口。观察范围明确复用方法时，只执行该方法当前真实 attend 原子，保留测量、学习或核验属性与来源，去掉整条项目/记录流程及其后续动作；若当前还要取物或施力则如实反馈未编译。

合法 Mind 不再因为随后 WorldPlan 失败而被丢弃。人物 goal、nextAttempt、typed attempt、声明和来源保留，计划标为 uncompiled，后续可沿相同个人选择续编。技术诊断保留在决定审计，不能当作已经发生的身体行动或自动学会的世界知识。

初次尝试范围也不是永久锁定整个人生目标。`initialAttemptPerformed` 沿原始 Decision→Intent→实际 ActionFact 核对：观察必须有同源实际 attend，单纯靠近不算完成观察；act 的真实位置变化、正数量转移等可证明已经起步，语言、self no-op 或空回执不能代替。起步后继续同一人的整体计划，原对象消失时保留不可用状态，不将旧引用重新绑定到别的物品。对应定向检查入口为 `test-native-operation.mjs` 与 `test-model-plan-continuation.mjs`，覆盖依据/背景分离、观察原子保留、翻译失败保留本人选择、靠近不代替观察及真实起步后的续编；机制检查不计作模型自主行为。

### 实际请求、动作与物资

provider 日志共 75 次请求：40 Mind、35 WorldPlan，全部使用 lan-qwen / qwen3.5:4b / ollama-chat。45 个模型决策上下文包括 29 个新 Mind（15 act、14 observe）、11 个带声明的 keep、5 个原计划 continuation。一个 WorldPlan 上下文在首次回应及一次纠正后仍未绑定，但合法 Mind 被保留；不能因此把它扣成没有发生过的个人选择。

| 实际 ActionFact | 数量 | 结算情况 |
| --- | ---: | --- |
| 当次语言提交 talk | 40 | 全部 completed |
| 模型 Intent move | 4 | 3 completed、1 progressed |
| survival-reflex move | 3 | 全部 completed，单独归因 |
| attend | 2 | 全部 completed |
| transfer | 5 | 全部 completed，均有正数量移转 |
| act/combine | 3 | 全部 completed |

合计 57 份 ActionFact，56 completed、1 progressed，没有 blocked 动作。与此前只取放或站立的样本相比，本轮出现了真实材料安装，但不能把 40 次发言或 3 次本地生存移动算作模型施工进展。

5 次 transfer 共移动 6 份真实材料，没有 self no-op，也没有人物间取食物：

- `e-1-action-leonardo-36 / -51 / -75` 各从 `starter-13-2371` 取 Wood 1，合计 3 份；原 12 份木堆月末剩 9 份。这些属于同一已启动项目 Intent 的取材步骤，后续三次安装各消耗一份。
- `e-1-action-nausicaa-59` 把本人 Food 1 放到 `cellId=2286,z=5`，月末仍有对应地面食物。seq31 的本人输入已明确选择 act，并说要将手中食物放到草叶表面观察；WorldPlan 返回的来源、材料和放置方向与此一致。它证明放置发生，不能证明食物发生了质地改变、获得建筑性能或完成实验目标。
- `e-1-action-sakura-kinomoto-95` 从 `iron-ore-1527` 取 IronOre 2，来源为 seq55 的明确两份请求；此前有真实靠近，最终没有把计划中期望的 3 份伪造为库存。后续 seq64、65、73 仍提出取黏土，但没有实际黏土转移，不能把后续计划算作已到手材料。

月末娜乌西卡持 Food 1，樱持 Food 2、IronOre 2，达·芬奇持 Food 2。没有人在本样本实际取得黏土或石料，也没有冶炼结果。

### 守住观察标签不等于理解了本人动作

seq8 中达·芬奇 nextAttempt 是“就地取材尝试搭建简易堆叠结构”，原话也说要把石头和木头叠起来，但同一个 Mind 输出 attemptMode=observe。seq9 的计划正文继续写堆叠和垂直施压，执行范围却按观察标签处理。seq26 中樱同样一边说要捡材料、拼挡风架子，一边选择 observe。此类矛盾已经发生在本人输出内部，不能把后端遵守标签称为忠实理解了亲手操作，也不能据此把取材或施力永远判为不合本人意图。

`e-1-decision-nausicaa-9-76` 则展示了失败后的保存边界：seq44、45 的 WorldPlan 返回不能合法绑定的派生移动位置，诊断为“实体派生的定位锚点不能当作未明确选择的移动目标”。决定仍保留她关于食物接触草叶的 goal、nextAttempt、observe 对象和原话，plan.disposition=uncompiled；没有凭此生成移动或接触事实。本轮 34 份有执行编译结果的模型决定中，20 unresolved、10 compiled-with-feedback、4 compiled；另 11 份为带声明的 keep。没有 blocked ActionFact 不代表所有模型步骤都已落地。

### 三次安装的项目与作者边界

唯一 completed 项目是达·芬奇的 weather-shelter，Work 实体仍为 0。seq1、14、19 的本人意图是材料堆叠与承重试验；seq15 的 WorldPlan 首次选择当时的 project2（weather-shelter），产生 `e-1-decision-leonardo-3-31` 并启动 `intent-1-leonardo-6`。seq20 再次选择同一项目（本轮句柄为 project1），对应 `e-1-decision-leonardo-4-39`，随后发生首份木板安装 `e-1-action-leonardo-43`。

本人首次明确把简易遮蔽物、遮雨或挡风写入 goal/原话是在 seq36（第 7 个规划时刻，决定 e65），晚于首板安装。樱早在 seq6 说过挡冷风，达·芬奇 seq14 的近期对话也确实收到她的部分原话，因此不能断言住所用途完全没有社会来源；但现有证据也不支持“本人先决定造住所，再自行分解并执行设计”的因果叙述。

三次安装 `e-1-action-leonardo-43 / -67 / -80` 都来自同一项目 Intent。后两次分别在 seq37、47 新 walk-to 编译失败的同一时刻继续原项目。原生 construction 流程提供了固定的下层、上层、屋顶施工顺序，以及缺材取一份、返回工地的物流步骤；WorldPlan 选择了该高级项目，并非模型逐体素发明这套结构。可记录真实取材、三次安装及本人后来采纳遮蔽用途，不能将预置流程的完成当作自主建筑设计或文明演进验收。

### 旧住所判据与实际支撑、使用证据不一致

三次 combine 各把 Wood 1 消耗并安装为 Plank 1，位置依次是 `(20,28,5)`、`(20,28,6)`、`(19,28,7)`，月末三块板仍存在。前两块下面分别为草层和木板；第三块屋顶下方为空气，六个面邻居也全为空气，只与墙体斜角相接。不能因为有三个实体体素，就认定它们构成可承重的稳定住所。

只读调用本轮冻结 runtime 的 `shelterGeometryAt`，达·芬奇所在 `cellId=2371,z=5` 被旧算法识别为可站立的遮蔽位置：脚部、头部为空气，脚下草层，一侧封闭、三侧开口，protection=68、insulation=34；physicalStructureIndex 给出容量 1。娜乌西卡和樱的实际位置没有遮蔽。副本移除三板后，该位置仍可站立但不再识别为 shelter，说明这项几何分类确实依赖新增木板；它仍不是承重验证。在同一冻结 runtime 的隔离校验中，将这三个实际位置提交给 `planWorkLayout`，结果为 invalid-layout，“部分构件悬在空中”，明确指出屋顶 `(19,28,7)`。这暴露了旧项目施工路径与结构支撑校验之间的不一致，不能用 completed weather-shelter 掩盖。

报告指标中的 structureUseReceipts=3 也不能采信为三次入住或使用。冻结 `observePhysicalStructureUseReceipts` 返回的是 `e-1-action-leonardo-36 / -51 / -75` 三次取木 transfer，全部早于最后屋顶 `-80` 建成；它们仅因发生在该位置且 quantity>0 被算入。实际 shelterUse 事件为 0，本月是 temperate severity=1、clear intensity=1，没有真实天气减负结果。这些派生指标不能证明人物已经使用住所，更不能当作玩家可体验的住房功能已通过验证。

本轮月末仍为原来的 3 人，0 出生、0 协议、0 集体。出现真实安装不等于出现多代社会、共同履约或自然创造体系。后续新增的 body-support 使用能力不在本次 `2c1671…` 冻结包中；后续 direct-tool 设计也不能写成本轮已实施或已验证的能力。

### 第十五份结束后的修复：排除默认项目注入，统一支撑与使用依据

以下修改均晚于第十五份冻结 runtime `2c1671e637b4ae1be3ae6a3279af8a60837a438d18363c42f734d8647b36369f`。它们是下一版本的机制修复与指定输入验证，没有进入上述 75 次请求，不改变该轮三次安装、悬空顶盖、错误使用统计或未通过验收的结论。没有给旧世界补木材、补第四块板，也没有改写旧项目和历史 ActionFact。

模型上下文不再把 RulePlanner 尚未被人物选择、尚未进入 `state.projects` 的 `projectProposal` 展示为已知项目或已有方法。共享的 `known-project-capabilities.ts` 同时过滤模型 options/followUpOptions、native descriptors 与执行阶段 native compiler 的候选；否则，仅隐藏项目名称仍可能因 `executionBasis.sourceEventIds` 子集匹配而误选同来源的完整模板。可继续的项目必须真实存在，并有本人所属、实际参与、可见建设进展或已知请求来源。生产 `project` 必须明确引用其中一个项目，不能凭 `desiredFunction` 从词典开出住所或其他默认过程。普通观察、取放、加工、背景来源以及 WorldPlan 自写步骤与开放 effects 保留，新创造不要求先找到预制设施名称；领域本地 RulePlanner 的显式选择路径仍保留。

定向 native 回归使用 seed 17 实际生成的住所 combine 选项：本人有真实持木，候选与请求共享 founding 来源，但项目尚未建立。只填共享执行来源的普通 act 现在得到 missing-evidence，不能偷偷启动住所；同一原语仅携背景时仍可独立编译，不附项目或默认 project-completed 目标。随后经本地明确选择建立该项目，native 项目续做仍可编译。既有项目、记录和测量方法的定向检查继续通过。这证明了入口隔离，尚未证明下一轮人物会自行发明合适的方案。

支撑检查改为实际固体经六个面邻接连通到世界 `z=0` 固体根基。`solid-support.ts` 为住所几何、固定 combine 安装和开放 Work 布局提供同一类依据，不再把任意相邻浮块或仅斜角接触当成根基；查询按体素 revision 缓存，布局预检使用隔离的拟议修改。它仍是连通性模型，不是梁跨度、挠度或材料强度的完整力学计算。保留的本地住所流程也要先补墙顶连接块，再放内侧屋顶，因此这套形态需要四次真实安装、消耗四份 Wood，而不是用三份材料得到凭空相连的屋顶。`test-works.mjs` 用四份库存逐次执行四次 combine 后才取得完整遮蔽结构；该指定布局不是 Qwen 自主设计或第十五份原状态的成果。

物理结构索引新增 `geometryVersion=1`，与保存建造来源的 `projectionVersion=2` 分开。即使体素 revision 与月份没变，旧几何缓存也必须用已认证 `constructionRecords` 重算当前拓扑；无需每 tick 重扫历史，同版本、同 revision/月仍复用同一个索引对象。隔离检查 `qwen-geometry-cache-recheck-20260908/result.json` 读取第十五份状态副本：当前 `shelterGeometryAt=null`，原 capacity=1、complete=true 重算为两段 capacity=0、complete=false 的结构，三条建造来源不变。原 JSON 的运行时体素 revision 会在载入后归零，因此另用第二份副本仅对齐缓存 revision，专门验证“同 revision/月”的旧版本碰撞；该分支同样失效，历史前缀读取为 0。原始 state 文件校验前后 SHA-256 均为 `037a57d7356045dfcd3e25eb7bb01cea0c0b42f2f4a5c6650ac783a8b2097d76`，物资、体素和历史内容均未修改。这是当前功能重评，不能倒写旧 ActionFact 或宣布原项目从未安装过材料。

固定结构的使用证据只接受真实冷热结算当时的减负事件：`monthly-processes.ts` 在实际 cold/heat 负荷下降时捕获当时结构 ID 与建造来源，`observePhysicalStructureUseReceipts` 从该快照读取 thermal-protection。仅同地点取材、施工、观察或路过不再算使用，也不能用后来建成的几何追认旧位置事件。`test-works.mjs` 已验证建设与前置 transfer 的使用数为 0，temperate/clear 不生成热缓解；cold severity=4 的真实负荷下降生成回执。随后拆掉四块板，已发生的历史减负仍保留；同位置重建但来源不同的结构、没有当时结构快照的旧事件不能继承这条回执。

动态 Work 的 body-support 使用另由真实 move 的脚下支撑接触产生，绑定提供支撑的 Work、实际经过位置、ActionFact 与 cause，不以名字、接近或计划中想走过去作为证据。它与上述固定结构热缓解是不同的实际功能来源，也不能把生存反射的行走改记为模型自主使用。这里不声称所有站立和寻路逻辑已经完成根基连通校验；本次记录只限已接通的真实行走接触回执与已验证的结构支撑边界。

这些修改的相关 native/context、使用机制定向检查及 server 类型检查已通过；没有新增真实模型调用作为修复验收。下一份 fresh Qwen 运行的请求、产物和失败应另记，不能将本节的人工指定机制验证计入自然社会或文明演进成果。


## 第十六份独立一月样本：修正物理与归因后，仍没有实际建筑

`qwen-grounded-creation-seed17-20260908` 从 seed 17 第 0 月独立运行至第 1 月，北京时间 18:10:11 至 18:18:10 完成。冻结 runtime SHA-256 为 `23fe555ff253f643e5736be65c950e88a9ce204924b835dce264b442817adf6c`，初始状态 SHA-256 为 `deac12173aa0c4fd96a6d36c1f4cb9243abfea0cecb508245e0719e86d65055d`。包含上一节物理支撑、真实使用与未建立项目模板过滤；尚不包含之后的 Mind 直接操作改造。

全部 84 次请求仍为 lan-qwen / qwen3.5:4b，45 Mind、39 WorldPlan。50 个上下文包含 32 次新意图、12 次带新话的保留、1 次静默保留、5 次世界续编；1 次 WorldPlan 翻译失败保留了合法人物选择。32 次新意图的模式为 18 observe、11 act、3 wait。

实际 62 个 ActionFact 包含 44 次发言、13 次移动（7 模型 Intent、6 生存反应）、2 次观察、3 次 transfer；没有 act 加工、安装或开放造物。移动中 2 次仍为 progressed。唯一正数量转移是樱的 `e-1-action-sakura-kinomoto-47`，从真实 starter 木堆取得 Wood 12。`-54` 和 `-68` 都是同一人的木料向自己转移，diff.quantity=0，第二次被记录为 unchanged-retry；两者不能计作再次收集或搬运。月末每人仍持原 Food 2，只有樱多持 Wood 12；没有取得石头、铁矿或黏土。

模式与原话的冲突继续出现：seq20 本人选择“移动第一块石头至半圆弧起点”却标为 observe；seq52 要把地面石材拿到本人手中也标 observe。WorldPlan seq19 的说明要求拿铁矿与黏土，native sourceHandle 却选到木堆并指定 materialKey=iron_ore，执行没有变出铁矿。seq41、50、56 的本人原话开始提及手持尺子和测量半径，库存中没有该工具；这些台词不是工具存在或完成测量的证据。众人反复讨论半圆弧、缺口和抗风，但 state 中没有任何建造记录。

physicalStructureIndex 为 geometryVersion=1，constructionEventCount=0、structures=[]；Work、项目、shelterUse 都为 0。7 份 joint-action 事项均 proposed，没有其他参与者真实接受或拒绝；0 出生、0 集体。没有再出现旧模板的悬空“住所完成”，但这只说明错误归因已去除，人物的实际理解、亲手创造与有后果合作仍未达到目标。

这份失败轨迹推动下一次接口修改：把当前尝试与长期目标分开，人物直接选择已知原生操作；只有本人描述的新做法需要 WorldPlan 编译。将删除同一次尝试的自然文字、mode 与独立目标数组三份重复描述，避免守住错误标签也被算作忠实执行。此段记录的是后续工作的依据，不能将尚未运行的新接口结果计入本样本。

### 第十六份之后已实现的 Mind 直接操作接口

Mind 提示词升级为 v11，输出 schema 为 `eland_mind_intention_v2`，人物请求为 `mind-intention-context-v6`。生产 delta 现在将目标、原话、当前尝试分为三个独立字段：`intentionChange` 仅包含 goal/orientation/horizon；`declaration` 保存新原话及本人语义；`attempt` 只能选择以下一个入口。生产输出不再同时填写 nextAttempt、attemptMode、attemptTargetHandles 来重复描述当前动作。

| attempt | 本人作出的选择 | 后续处理 |
| --- | --- | --- |
| native + nativeOperation | 具体原语及其真实对象、数量和必要来源 | 直接交原生编译与执行，不再由 WorldPlan 重选动作 |
| creative + description | 现有单个原语无法表达的具体新做法 | 仍由 WorldPlan 编译计划与原生操作或开放 effects |
| wait | 明确停下来 | 不启动新的身体操作 |

省略 attempt 表示不改变当前操作，与明确 wait 不同。`{}` 保留安排且沉默；仅 declaration 只说新话；仅 attempt 可以在原目标下选择下一步，也可以在没有已有目标时直接尝试。新 intentionChange 必须同时有 declaration 和 attempt，只有这条路径建立新的 MentalAct；其余选择不复制旧 Goal 来伪装成新意图。保留目标时通过真实原始 Decision 绑定来源，人物上下文明确显示当前 goal/orientation/horizon 与来源 ID，不附带旧的起步动作作为新指令。

语言仍独立即时提交：只发真正的新 declaration，不重播原目标创建时的旧话，也不把 native speech 排成第二次原话提交。WorldPlan 所需的内部临时 draft 在没有新 Goal 时不会保存为新的 MentalAct 或 agenda。creative 没有新声明时，传给 World 的声明明确为 none，并移除临时占位 utterance，不能将未说过的 description 当成已传播语言。creative 描述的 schema 与网关长度均为 480，后续兼容 draft 的 nextAttempt 读取也按 480 处理，避免合法描述被静默截掉后半做法。

本人直接选择的 native 操作以实际执行终态回到 Mind，成功、失败或阻挡的具体后果由本人据此决定下一步；不会在原语结束后自动进入 WorldPlan 重播它。尚在推进的操作继续原 Intent，从地面取物所需的准备移动仍保留原物、原数量和后续 transfer，不能把走近当成已经取到。原生操作未能编译时，由真实失败决定来源提供一次重新选择机会，而非自动换成另一个操作。未知创意的 WorldPlan 路径仍保留开放造物与后续计划，单独的无目标创意不凭空获得一条长期目标续编链。

人物现在能看到真实 actionSpace、knownMethods/knownProjects、nativeOperations/nativeReferences，范围仍排除未建立的默认项目模板；不恢复编号 options 菜单，也不把高级能力的默认 localGoal 当成本人目标。无 plan 的原生终态不再因缺少计划而丢失，其 actualResult、操作和真实来源进入近期回执，缺少 authoredPlan 就省略。未开始反馈与这些亲历结果分开：`attemptFeedback` 只取当前 pendingStep.eventId 对应的 unresolved 条目，携 sourceDecisionEventId、message/fields，并明确“尚未执行、非亲历”。compiled-with-feedback 的一般说明、目标充分性评审和其他历史诊断不一并灌入 Mind，也不写成个人已学知识。

此接口已通过 `test-model-decision-json-schema.mjs` 与 `test-unified-decision-language.mjs` 的聚焦检查，覆盖新格式、来源与语言独立提交、直接原语及保留目标的生命周期。检查使用指定输入与受控响应，证明的是接口可以表达和执行这些选择，不证明模型会自然选择正确动作、产生丰富社会关系或推进文明。第十七份 fresh 样本目录为 `qwen-direct-attempts-seed17-20260908`；这里暂不记录其运行结果，也不把上述机制检查计为该样本的自主成果。

## 第十七份独立一月样本：目标与原话已生成，依赖约束使全部初始输入未落地

`qwen-direct-attempts-seed17-20260908` 从 seed 17 第 0 月独立运行至第 1 月，北京时间 18:32:44 至 18:33:13 结束。实际 runtime SHA-256 为 `cbc73777dd07d1a6f86df82232ffc5bfd812aa36fdfd910713ed951419fdc276`，与 provenance 一致；初始状态 SHA-256 为 `deac12173aa0c4fd96a6d36c1f4cb9243abfea0cecb508245e0719e86d65055d`，与第十六份相同，resumedFrom=null。运行结束只表示到达一月边界，不能视为接口或行为验收通过。

3 个初始模型上下文共发出 9 次 Qwen 4B 请求，全部为 Mind，没有进入 WorldPlan。逐份读取 provider 原始 JSON：sequence 1–7 和 9 共 8 份返回 intentionChange+declaration，省略 attempt；sequence 8 返回 intentionChange+attempt，省略 declaration，其 attempt 是走向真实地面木料 `d3p6yokbzz4zbf` 的 native walk-to。8 份原话对应的目标包括石料加工、庇护所基础、自然循环等，因此不能说模型“没有想法”。问题是当时生产 schema 用顶层 dependencies 要求新目标同时带声明和动作，实际提供者输出没有遵循这一依赖，网关又按该要求拒绝；不能把格式机制未落实或强制配套动作造成的失败归为人物缺少智能。

该冻结运行最终没有一个新 Mind 成为真实 Decision，没有 native/creative 选择落地，也没有模型语言波。账本中的 3 个 completed ActionFact 经逐项核对全部为 survival-reflex move：`e-1-action-nausicaa-10`、`e-1-action-sakura-kinomoto-12`、`e-1-action-sakura-kinomoto-13`，均因可见野兽拉开距离；不是模型所选 walk-to 或建设进展。3 人存活，无出生、加工、造物或新社会事项。

### 第十七份之后：完整对象分支，并允许先形成目标

Mind 根 schema 改为六个互斥的完整 object 分支：`{}`、`{declaration}`、`{attempt}`、`{declaration,attempt}`、`{intentionChange,declaration}`、`{intentionChange,declaration,attempt}`。每支自己声明 required、properties 与 additionalProperties=false，不再依赖根 dependencies 或根共享 properties 决定组合是否合法。重复字段只通过根 `$defs` 引用；schema 定向检查确认六种组合各只匹配一支，并确认 Ollama 可读枚举 guide 展开后与原 schema 一致。native/creative/wait 的操作能力保持不变；这些离线检查不预先证明提供者会遵守新格式。

语义也作了一处明确放宽：本人可以先形成新目标并说出来，尚未选择身体操作。新的 intentionChange+declaration 会保存真实 MentalAct 及本人明确的 ongoing 关切，不强迫附带 attempt，也不从缺省动作推断 wait、creative 或另一项操作；原来“省略 attempt 保留当前操作”的含义继续成立。若后续人物持续只说目标、不采取行动，应如实记录，不能从目标正文替他补动作。

同批修复还让 `agent-memory.ts` 与 `speech-evidence.ts` 统一读取 common outward declaration。没有新 MentalAct 的独立声明也可沿真实语言波、来源、说话者及听闻范围进入记忆与台词证据验证；记忆标签安全区分新意图语言和保留安排时的语言，不再访问不存在的 mentalAct.kind。它不制造话、扩大听闻范围或让未接受提议自动成立。

上述修复均晚于 `cbc73777…` 冻结包。第十七份仍保留“9 次提供者调用、3 个初始上下文全部未落地”的真实失败，不能拿新解析器重新接受旧 JSON 后将原运行改称成功。第十八份将以 fresh 状态验证新版本，本节不记录或预判其结果。


## 第十八份独立一月样本：直接操作落地，但创造、意图一致性与社会回应仍不足

`qwen-direct-delta-seed17-20260908` 从 seed 17 第 0 月独立运行至第 1 月，北京时间 18:43:16 至 18:49:13。冻结 runtime SHA-256 为 `c37b43f92d61787034c77f053c5bfdc82e8f1ea2fc27c9a3de808bfc4e6f321c`，初始状态 SHA-256 为 `deac12173aa0c4fd96a6d36c1f4cb9243abfea0cecb508245e0719e86d65055d`，与第十六、十七份相同。没有更改初始物资或使用 DeepSeek；本轮是完整一月的 fresh Qwen 4B 轨迹，不能与旧样本库存累加。

57 次实际请求为 44 Mind、13 WorldPlan。Mind 选择 30 native、11 creative、2 wait，另 1 次只形成新目标；41 次建立或修改目标，3 次保留原目标并选择新尝试，全部有新声明。WorldPlan 13 次包含 11 次创意编译、1 次同阶段纠正、1 次无新声明的自主续编。45 份实际模型 Decision 中，执行编译为 16 compiled、11 compiled-with-feedback、15 unresolved、3 无编译；不能只用供应商翻译失败数 1 掩盖未落实的步骤。

当时 runner 打印的 planContinuations=2 有一个统计重叠：保留原目标的新 creative 决定也携带用于归属的 planContinuation 字段，但它是本次 Mind 的选择，不是另一次自动世界续编。后续 runner 已改为只计没有 authoredAttempt 的世界续编；原始样本输出保持不改。44 Mind 加 1 次自动续编才对应 45 个决策上下文。

实际动作共 75 份：44 次当次语言、8 次观察、11 次模型 Intent 移动（8 completed、3 progressed）、9 次生存移动、3 次物资转移尝试（1 completed、2 blocked）。没有 act 加工、安装或开放造物，没有 Work、项目或 constructionRecords。

唯一正数量转移为 `e-1-action-sakura-kinomoto-128`：樱从真实 iron-ore-1527 取得 IronOre 2。月末每人仍有原 Food 2，樱另持 IronOre 2，没有取得木料、石料或黏土；未执行播种、建造或冶炼。`e-1-action-nausicaa-127` 试图将本人 Food 2 放在缺少合法近身支撑空位的位置，被阻止，库存未变化。实际物资变化不能从模型说过“把材料堆起来”推断。

### 一次实际取物抵抗进入认知，尚未形成明确的关系理解

seq7 娜乌西卡原话是要求樱分食物，但同一 Mind 直接选择 native transfer，来源为樱的真实食物栈、接收人为自己、数量 1；WorldPlan 没有参与。该选择保存于 `e-1-decision-nausicaa-2-24`，实际 `e-1-action-nausicaa-26` 被樱察觉并抵抗阻止，takingContest 保留双方能力与当次随机结果。它不是“没有许可就禁止尝试”，但原话与本人操作存在矛盾，不能据此宣称她已明确形成偷窃或抢夺意图。

娜乌西卡 seq8、15 的输入都收到 e26 的真实阻止回执与记忆，后来改为口头请求、等待再分肉；樱 seq11、13 也收到这次取物及抵抗的记忆，后来分别说先别动肉、把肉藏起来。她们没有明确讨论取物事件或解释对彼此的判断，不能把后续藏肉动机自行归因。

双方月末都有 e26 来源记忆；樱对娜乌西卡为 trust=3、bond=10、fear=3，关系来源包含 e26，娜乌西卡对樱仍为 trust=10、bond=10、fear=0 且仅 founding 来源。两人整月 relationshipAppraisal 都为 0。这是已有领域后果进入关系记录，不是模型明确选择了这些数值或形成了可验证的关系理解。本轮全部 44 份声明为 28 expression、13 proposal、2 prediction、1 request-information；accept/reject/share 均为 0。9 份实际 joint-action 都停留 proposed，0 集体、0 出生，不能验收丰富社会。

### 创意解释仍会改变执行主体

seq15 的本人尝试是指挥樱与达·芬奇搬材料；seq16/17 世界正文仍写请求协助，却选择本人 walk-to 一个派生位置，纠正后仍不能绑定。seq18→19 又把指挥他人搬石材改成本人走向石堆。seq36→37 原话明确“达·芬奇拖木材，樱垫石头，我看住猪”，世界却编译本人走到木堆。后两者的预期文字写他人协助，不等于他人实际接受或动手。这些不是原生动作参数能独自解决的问题，需要继续处理创意计划的执行主体与真实回应。

### 随后发现的复用标记问题

`intent-1-sakura-kinomoto-21` 先由创意计划创建，再被 e85 的直接 native 选择复用，后来又由 e121 的世界续编（原始意图 e114）接管。冻结版本在世界接管时未清除旧 operationAuthorship=mind，因此月末该 Intent 的标记已不能正确表示当前步骤，也不能用于回溯所有历史 Action 的作者；它还可能让后续终结走错回顾入口。铁矿石转移是真实结果，但不能单凭月末标记将它归为纯 Mind 直达。此问题在本轮结束后修复：世界接管同时清除旧 mind 标记，将 sourceDecisionEventId 更新为当次真实世界编译决定，planSourceDecisionEventId 继续指向原目标。针对性复用检查实际执行至终止，确认标记与旧来源回退这两个直达 Mind 条件均为 false，旧决定快照未改。未修改原始存档，也不把修复后的机制算成本轮已经通过。

本轮证明原生直达接口已被 Qwen 实际使用，也保留了有抵抗、有回执的交互；人物仍反复改写目标，创造与社会回应尚未形成连续结果。完整文明与多代传承目标保持未完成。

### 第十八份之后：动作来源在执行时固定

新的 `ActionFact.decisionSource` 在动作执行时记录 `executionDecisionEventId`，有原目标来源时另记 `intentionDecisionEventId`。身体动作读取当时由本人持有的 Intent 来源；独立声明读取其真实语言波来源。之后复用同一个 Intent、换为 Mind 原语或 WorldPlan 步骤，都不能回头改变已经产生的 ActionFact 作者。

`test-native-operation.mjs` 的既有多步取材回归已实际验证：第一次准备 move 保存原决定来源；随后通过另一份真实决定复用同一 Intent，旧 move 快照保持不变，最后真实取 4 份的 transfer 保存新执行决定、同时保留原目标决定。这是来源审计修复，不代表人物的选择更正确，也不会给第十八份旧 ActionFact 补造当时没有保存的快照。

### 两个社会完成判据：可以检查回应，不替人物回应

已新增 `agreement-status{agreementId,status}` 与 `agreement-response-recorded{agreementId,personId,response}`。前者只读协议当前真实状态；后者只读指定人的 acceptedByPersonIds / rejectedByPersonIds 记录，不把旧接受等同于协议现在仍 active。原七种 AgreementStatus 保持不变，没有改变邀请、接受、拒绝或授权规则。

模型 schema 使用本轮已知 agreementHandle 与真实 personHandle，绑定后回投实际协议、人物及检查含义。领域与 schema/绑定回投的定向验证已通过：proposed 时对方尚无回应；一人实际接受、另一人未回应时不能认作全体 active；真实拒绝可被查询；协议后来 cancelled，历史接受仍可读，但 active 条件为 false。这只补齐“检查是否已回应/处于什么状态”的表达能力，没有生成任何人的同意或关系变化，不能证明下一轮 Qwen 会自主回应，也不能据此认定合作成立。

### 七次贡献主体探针：完整上下文仍改派任务，小上下文仍漏角色

以下均为 lan-qwen / qwen3.5:4b 的隔离诊断，共 **7 次请求**。各 result 明确 requestCount=1、retries=0、worldExecutionPerformed=false，HTTP 200、done_reason=stop。它们没有推进主世界，也没有成为新的生产修复；输入和 schema 的差异要分别看，不能把诊断输出拼成社会行为成果。

| 目录 | 请求与时间（北京时间） | 输入改动 | 已保存结果 |
| --- | --- | --- | --- |
| `qwen-contribution-replay-20260908` | 重放第十八份 sequence 16 / 19 / 37；19:03:19～19:03:49，3 次 | 保留原完整用户消息、format 与采样参数，只在原 system 加主体/贡献澄清 | 三份仍把请求他人搬运变成本人搬运或接近材料；三份均因填写 plan.feedback 却缺来源而不符合冻结 schema |
| `qwen-contribution-reading-20260908` | 同三份来源；19:11:19～19:11:24，3 次 | 改用小上下文和专门的角色阅读 schema；冻结意图与原话保留 | 三份符合小 schema，但 sequence 19 漏掉达·芬奇，sequence 37 漏掉本人看猪的活动 |
| `qwen-contribution-reading-activity-20260908` | 再检查 sequence 37；19:19:21～19:19:23，1 次 | 保留上一份 user context，把可空 actorPhysicalContribution 换成 actorActivity，并明确观察等也属活动 | 输出 actorActivity=“说话”，仍遗漏本人明确选择的看猪活动；小 schema 合规不等于语义完整 |

第一组的具体主体偏移分别是：sequence 16 安排本人到空地准备搬运；19 明说本人需要亲自参与材料移动；37 仍让本人拖木，原语却只有 walk-to 木堆。三份 plan.feedback 都缺 sourceMemoryHandles / sourceCompilationEventIds，没有修补后执行。这里能分析候选文本的错误，不能说人物已经真实搬运失败。

第二组实际输入 tokens 为 493 / 430 / 545，输出为 228 / 161 / 123。sequence 16 基本保住两个被请求人和本人不代搬的区分；19 的 explanation 提到两人，但结构化 requestedContributions 只列樱；37 的 explanation 承认本人观察野猪，却仍把 actorPhysicalContribution 写成 null。第三组为输入 555 / 输出 144 tokens，保留了请求他人拖木、垫石，却仍把本人活动缩成说话。由此不能宣称缩小上下文、换字段名称或加入一个澄清段就解决了主体理解；这些探针也没有自动替换生产合同。

### executionBasis 与背景引用仍混淆，精确方法入口尚待真实验证

对第十八份保存状态逐条计数，15 条 unresolved 中有 12 条的 problem.fields 为 executionBasis：9 次 observe、3 次 transfer。其中 **10 条携 knowledgeId，2 条携 agreementId**，不是 12 条全为知识。另 3 条是位置/距离问题。典型如 `e-1-decision-leonardo-2-22`、`-5-47` 只是观察野猪，却把 `animal:boar` 观察知识放进完整执行依据；后一条还同时将同一知识放在 backgroundReferences。樱的 `e-1-decision-sakura-kinomoto-12-109`、`-13-114` 要取 IronOre 2，却把同一待回应协议同时放进执行依据和背景。

这 12 条在应用层没有匹配到相应完整方法，所以未开始原语；它们不是 12 次真实物理失败。当前正在把普通原语的背景信息与真正的方法调用进一步分开：普通知识、项目或协议背景不据此选择高级过程；完整已有能力通过 `use-method` 的精确方法引用进入，绑定其真实参数和领域来源，避免模型手填 executionBasis 去拼出不存在的方法。该工作不是删除来源检查，更不是把一个待回应协议变成许可。

这项入口修复仍在实施，尚无 fresh Qwen 轨迹验证，也没有新世界结果可记。本节只保留问题与正在进行的连接方式，后续冻结版本、实际调用和行为结果待产生后另记；不改第十八份原始状态或将机制进度写成智能成功。

## 第十九份独立两月样本：精确方法已接通，仍停留在观察、取放和反复提议

`qwen-exact-methods-seed17-20260908` 从 seed 17 第 0 月运行至第 2 月，resumedFrom=null，北京时间 19:49:40 至 20:07:15，evolution.status=completed。实际 runtime SHA-256 与 provenance 均为 `a273b825716a3070f447edead9fd06bf6cadd9f1237fdf0f6b7a9b78b596a977`；初始状态 SHA-256 为 `664ed0d11986c1ad601c3418e9160755906db86d40265bcbba3cb5b008411580`。本次冻结已包含精确 use-method 与社会完成条件，不能将之后的摘要或软土取材修复归入其中。

138 次提供者请求全部为 lan-qwen / qwen3.5:4b / ollama-chat、HTTP 200；89 次 Mind、49 次 WorldPlan。按原始 Mind 返回及实际事件分别计数：

| 项目 | 第 1 月 | 第 2 月 |
| --- | ---: | ---: |
| 请求数（Mind / WorldPlan） | 69（45 / 24） | 69（44 / 25） |
| 本人建立或改变目标 / 保留原目标 | 35 / 10 | 42 / 2 |
| 本人 attempt：native / creative / wait | 22 / 21 / 2 | 21 / 21 / 2 |
| 空 delta 或仅声明的 keep | 0 | 0 |
| 实际 talk | 45 | 44 |
| 实际 attend | 11 | 11 |
| 模型 Intent move：completed / progressed | 5 / 1 | 6 / 6 |
| survival-reflex completed move | 3 | 0 |
| 正数量 transfer 次数 / 累计移转份数 | 5 / 7 | 2 / 4 |
| completed self no-op transfer | 3 | 2 |
| blocked transfer | 12 | 9 |
| 执行编译 unresolved | 2 | 6 |
| 全部 ActionFact | 85 | 80 |

保留原目标的 12 次选择仍各自选了新 attempt，不是 12 次静默或仅讲话。Decision 上另有 6 / 1 个 planContinuation 标记，与保留原目标的创意尝试交叠，不能额外加算成没有新 Mind 的七次独立模型请求。165 个 ActionFact 合计 137 completed、21 blocked、7 progressed；没有 act 加工或 world-interact。8 条 unresolved 中，6 条是 world-plan 的 invalid-operation（第 1 月 2、第 2 月 4），另外两条均在第 2 月，分别是 target/withinDistance 与 source 的 missing-evidence；没有再出现自由 executionBasis 拼接失败。这不代表所有执行或意图翻译正确。

累计 11 份正数量移转不是新增 11 份资源。第 1 月四次食物移转共 5 份，在达·芬奇与娜乌西卡之间来回；另一次是樱取得 IronOre 2。第 2 月的两次正量移转，是樱把这两份铁矿石放在 `cellId=1527,z=5` 后再取回。月末娜乌西卡持 Food 1、达·芬奇持 Food 3，樱持 Food 2、IronOre 2；没有湿土、草叶混合物或新的加工产物。

Action.decisionSource 可以核对两条不同归属链：

- `e-1-action-leonardo-37` 的 executionDecisionEventId 为 `e-1-decision-leonardo-3-32`，intentionDecisionEventId 为较早的 `e-1-decision-leonardo-2-22`。Mind seq10 仍在提议携食物与矿石共同观察、建立信任；WorldPlan seq11 正文写展示与分享食物，却选择 `method_2020k6atdjdqs`，实际完整方法是从娜乌西卡取 Food 1。Action 记录未经授权取走、quantity=1，并有 takingContest。争夺结果是真实的，但该错译不能当作本人明确选择犯罪或合作已经成立。
- `e-1-action-sakura-kinomoto-114` 的两个来源都为 `e-1-decision-sakura-kinomoto-12-110`。Mind seq54 原话明确先把两份铁矿石拿到手，直接选择相应 native transfer；实际取得 IronOre 2 与本人当步选择一致。后续想揉土、草、水的目标没有因此完成，也没有发生冶炼或造物。

44 份 joint-action 全部仍为 proposed；acceptedByPersonIds 只有各自发起人，没有其他参与者接受，没有任何拒绝。原始 Mind speechIntent 也没有 accept/reject/share：两月分别为 expression 19 / 12、proposal 24 / 27、prediction 2 / 1、request-information 0 / 4。seq52 的娜乌西卡原始输出曾提出一份 solidarity/care 的 relationshipAppraisal，但最终状态及实际 Decision 未保留该字段，不能称为已有模型关系理解落地。原生取物后果导致的关系变化应另归因，不能代替本人明确回应。

新增社会判据有被模型使用：20 份 WorldPlan 返回合计选择了 22 条 agreement-status 条件（第 1 月 10、第 2 月 12），包括要求已有邀请为 active；agreement-response-recorded 未被选择。实际绑定例 `e-1-action-nausicaa-46` 的 Plan 检查引用了真实邀请 ID，但邀请仍 proposed，不能满足 active。这证明可表达的检查进入了计划，不证明任何人已经同意，整体目标也未被这些文字自动完成。

另有两个明确的后续接口问题。seq30 选择 `method_2x9cg9ud2k449` 时，冻结展示只有“到达选定的空位”与 walk-to 参数，完整能力却是接近水源并饮水的方法，信息不足以让模型判断其完整用途；其 `e-1-action-nausicaa-61` 实际只记录了移动与水源接近依据，不能据方法的后续语义额外算一次已经饮水。完整方法摘要已在冻结之后修正。两个月另有 10 次向地表湿土发出的 transfer 被阻止，尚未得到湿土；原生软土取料入口正在补齐，不能改写本轮为已成功取土。开放 effects 的 consume+produce 早已能表达实际消耗地表材料并形成可持有物料，但本轮所有 WorldPlan 返回均未选 effects，不能说这条能力已被自主使用。

最终仍为 3 人、0 出生、0 Work、0 Project、0 物理结构、0 加工。精确方法减少了来源拼接错误，却没有解决错误方法选择、反复空转取物或邀请无人回应；抢食、食物来回转手和矿石拿起放下不能当作文明进展。原 state 与 month-1-checkpoint 保留不变：校验 SHA-256 分别为 `883c40348b68f1ec1edc1ffb852651232d4c4c3d185207c500eaddcd0a85c106`、`c37bb892ca9cda6742d2fcfe4e30bd8bf9147eec87efcca17e19d2c99637b190`。本轮仍未通过自然社会与文明演进验收。

### 第十九份之后的软土取材：真实消耗体素，不把掉落物和地形混为一类

原生 transfer 现在能把明确点名的地表软料松取到本人库存，距离不足时先接近，准备移动不远程取料。范围沿用实际材质属性：固体、hardness≤2，且属于 ground 或 plant；硬石不因此变成徒手可取物。`actions/voxel-material.ts` 与开放效果共用体素消耗记录，一格只提供一份，取走后原格变 Air，并记录库存产出、原体素位置和来源；请求多份也不能从该格制造额外数量。再次请求已空的同一格会失败，不向更低地表偷换目标。若请求本来点名的是 Drop，Drop 消失也不能改取附近地形；取料不会把湿土混入作为持有位置引用的食物 stack。

此前完成的定向检查入口为 `node scripts/test-native-operation.mjs data/experiments/qwen-exact-methods-seed17-20260908/month-1-checkpoint.json`。该隔离回放读取原第十九份最后一次湿土选择的真实 decisionSource，在副本上得到 WetSoil 1，原 `(17,27,4)` 变 Air；脚下支撑被移除后，人物由 z5 落至真实可站的 z4，落差和来源有回执，食物不变，重复取同格不再产料，原检查点文件保持不变。它证明旧选择在新接口下有可执行路径；没有重新调用 Mind，没有给原主运行补材料或改写成功，也不算模型自主采用了新能力。本次文档核对未重跑该检查。

### 第八次主体诊断与端点元数据：尚无“消息角色被忽略”的证据

加上 `qwen-context-last-replay-20260908`，针对第十八份贡献主体的隔离推理共 8 次：完整上下文加说明 3 次、小上下文阅读 3 次、actorActivity 字段对照 1 次、纯消息顺序对照 1 次，并非 8 次相同的顺序实验。第八次仅交换原 seq37 的两条 user 消息，让实际人物上下文位于 schema guide 之后；逐条文本、format、模型、温度与预算均未改。Qwen 仍让本人搬木、堆石，原语仍是 walk-to 木料，未保住本人看猪/等待他人的分工；原 schema 又因 feedback 缺少来源而未通过。耗时 11.977 秒，输入 22,247 / 输出 940 tokens，无重试、无执行。这一例不支持“把上下文放最后就已修好主体理解”，也不证明消息顺序在所有场景都无影响。前七次的详细结果保留在前文，均不能计入自然社会成果。

`qwen-endpoint-metadata-20260908` 仅读取同一 LAN 端点的 `/api/version`、`/api/ps`、`/api/show`，没有发推理。服务报告 version=0.33.3；已加载 qwen3.5:4b，格式 GGUF、Q4_K_M，报告参数规模 4.7B，实际加载 context_length=65,536，模型声明上限为 262,144。show 的模型参数列 presence_penalty=1.5、temperature=1、top_k=20、top_p=0.95，未列 num_ctx；这不表示没有设置运行上下文，也不直接证明每次请求最终采用了这些默认值。template 确为 `{{ .Prompt }}`，但这三个接口没有给出渲染后的聊天内容或角色处理路径，不能据此认定角色被忽略、模板损坏或底层具体实现。原始小 metadata 与判断单独保存，没有改配置或拉取模型。

## 第二十份独立一月样本：取料能力已补，实际仍没有取得或加工材料

`qwen-grounded-materials-seed17-20260908` 从 seed 17 第 0 月运行至第 1 月，北京时间 20:53:57 至 21:00:50，terminal completed。实际 runtime SHA-256 与 provenance 均为 `846fa2bb925fe22ab9dcd47ec38c4322d800a588f911f1275e2cfa465eb82733`；初始状态 SHA-256 为 `deac12173aa0c4fd96a6d36c1f4cb9243abfea0cecb508245e0719e86d65055d`，resumedFrom=null。

45 个模型上下文共 60 次 Qwen 请求，45 Mind、15 WorldPlan。本人选择 native 30 次、creative 12 次、wait 2 次，另 1 次没有 attempt；40 次建立或改变目标，5 次保留原目标。实际 87 个 ActionFact 为 45 talk、9 次 survival-reflex move、27 次模型 Intent move（18 completed、9 progressed）、4 attend、1 act/ingest、1 blocked transfer。没有正数量 transfer、terrainExtraction、Work、Project 或建造记录；已经补齐的软土入口没有在本轮被实际执行，不能用前述指定回放代替这项缺失。

唯一 ingest 是 `e-1-action-nausicaa-39`，“从地表摄入了水”，有 materialId=7、hydration=58 的真实回执。它的 executionDecisionEventId 与 intentionDecisionEventId 均为 `e-1-decision-nausicaa-2-24`，对应 Mind seq9 本人直接选 `use-method(method_2x9cg9ud2k449)`；当时输入已完整显示“接近并饮用地表水”，不是 WorldPlan 后来将别的选择改成饮水。其原话仍在谈营地与信任，不能把饮水成功扩大成这些目标已达成。这个归属依据来自 Action.decisionSource，不采用月底可能已被更新的 Intent 来倒推。

唯一 blocked transfer 是 `e-1-action-leonardo-15`：本人原 creative 想整理石料搭地基，WorldPlan 却安排从娜乌西卡取 Food 1，实际被对方察觉并阻止，没有食物转移。它仍是意图翻译偏移，不能当作模型自主选择抢食。26 份 joint-action 全部 proposed，acceptedByPersonIds 只有发起人自身，没有其他参与者接受或拒绝。WorldPlan 8 次选用了 agreement-status=active，agreement-response-recorded 未使用；检查条件存在不等于邀请已经得到回应。

本轮主要发生了发言与走动，真实饮水只证明这一方法能按本人明确选择执行；没有材料取得、加工、建造或成立的共同协作。第二十份仍未达到自然社会与文明演进要求，原始结果不因机制检查通过而改判。

另一个 fresh 种子 `qwen-grounded-materials-seed31-20260908` 已于北京时间 21:23:10 启动，复用同一冻结 runtime，文件与 provenance 的 SHA-256 均为 `846fa2bb925fe22ab9dcd47ec38c4322d800a588f911f1275e2cfa465eb82733`。此处只记录运行中与版本一致，不预写 seed31 的行为或结果。
