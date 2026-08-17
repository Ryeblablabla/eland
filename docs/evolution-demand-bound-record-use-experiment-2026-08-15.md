# v21 需求绑定的记录使用实验预登记

状态：已实现并完成 3 seeds × 10/30 年；决定为“机制可达、自然候选修订”，不接受 v21 整包。本文的第 1～10 节是候选代码产生前锁定的预登记，第 11 节追加真实结果。

关联：[规则优先人物架构](./rule-first-agent-architecture-v1.md) · [文明演化双闭环与实验协议](./evolution-iteration-loop-v1.md) · [能力里程碑因果观察器](./capability-milestones-causal-observer-v2.md)

## 1. 已确认断点

v19 三个 30 年终点已经证明“记录不存在”不是当前断点：审计到 15 份实体记录，三种子的 codebook 教学分别为 `20/32/93`，记录转移分别为 `54/41/32`。至少 68 次记录被送到尚不具备对应语义技术的接收者，但三次历史的 `read-record` 和记录导出的独立复现均为 0。

口述教学也暴露同一问题。111 个首次“人物—技术”口述获得对中，只有 7 个后来由接收者亲自复现，只有 3 个进入真实项目。载体、转移或教学事件本身没有稳定地改变生产。

当前实现已经具备下列局部事实：

- `RecordPayload` 将语义内容与实体载体分离，保存作者、`knowledgeId`、`codebookId`、版本和来源；载体转移后 payload 身份不变；
- 当前读选项只要求人物持有载体、掌握 codebook，且尚未以该 payload 为来源获得知识；它使用泛化的 `knowledge` goal；
- 当前分享选项只要求同地接收者掌握 codebook 且尚未读过 payload，不要求接收者有生产问题或可核验材料；
- 技术经阅读或口述后只能形成 `<55` 的暂定知识；阅读时新知识为 `46`，已有技术最多升至 `54`；
- 接收者亲自成功执行匹配物质操作时，现有执行器会把同一技术置信度提高 `+18`；
- 项目保存真实触发、缺料、行动和失败来源，但记录读写选项没有把这些项目事实与 payload、核验输入连接起来；
- 能力里程碑与文明指数均是下游观察结果，当前边界禁止规划器读取。

因此最早断点不是“记录数量不足”或“传播优先级太低”，而是：

```text
当前项目缺口或相关失败
→ 找到能回答该问题的实体记录
→ 为具体接收者形成阅读理由
→ 阅读得到暂定知识
→ 接收者用真实材料亲自复现
→ 成功后成为可靠技术
→ 技术进入原问题对应的项目
```

现状在“载体/教学 → 当前问题与核验计划”之间断裂。提高全局阅读分数、继续增加记录转移或让阅读直接产生可靠技术，都不能修复这条链。

## 2. 单一候选：`RecordUseBasis`

### 2.1 因果假设

如果记录使用被一个稳定、可回放的 `RecordUseBasis` 约束，人物只在当前真实问题、匹配记录和可立即核验的物质条件同时存在时读或分享，那么实体记录可以成为“异人暂定知识 → 本人独立核验 → 项目采用”的中介，而不会变成无目的社交或隐藏科技树。

本轮只引入这一种通用机制。不同时修改记录产量、技术阈值、项目压力权重、全局阅读分数、文明指数公式或模型策略。

### 2.2 最小来源契约

实现可以选择具体存储位置，但每个 basis 必须至少保存并可回放以下语义：

```ts
interface RecordUseBasis {
  version: 'record-use-basis-v1';
  basisKey: string;
  readerId: PersonId;
  demand:
    | { kind: 'project-deficit'; projectId: string; deficitSourceIds: string[] }
    | { kind: 'related-failure'; failureEventId: string; unresolvedNeedSourceIds: string[] };
  payloadId: string;
  knowledgeId: string;
  codebookId: string;
  ruleSignature: string;
  carrierRef: WorldRef;
  inputRefs: WorldRef[];
  inputSourceIds: string[];
  createdAtMonth: number;
  sourceFactIds: string[];
}
```

字段名可以按现有领域类型调整，但下列语义不能降级为文本推断：

1. **真实需求锚点**：接收者当前活跃项目缺少一条可靠物质技术，或接收者已有与未解决局部功能缺口直接相关的真实失败。旧失败只有在对应问题仍未解决时才有效；单纯“人物喜欢学习”不构成需求。
2. **确定性匹配**：payload 必须是 `kind=technique`，其 `knowledgeId` 能由权威交互规则解析成唯一操作、输入、目标和输出，并能满足项目缺口或解释相关失败。不得用摘要相似度、模型语义或隐藏配方做 join。
3. **实体载体**：同一个 `recordPayloadId` 必须仍绑定在可解析物品栈上。分享时载体由分享者真实持有且转移合法；阅读时载体由读者真实持有。
4. **共同编码**：读者在 basis 成立时已持有同一 `codebookId`、`kind=codebook`、`confidence>=55` 的有来源知识。
5. **尚未可靠掌握**：读者在阅读前对该技术的置信度 `<55`；没有该知识按 `0` 处理。已有口述形成的 `46..54` 暂定知识不排除阅读。
6. **真实可用输入**：权威规则能从当前局部世界编译出一项匹配实验，所需 AND 数量、OR 分支、工具、输入栈和目标体素都真实存在且可合法使用。附近但尚未取得的掉落物只能形成取材步骤；在输入真正到手、实验原语可执行以前，不得把 basis 标为 eligible。

v21 只覆盖能由当前权威物质规则精确解析并以现有 `+18` 机制核验的技术。无法从 `knowledgeId` 唯一恢复操作签名的记录不生成 basis，也不以摘要猜测。

### 2.3 稳定身份与生命周期

`basisKey` 至少由 `readerId + demand anchor + payloadId + canonical rule signature` 决定。新 intent ID、月份推进、载体换手或相同输入换成另一 stack ID，均不得把同一理由伪装成新 basis。

同一 basis 最多发生一次成功分享和一次成功理解性阅读。阅读后即使实验材料暂时失去，也应保留“已读、待核验”状态；材料重新出现时继续核验，不得重读刷置信度。项目缺口已经解决、payload 或 codebook 失效、读者死亡或规则签名不再成立时，basis 失效。只有新的项目/失败来源或 payload 新版本提供了新的因果事实，才允许形成新的 basis。

## 3. 两步知识闭环

### 3.1 第一步：实际阅读只产生暂定知识

分享选项只能指向已经存在 eligible basis 的接收者。没有项目缺口、相关失败或未解决局部问题时，不得分享；只有 codebook、邻近人物或“对方没读过”不再足够。

读者取得载体后，必须实际完成一次指向该实体栈的 `attend`。阅读 intent 不得使用可能被口述知识提前满足的泛化 `knowledge` goal；它必须由“同一 reader 对同一 payload、同一 basis 的 understood read action 已完成”这一来源绑定谓词完成。

阅读动作必须记录：

- `basisKey`、`recordPayloadId`、`learnedFactId`、`understood=true`；
- 阅读前和阅读后的置信度；
- payload、载体、codebook、需求锚点和输入来源；
- 实际阅读事件 ID。

阅读后技术置信度必须仍 `<=54`。来源至少保留 payload 实体和本次 read event；阅读本身不能设置可靠技术、项目完成、物质产出或身体后果。

### 3.2 第二步：本人成功物质实验才完成核验

阅读后，接收者本人必须执行与 `ruleSignature` 完全匹配的物质原语。核验要求：

- 执行者就是 reader，且 reader 与 payload 作者不是同一人物；
- 操作发生在阅读之后，输入、数量、工具、目标体素和输出都由实际 action diff 证明；
- action 状态为 `completed`，并产生规则规定的真实物质或世界变化；失败、blocked、仅观察产物或作者代做都不算；
- 只有这次成功动作才能使用现有 `+18` 更新，使同一技术跨过 `55` 可靠阈值；
- 技术来源图同时保留 payload/read 与接收者实验事件，不能只留下口述或作者原始试验。

成功核验后，既有项目规划器才可把该技术作为可靠方案。完整链的终点必须是同一需求锚点对应项目的真实推进：匹配实验本身成为项目行动并产生进度/功能产物，或后续项目行动使用该可靠技术或实验产物并留下进度、完成或缺口减少证据。仅出现 `confidence>=55`、生成项目选项或观察到里程碑，不算项目推进。

## 4. 明确不做

- 不给人物加入“发展文明”“多读记录”或“传播知识”的常驻抽象欲望；
- 不增加全局 `read-record` 分数，不用权重压过生存、照护、履约和已有项目；
- 不把口述、阅读、记录转移或 codebook 教学直接当作已掌握技术；
- 不自动生成项目、输入材料、成功实验、产物或项目进度；
- 不允许从全图寻找载体、材料或项目，不允许用模型匹配摘要与配方；
- 不要求每个世界都自然发生阅读；缺少压力、匹配 payload 或输入时，零发生是合法历史；
- 不把能力里程碑、文明指数、阶段、定义数量或历史多样性反馈给 basis、选项生成、评分或动作执行；
- 不把观察器新增字段或文明指数变化当作候选成功。

## 5. 预登记实验矩阵

### 5.1 基线与候选

- 逻辑基线：最终冻结的 v20；
- 基线矩阵 artifact：`three-body/data/experiments/candidate-causal-shelter-adaptation-v20e.json`，SHA-256 `e2ad15c9614a2b9569c1f6513994b527dafc38651a40a177cfb795a6c901d91d`；
- 基线观察版本：behavior observer `causal-person-month-v13`，civilization index `causal-diversity-v3`；行为基线以保存的三份 360 月权威状态和上述矩阵为准，不用当前观察器重新运行替代；
- 候选：`candidate-demand-bound-record-use-v21`；
- 候选 artifact：`three-body/data/experiments/candidate-demand-bound-record-use-v21.json`；
- 对比 artifact：`three-body/data/experiments/candidate-demand-bound-record-use-v21-vs-v20.json`。

不得用 v19、v20 中间修订或仅重新投影出的观察字段替代该行为基线。里程碑观察器可以对双方保存状态做同公式重投影，但不改变行为 A/B 的权威输入。

### 5.2 种子、时长与重复

- 种子：`185, 20260815, 20260816`；
- 必跑：`3 seeds × 10 years` 快速因果诊断；
- 必跑：相同 `3 seeds × 30 years` 知识扩散与延迟项目验证；
- 条件补充：若完整链涉及代际更替，或 10/30 年之间无法定位传播断点，再补相同三种子的 20 年中间截面；该补充只用于定位时序，不替换 30 年结果；
- 本地规则确定、模型关闭，`repeat=1`；相同种子重复只可验证回放，不计作额外样本；
- 基线与候选保持相同初始人口、文明配置、纪元/气候参数、规划刻度、模型策略和观察器公式。

10 年矩阵先检查 option 可达性、阅读实际执行和硬守卫；即使 10 年已出现链，仍必须完成 30 年配对，因为目标能力包含知识扩散和项目采用。不得因结果不利更换种子或静默延长单个运行。

## 6. 主要观察量

每个运行按唯一 basis 和唯一人物统计漏斗，而不是按选项展示次数统计：

1. potential / eligible / invalidated `RecordUseBasis` 数量；
2. 有 eligible basis 的人物、项目/失败锚点、payload 和规则签名数量；
3. 分享尝试、成功实体转移、理解性阅读及各自的唯一 basis 数；
4. 阅读前后置信度分布，以及已有口述暂定知识的读者数量；
5. 匹配实验尝试、成功、失败、独立执行者及 read→experiment 延迟；
6. 由成功实验跨过可靠阈值的技术数；
7. 实验后进入项目行动、产生进度、完成项目的数量及 experiment→project 延迟；
8. 完整“异人阅读 → 真实独立复现 → 项目推进”链数量、涉及的不同种子/人物/payload/项目；
9. 没有走到下一环的最早断点：无需求、无匹配记录、无 codebook、无实体载体、无输入、未读、未实验、实验失败或未进入项目；
10. 口述教学后的独立复现与项目进入，作为对照路径单独报告，不能与记录链合并。

同时报告记录创作、实体存续、codebook 教学、记录转移、真实沟通动作、生产动作、项目完成/阻塞、空闲、移动、人口、出生、死亡、灭绝、模型调用和 token。分享减少可能是正确的需求筛选，不能把记录转移下降本身判为回归；但若生产/项目流因错误持锁或意图死循环明显退化，候选包必须修订。

文明指数总分、五个分项、阶段和能力里程碑只作隔离的下游观察；公式 provenance 不完全相同则不做 A/B 归因。

## 7. 硬守卫

以下守卫在所有 10/30 年运行及条件性的 20 年运行中都必须为 0：

| 守卫 | 零容忍条件 |
|---|---|
| 人物 | basis、分享、阅读、实验和项目推进中的 reader 均可解析、当时可行动且 ID 一致；实验者必须是 reader，且 reader 不等于 payload 作者 |
| payload | payload 存在、`kind=technique`、`knowledgeId/codebookId` 与 basis 一致，并能唯一解析 canonical rule signature |
| codebook | basis 和阅读发生时，reader 对同一 codebook 的置信度均 `>=55`，来源可解析 |
| 项目/失败缺口 | basis 有未解决的 active project technique deficit，或有来源的相关失败与仍存在的局部功能缺口；无裸好奇、已解决需求或无关失败 |
| 匹配 | payload 的操作、输入、目标与输出确实满足该项目缺口或解释该失败；不得靠 summary 文本匹配 |
| 实体载体 | 分享时分享者真实持有同一 payload 的 stack，阅读时 reader 真实持有它；每次转移数量守恒、载荷身份不变 |
| 真实材料 | basis 创建和实验执行时，完整 AND 数量、所选 OR 分支、工具、输入栈、目标体素与权限均可解析；不得读取隐藏资源、欠量执行或凭空补料 |
| 时间顺序 | payload/需求/codebook/输入来源均不晚于 basis；分享不晚于阅读；`read < successful experiment <= project progress`，不存在未来来源或倒序归因 |
| 阅读前置信度 | 对应技术在 read 前严格 `<55`；已经可靠掌握者不得生成 basis、分享目标或阅读 |
| 阅读后置信度 | understood read 后仍 `<=54`；阅读、分享或口述不得单独跨过可靠阈值 |
| 独立核验 | 只有 reader 亲自完成完全匹配且有真实输出的物质 action 才能核验；作者代做、仅 attend、blocked/failed 或错误配方均不得核验 |
| `+18` 更新 | 跨阈值变化由同一成功实验事件触发并遵守既有 `+18`；不得由 planner、basis 创建、选项选择或观察器直接改知识 |
| 项目进入 | 进度事件属于同一需求锚点项目或有来源的直接后继项目，发生在核验后，并有真实 action / material / progress evidence；仅生成 option 不算 |
| 来源解析 | basis 与链上所有 event ID、project ID、payload ID、stack/voxel ref 和 knowledge source 均能解析到对应权威事件或实体；payload 实体 ID 不得冒充 world event ID |
| 同一 basis 重复 | 同一 `basisKey` 不因新 intent、月份或 stack 换手重复建立；成功分享至多一次、understood read 至多一次，阅读后不重复刷置信度 |
| intent 完成 | read intent 只能由同 basis 的实际 understood `attend` 完成；voice 预先形成的 knowledge 不得让它无动作完成 |
| 无绑定读/分享 | 每个 `share-record` 和 understood `read-record` 都必须引用当时 eligible 的同一 basis；无项目、无失败、无局部缺口时二者均为 0 |
| 模型独立 | `usedModel=true`、模型调用数、输入 token、输出 token 和 charged token 全部为 0；模型结果不得参与 basis 匹配或项目选择 |

另外保留既有物质守恒、动作合法性、项目来源、有限搜索、15 ticks/月和确定性回放不变量。里程碑或文明指数的变化不能抵消任何一项硬守卫失败。

## 8. 定向可达性检查

在自然矩阵前只做聚焦规则检查，不注入到自然运行：

- 正例 fixture 必须由一个真实项目技术缺口或相关失败、异人创作的匹配实体 payload、读者已掌握的 codebook、读前 `<55` 知识和足量真实输入构成；后端自有循环应实际完成读取、匹配物质操作、`+18` 核验和项目推进；
- 分别移除需求锚点、payload、载体、codebook、一个必需输入或合法目标时，不得产生 eligible basis；
- 先用 voice 把读者技术提高到 `46..54`，read intent 仍必须执行真实 attend，不能被泛化 knowledge goal 提前完成；
- 阅读后移走材料再放回时，不得重复阅读；应在同一 basis 下等待并执行核验；
- 错误配方、blocked 实验、作者代做和只观察作者产物均不得跨过可靠阈值；
- 里程碑定义、文明指数和模型配置的变化不得改变同一 fixture 的规则选择。

定向 fixture 只证明规则路径可达和负例被隔离，不计入自然发生率，也不能替代多种子历史。

## 9. 决策标准

### 接受

只有同时满足以下条件才接受 v21 机制：

1. 所有定向正负例通过，所有自然运行的硬守卫为 0，模型调用与 token 为 0；
2. 在 30 年自然候选矩阵中，至少两个不同种子各出现至少一条完整的“异人 understood read → 同一读者真实独立成功复现 → 同一需求链项目真实推进”；10/20/30 年同种子的前缀历史只计一个种子；
3. 每条接受链都能从需求或失败来源、payload、codebook、实体载体、真实输入、读前后置信度、成功输出到项目行动逐项回放；
4. 改善不依赖强制项目、事件注入、种子筛选、摘要语义猜测、观察器奖励或模型；
5. 没有新死锁、材料/来源不变量破坏或由 record intent 持锁造成的明显项目流回归。

自然历史可以有大量 eligible basis 最终未完成；它们必须按最早断点解释，不能为了提高发生率强行成功。

### 修订

出现以下任一情况，判为修订而非接受：

- 定向规则链可达且负例隔离正确，但自然矩阵完整链为 0；不得换种子、抬分或强制制造事件；
- 完整链只出现在一个种子，或只停在阅读、暂定知识、实验成功但未进入项目中的某一环；
- eligible basis 很少是因为上游世界合法地缺少匹配压力、payload 或输入；应报告条件，不把零发生自动称为引擎缺陷；
- 机制级链成立，但候选包出现明显项目持锁、生产流、生存或确定性回放回归；机制证据与整体候选决定分开报告；
- 需要跨代解释但 10/30 年快照不足，则按预登记补三种子 20 年中间截面后再决定。

### 拒绝

若成功主要来自无需求读写、阅读直接给可靠技术、自动补材料/产物/项目进度、重复 basis 刷置信度、文明指标反馈、同步/异步模型参与规则结果、单个友好种子筛选，或任何无法修复的权威状态破坏，则拒绝候选。

## 10. 结果报告模板

```text
Hypothesis: RecordUseBasis 将当前局部问题连接到实体记录和本人核验
Baseline revision and matrix: <最终冻结 v20 artifact/revision>
Candidate revision and matrix: <v21 artifact/revision>
Aggregate funnel by horizon: eligible → shared → read → reproduced → verified → project-progressed
Paired-seed result: 185 / 20260815 / 20260816
Representative complete chain: demand → payload → carrier/codebook/input → read → +18 experiment → project
Representative earliest broken chain: <首个缺失环节>
Hard guards and regressions: <全部零项与非零异常>
Model usage: calls / input / output / charged tokens
Decision: accept / revise / reject
Next falsifiable bottleneck: <不得用结果倒推新目标>
Artifact paths: state / evolution / report / matrix / comparison
```

结果报告必须把自然发生率、定向可达性、机制级决定和候选包决定分开。能力里程碑与文明指数只能出现在“下游观察”附录，不能进入上述接受链或改变决定。

## 11. 真实结果（2026-08-15）

### 11.1 实现边界

候选新增 `RecordUseBasis`，把读者、异人作者、active project、payload/codebook、canonical technique、真实实验动作、输入来源与项目来源保存在同一结构中。普通无需求的 `read-record/share-record` 被移除；记录使用只以显式 interrupt child 暂停原项目，先真实 `attend`，再由同一读者执行当前真实材料动作，最后按同一事件记录项目进展并返回原 intent。

阅读仍只产生 `<55` 的暂定技术；成功物质动作继续使用既有 `+18`，没有自动物资、自动产物、自动项目或文明指标反馈。行为观察器升为 `causal-person-month-v14`。

### 11.2 定向可达性

正例 fixture 真实完成了：异人持有长矛技术记录 → 对应捕猎安全项目与足量石制工具/木材 → 实体转移 → understood read 后置信度仍 `<=54` → 读者亲自结合材料得到长矛并跨过 `55` → 同一项目由该 action 完成。

移除 codebook、木材、active project，换成不相关 `knowledgeId`，让作者读取自己的记录，或让读者事先可靠掌握技术时，eligible option 均为 0。项目预览没有改写权威项目。定向测试和 intent interruption 回归均通过。

### 11.3 自然矩阵

| 时程 | seed | 实体记录 | unique basis | 分享 | 阅读 | 实验 | 完整链 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 年 | 185 | 3 | 0 | 0 | 0 | 0 | 0 |
| 10 年 | 20260815 | 0 | 0 | 0 | 0 | 0 | 0 |
| 10 年 | 20260816 | 4 | 0 | 0 | 0 | 0 | 0 |
| 30 年 | 185 | 6 | 0 | 0 | 0 | 0 | 0 |
| 30 年 | 20260815 | 5 | 0 | 0 | 0 | 0 | 0 |
| 30 年 | 20260816 | 6 | 0 | 0 | 0 | 0 | 0 |

全部 record-use 守卫、既有项目/物流守卫、模型调用和 token 均为 0。候选没有出现读写死循环或孤立 suspended project intent。

30 年保存状态显示，17 份记录中大多数是木材放入空气、种子接触土壤等已经容易被本人重复发现的技术；只有 seed `20260815` 出现一份石制工具配方记录。它出现后，多名人物已经通过自己的试验可靠掌握同一技术，后续项目又常在 0～2 个月内自行完成，没有形成“仍缺可靠知识 + 异人匹配 payload + codebook + 实验输入 + 同地/持有载体”的同时条件。

更关键的因果解释来自现有项目编译器：`hypothesisPairs(project)` 按功能列出配对，而且通常把真实成功配方放在第一位。人物即使没有可靠知识，也会直接选择石制工具+木材、兽皮+绳、树叶+纤维等正确组合。因此自然历史里“项目技术缺口”很少持续存在，记录没有真实边际用途。v21 的零发生不是通过换种子应规避的偶然结果，而是暴露了更早的隐藏正确答案。

### 11.4 配对变化与决定

与冻结 v20e 的同种子 30 年矩阵相比，候选的无目的记录社交被过滤，社会 intent 均值减少 `123.33`，项目行动 person-month 均值增加 `19`，项目完成均值增加 `3`；同时移动、搜索和若干生存结果发生种子分化。由于 record-use 完整链为 0，这些变化不能归因为记录闭环，也不能用于接受 v21。

决定：**修订**。保留 `RecordUseBasis`、阅读阈值、真实实验、项目回接和全部守卫作为可达的基础设施，但 v21 没有达到“至少两个种子出现完整自然链”的预登记接受标准。下一轮不抬高阅读/分享分数，也不定向制造记录；先移除项目规划器的“正确配方优先”泄漏，让无知识试验变得基于可观察材料属性、有限且可能失败，再重新观察可靠知识与记录是否产生真实边际价值。

产物：

- `three-body/data/experiments/candidate-demand-bound-record-use-v21-quick.json`
- `three-body/data/experiments/candidate-demand-bound-record-use-v21.json`
- `three-body/data/experiments/candidate-demand-bound-record-use-v21-vs-v20.json`
