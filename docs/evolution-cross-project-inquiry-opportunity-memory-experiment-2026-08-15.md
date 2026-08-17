# v26 跨项目功能探究机会记忆实验

状态：机制有信号；10 年整包拒绝，未进入 30 年。

## 冻结断点

v25 已证明无配方泄漏的 exact-entity 角色试错可以恢复短期生产：三种子 10 年生产项目完成 `7 / 8 / 5`，同材质替身归因为 `0`。但 30 年出现新的最早断点：

- hypothesis campaign `75 / 48 / 65`，其中 exhausted `56 / 35 / 49`；
- 同一人物、同一 desiredFunction 在没有新能力机会时额外重开项目 `58 / 32 / 45`；
- durable-record 启动/完成/阻塞 `42/1/36 / 17/3/13 / 32/4/26`；
- prepared-food 启动/完成/阻塞 `29/7/21 / 28/10/17 / 31/8/22`；
- 同一材料签名通常只会试两次，第二次 no-response 已成为可靠经验；浪费主要来自项目终止后，功能问题因时间、新 targetKnowledge 或同类型的新 subject 再次从头开启。

另有一个不改变行为的记账缺口：seed 185 有 3 个 aggregate roleScore 恰好归零的候选没有显式 `role-*-no-observed-fit`，其中 1 个进入行动，使 entity basis 覆盖降为 `99.78% / 99.64% / 99.64%`。该缺口作为 v26 基础修复，不算玩法杠杆。

## 单一因果假设

若人物在功能探究耗尽后保存“本人对这一功能已经探索过哪些可观察机会”，并且只有出现从未探索过的正向机会时才重开同功能项目，那么人物可以停止按日历循环同一困境，同时仍会因新材料类型、新可靠技术、新的真实目标环境或新的已核验 response 重新尝试。

记忆属于人物，不属于文明；另一人物不会天然继承。文明指数、里程碑、权威配方和 expected output 不进入机会判断。v25 的 exact source key 仍只用于候选证据和具体行动，不因为机会记忆按材料类型归纳就把核验奖励转移给同材质实体。

## 机会 basis

每个 inquiry/production 项目保存结构化 `ProjectInquiryOpportunityBasis`，至少包含：

- actor、desiredFunction、形成月份和稳定 basis key；
- 本人已持有或局部看见过的候选材料类型；同材质新 stack/drop 不产生新机会；
- 与该功能有关且本人可靠掌握的严格 technique ID；no-response 只收缩候选，不算正向新机会；
- 当前可接触的特殊 target 环境，例如具体 hot voxel；新的真实 target 可以产生机会，时间流逝不能；
- 本人核验过的 response/technique 来源事实；仅 material ID 相同不能冒领 exact-entity 奖励；
- 所有用于 basis 的来源事件或世界引用必须可解析，且不得来自未来。

项目因 hypothesis exhausted 或无可执行候选而阻塞时冻结终止 basis。之后生成同 actor、同 desiredFunction 提议时，比较此人所有相关失败项目已经探索过的机会并集：

- 当前只有旧机会、机会减少、同材质新实体、年龄增长、targetKnowledge 改变或时间过去：不重开；
- 出现新的材料类型、本人新学会的可靠技术、此前不存在的特殊 target，或新的本人核验 response：允许重开，并记录 `renewalKeys` 与来源；
- 已存在可直接完成功能的现实资源或可靠技术时，允许直接使用，不被失败记忆永久封死；
- 另一人物有自己的记忆与试错预算；通信或记录只有在其真实学习后才能改变 basis。

## 候选继承

- 新项目继承本人同功能旧 campaign 的已尝试 signature 与可靠 no-response；可靠 no-response signature 不再进入候选。
- 第一次 no-response 仍可在个人证据尚不可靠时复试一次；达到可靠阈值后不得因换项目、换同材质实体或换 targetKnowledge 再试。
- 若由新机会重开，优先提出至少包含一个 renewal key 的候选；旧候选不能挤占整轮预算。
- 继承只改变人物会不会再问以及先问什么，不读取世界响应规则，也不保证新机会成功。

## 禁止项

- 用冷却月数、固定年龄或随机概率自动清除失败记忆；
- 把新的 RawMeat stack、同材质 drop、另一条待记录知识或压力数值变化当作新制作能力；
- 用文明指数、里程碑缺口、配方 output、`recordable/fuel/tool` 隐藏用途提示 blind 分支；
- 全文明共享个人失败，或把另一人的 response 当成本人的 exact evidence；
- 为压低项目数直接提高项目门槛、缩短预算、删除真实困境或把失败项目算完成；
- 成功一次后永久禁止同功能的合理复用。

## 定向测试

1. 同一人同功能 campaign exhausted 后，纯时间、年龄变化、换 targetKnowledge、同材质新 stack/drop 都不能重新提议。
2. 新材料类型、新 hot target、本人新可靠 technique 或新 verified response 分别能形成有来源 renewal；移除后再放回旧材料类型不能伪装新机会。
3. 另一人物仍可独立尝试；只有真实通信/读取/验证形成个人知识后才改变其 basis。
4. 可靠 no-response signature 跨项目不再出现；一次 tentative no-response 最多允许一次复试，且 basis/attempt/action diff 保持一致。
5. 由 renewal 开启的首批候选至少包含 renewal key；世界仍可返回 no-response。
6. 已有可直接完成功能的载体、hot target 或可靠技术不被失败记忆封死。
7. aggregate roleScore 为 0 时保存显式 no-fit reason；candidate、attempt、action diff entity basis 覆盖恢复 100%。
8. v21～v25、需求、意图中断和项目进展最小回归通过；模型为 0 时完整运行。

## 配对矩阵

- 直接基线：`candidate-entity-bound-operation-question-v25-quick` 与 `candidate-entity-bound-operation-question-v25-30y`；
- 候选：`candidate-cross-project-inquiry-opportunity-memory-v26`；
- 种子：`185, 20260815, 20260816`；chaos `0`；
- 先运行 3 seeds × 10 年，守卫通过后运行同种子 × 30 年；
- 模型调用和 token 必须为 `0`；确定性重跑只验证回放，不增加样本。

## 10 年继续门槛

1. 全部 basis、renewal、继承、个人隔离、来源、operation、签名、预算、ordinal、diff/outcome 与 exact-entity 守卫为 `0`；三层 entity basis 覆盖 `100%`。
2. 无新机会的同人同功能重开为 `0`；可靠 no-response 的跨项目重复为 `0`；至少一个定向 fixture 和自然运行证明真实新机会可以重开。
3. 每个种子至少完成 1 个生产项目，生产完成中位数至少 `6`，合计至少 2 类进阶成品。
4. 每个种子同时有 response 与 no-response；首试成功率不为 100%；exact entity 归因 violation 为 `0`。
5. 人口、生存、建造和关系无新的明显系统性坍塌；模型调用与 token 为 `0`。

## 30 年接受条件

除 10 年门槛外：

- v25 的同人同功能额外重开项目 `58 / 32 / 45` 中，无新机会部分必须归零；全部重开至少下降 70%，但由真实 renewal 产生的项目保留；
- exhausted campaign 相比 v25 每个种子下降，且不能只是把项目改名、延迟或留作永久 active；
- 至少两个种子自然出现有来源的 renewal 后再探究，至少两条生产链继续可达；
- exact entity、个人知识和失败记忆在转移、同材质替换与跨人情况下不漂移；
- 项目总数下降时，真实完成、人口和生存不能同步系统性坍塌。

通过后才讨论 50/100 年；不通过则冻结最早的新断点进入 v27。

## 10 年冻结结果

候选产物：`three-body/data/experiments/candidate-cross-project-inquiry-opportunity-memory-v26-quick.json`。与 v25 使用相同的 `185 / 20260815 / 20260816` 三个种子、10 年、chaos `0`，规则观察器为 `causal-person-month-v19`，模型调用与 token 均为 `0`。

| 指标 | v25 | v26 | 判定 |
| --- | --- | --- | --- |
| 生产项目完成 | `7 / 8 / 5`，中位数 `7` | `4 / 7 / 5`，中位数 `5` | 未达到预登记中位数 `6` |
| hypothesis campaign | `19 / 15 / 9` | `11 / 16 / 9` | seed 185 的重复探究明显下降，另外两种子无系统性恶化 |
| hypothesis 尝试 | `66 / 44 / 30` | `36 / 46 / 30` | seed 185 从 `66` 降到 `36` |
| response / no-response | `22/44 / 21/23 / 10/20` | `11/25 / 19/27 / 10/20` | 三种子仍同时存在正、负响应 |
| 无新机会重开 violation | 未实现 | `0 / 0 / 0` | 通过 |
| reliable no-response 跨项目超额复试 | 未实现 | `0 / 0 / 0` | 通过 |
| opportunity / terminal basis 覆盖 | 未实现 | 均为 `100%` | 通过 |
| renewal 项目 | 未实现 | `1 / 2 / 0` | 自然运行中出现真实 renewal |
| renewal 首候选/首试覆盖 | 未实现 | `100% / 50% / 100%` | 未通过；seed 20260815 有一次 renewal 在行动前失去可执行实体 |
| exact-entity 三层覆盖 | `100%`（10 年） | `100% / 100% / 100%` | 通过 |
| exact-entity 归因 violation | `0 / 0 / 0` | `0 / 0 / 0` | 通过 |

机制信号成立：seed 185 的非建造项目从 `19` 降至 `11`，prepared-food 从 `14` 个降至 `5` 个；同人同功能在没有新机会时不再按时间重启。三个 aggregate roleScore 恰好为零的候选也已补齐显式 no-fit，entity basis 覆盖恢复为 `100%`。

整包仍拒绝，原因不是“项目太少”本身，而是两个相连的因果断点：

1. 机会只在提议时取快照，没有成为项目必须兑现的来源承诺。seed 20260815 的 Tesla 项目由 `material:31` 开启，但对应实体在首试前已不可用，campaign 随后退回 `13+20` 等旧候选，导致 renewal 首试覆盖仅 `50%`。
2. v25 seed 185 在第 80 月出现的三次烹饪成功，来自同一人物在没有新事实时再次盲试并现场重新发明火；v26 正确阻止了这类按日历重置，却暴露出世界尚缺少“观察、记住、前往并利用他人留下的功能地点/示范”的正向机会来源。不能为恢复产量而恢复随机复试。

因此不运行 v26 的 30 年矩阵。v26 保留跨项目失败记忆、exact-entity 与零总分 no-fit 修复；v27 先把 renewal 变成 exact-source 绑定的可执行承诺：项目必须先取得新材料或抵达新目标，来源失效时不得退回旧候选。之后再以真实示范、公共功能地点或教学形成新的因果学习机会。
