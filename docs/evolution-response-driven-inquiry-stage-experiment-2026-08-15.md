# v23 响应驱动的分阶段探究实验

状态：已预登记，尚未运行候选矩阵。

## 冻结问题

v22 已经证明人物能够在不读取权威配方表的前提下，对本人持有或当前可见的材料作有限、可失败、可回放的尝试。三种子 10 年中出现 `86` 次项目试验，其中 `64` 次无反应，全部来源、预算、去重和知识守卫为 `0`。但生产项目完成从 v21 的 `12/14/12` 降为 `1/0/0`，长矛、熟食、药物和记录近乎全部消失。

最早因果断点不是候选分数不够准，而是 **4 次预算覆盖整个多阶段项目**。StoneTool、BoneTool 或 Rope 等真实响应只被当作一次已消耗尝试；新物质没有成为下一种局部操作的证据，项目也不能从 combine 转向 exert，再从真实火源转向 expose。提高 Stone+Wood、StoneTool+Fiber 或 Fiber+Fire 的固定权重会重新引入答案泄漏，因此不属于本轮候选。

## 单一因果假设

若一次未知物质操作产生真实响应，人物先核验响应；被核验的新物质或新技术随后成为同一项目中一个新的局部 affordance stage。人物可以围绕这项新证据尝试另一种眼前可执行的操作，但无反应成本、响应阶段数和总尝试数仍然有限，不能按月份、intent 或项目重编译无限刷新。

本轮只检验“真实响应能否让多阶段探究继续”。不同时改造功能完成语义、社会传播、记录采用、模型规划、动物生态或文明指数。

## 人物可见的因果链

1. 身体、照护、狩猎、食物或知识保存压力形成项目；这仍是项目的唯一动机来源。
2. 人物只从本人持有、当前可见且可达的实体材料生成候选；候选只使用相态、硬度、质量与可直接观察的粗粒度形态。
3. combine 的真实响应产生新物质与暂定技术；项目必须先通过 attend 核验该实体结果。
4. 核验后的新物质允许开启下一操作 stage。新物质参与的候选可以获得“刚观察到变化”的局部新颖性加权，但不得知道该候选会产生什么。
5. 对眼前相邻空气的 exert 只能从本人持有的工具、输入物和一个真实可放置位置形成；是否出现 Fire、WoodTablet 或无反应仍由世界规则裁决。
6. 对眼前真实 Fire 的 expose 只能在火已存在且本人持有待暴露物时形成；火不存在时不得假想 exposure，也不得从目标成品反推。
7. 可靠 technique 或可靠 no-response 仍优先于盲试：前者可精确复现，后者抑制相同操作签名。

## 有限预算

同一项目、同一 owner 的 campaign 保存三种互不替代的上限：

- 无反应预算：最多 `4` 次；response 不返还已经消耗的无反应额度。
- 响应阶段预算：最多 `3` 次真实 response；只有真实输出且随后可核验，才可能带来下一阶段候选。
- 总尝试预算：最多 `7` 次；无论 response/no-response 都计入。

到达任一相关上限后，campaign 不再生成新的盲试。纯月份推进、intent 中断/恢复、项目预览、物品搬运、重复 attend 和同项目重编译都不能刷新预算。若项目已完成、阻塞或放弃，campaign 关闭；已经耗尽的状态不能被较弱的关闭原因覆盖。

## 候选空间与分离边界

允许的未知操作：

- `combine-inventory`：两个实际持有或当前可见可取得的材料单位；
- `exert-air`：实际持有的工具、实际持有的输入物与相邻、受支撑、未占用的 Air 体素；
- `expose-local`：实际持有的输入物与近旁真实存在的热源体素。

候选可根据硬度对比、固体形态、轻重、纤维/植物形态、是否包含刚刚响应得到的材料和稳定 seeded perturbation 排序。不得导入或间接查询 `inventoryCombinationRules`、`exertionRuleFor`、`exposureRuleFor`、目标 output、技术 ID 或文明里程碑缺口。

未知候选模块不负责物质结果。执行器仍是唯一权威裁决者，并将 completed/blocked、输入、工具、目标、输出与事件 ID 写入事实。模型不能裁决物质合法性，模型为 0 调用时机制必须完整运行。

## 定向测试

1. 静态检查未知候选模块不导入交互规则表，不含按项目写死的 Stone/Wood/Fiber/Fire 等正确链。
2. 同一局部状态、人物、项目和 seed 的候选顺序可回放；不同 seed 至少出现两种顺序，并存在合理错误先于成功的条件。
3. combine response 经实体 attend 核验后，包含真实新产物的下一阶段候选才可出现；blocked、伪造 diff 或只推进月份不能开启阶段。
4. exert 候选只引用本人实际持有的工具/输入和相邻真实 Air；expose 只引用实际存在的近旁 Fire。
5. 同一操作签名在同项目不重复；可靠个人 no-response 跨项目抑制；可靠 technique 直接编译而不冒充盲试。
6. 无反应不超过 4、响应不超过 3、总尝试不超过 7；JSON 保存/恢复和 intent 中断后均不重置。
7. 至少一条定向 food chain 能经过“未知 combine 响应 → 核验 → 未知 exert（可先失败）→ 核验真实火源 → expose → 熟食”完成，且每个物质输出都来自执行器。
8. 至少一条 durable-record chain 能从响应得到工具，再经未知 exert 得到实体载体并完成记录；已有可靠点火/刻写经验的旧路径不回归。
9. v18 数量需求、v16/v17 搜索、v20 住所、v21 record-use、v22 试错与 v13 intent 中断最小回归继续通过。

## 配对矩阵

- 机制基线：`candidate-fallible-material-hypothesis-v22-quick`；
- 流畅性参照：`candidate-demand-bound-record-use-v21` 同种子 10 年结果；
- 候选：`candidate-response-driven-inquiry-stage-v23`；
- 种子：`185, 20260815, 20260816`；
- 先运行 3 seeds × 10 年；只有达到下述继续门槛才运行相同种子 × 30 年；
- 30 年通过后再决定是否扩展 50/100 年，本轮不挑选友好种子；
- 同规则模式，模型调用和 token 应为 0。

10 年是 v23 对 v22 的共同前缀配对，不与之后同种子的 30 年当作独立样本。v21 只作为已冻结的流畅性参照，不重新调参以迎合候选。

## 主要观察量

- campaign、combine/exert/expose 各自尝试、response、no-response、响应后新 stage、耗尽原因；
- 首试成功率、成功前失败数、操作签名多样性、同项目重复、三类预算越界；
- 每个候选的实体来源、工具/输入/目标可达性、真实 action diff 与输出；
- StoneTool、BoneTool、Rope、Spear、Clothing、LeatherClothing、HerbalMedicine、CookedFood、WoodTablet 与记录的产量和首次月份；
- 项目完成/阻塞/持续月份，生产、搜索、移动和项目 action person-month；
- 人口、死亡、出生、住所、动物冲突、社会行为、文明指数与 137 个因果里程碑只作为副作用观察，不进入人物规划。

## 10 年继续门槛

全部条件同时满足才进入 30 年：

1. 定向测试通过；候选生成与权威结果裁决分离。
2. 所有项目/人物/campaign/action、来源、签名、重复、预算、ordinal、diff/outcome 与可靠知识守卫为 `0`。
3. 至少两个种子出现真实 no-response，且三种子合计既有首试 response，也有至少一次 no-response 后才出现 response。
4. 至少两个种子完成生产项目，三种子合计至少出现两类项目相关进阶成品；不能用“所有人持续试错”代替游戏流畅性。
5. 生产项目完成数的三种子中位数至少达到 v21 同种子 10 年中位数的 `50%`；项目 action person-month 中位数至少达到 v21 的 `60%`。
6. 不得恢复 v21 的项目首试 `100%` 命中；若 response-driven stage 只是隐式正确顺序，整包拒绝。
7. 模型调用与 token 为 `0`，旧来源、数量、搜索、项目、记录与 intent 守卫不回归。

## 30 年接受条件

在 10 年门槛之外，30 年还需满足：

- 至少两个种子持续出现多阶段生产完成，而不是只靠开局材料的一次偶然链；
- 每个完成链可逐事件还原动机、来源、尝试、响应、核验和下一阶段，没有自动补产物或知识；
- 项目阻塞没有因总预算提高而无限延迟，失败项目仍能真实结束；
- 生产恢复没有把照护、生存、社会和生活行为挤压到异常低位；
- 137 个里程碑和文明指数只能据实变化，不能因观察器或目标导向加分。

## 修订或拒绝条件

以下任一情况要求修订或拒绝：response 自动解锁固定的下一配方；新颖性分数读取输出规则；一个 response 重置全部失败预算；同一签名换 stack/位置后无限重试；项目在没有实体目标时虚构 exert/expose；生产仍接近 v22 的全面停摆；或为通过矩阵而向人物注入产品、知识、材料、里程碑目标。

若有限分阶段基础设施正确但自然流畅性仍失败，允许机制级保留、整包继续修订，并以最早历史断点定义 v24。

## 结果模板

实现：`<candidate revision>`

10 年矩阵：`<artifact>`

30 年矩阵：`<artifact or stopped by preregistered gate>`

配对比较：`<artifact>`

决定：接受 / 机制保留、整包修订 / 拒绝

## 真实实现

候选最终形成 `project-hypothesis-campaign-v2`：同项目保存 `combine-inventory / exert-air / expose-local` 三种有方向的操作签名，无反应、响应和总尝试上限分别为 `4 / 3 / 7`。候选模块不导入交互规则表，只读取本人持有或当前可见实体的相态、硬度、质量与粗粒度形态；权威执行器仍唯一决定 Fire、WoodTablet、CookedFood 或 no-response。

实现审计发现同月核验旁路：响应事件到月末才进入 `world.past`，但项目同月可以继续执行。最终实现没有用“置信度已经升高”代替核验，而是在 attempt 上保存执行器产生的 `techniqueId + responseRef + sourceEventId`；attend 必须引用同一响应事件、同一背包 stack 或同一 voxel 与同一材料，执行器回写 `verifiedSourceEventId` 后才标记 `verifiedEventId`。未核验响应不会得到 `verified-response-material` 候选加权，也不能合法开启下一操作 stage。

定向链通过：

- `Stone+Wood response → attend StoneTool → StoneTool 对局部 Air 施力 → attend Fire → Food/RawMeat expose 真实 Fire → CookedFood`；
- `Stone+Wood response → attend StoneTool → StoneTool 对便携固体施力 → attend WoodTablet → 写入有来源知识`；
- 三类预算、跨项目可靠 no-response、同签名去重、JSON 持久化、规则表隔离与 v18/v21/v22/v13 回归均通过。

## 10 年候选矩阵

冻结种子均为 `185, 20260815, 20260816`，模型调用与 token 为 `0`。v23a 首轮发现“食物主体”加权被误用于所有操作，人物会优先把生肉与石头 combine；v23b 将该加权收窄到真实火源存在后的 expose。验收门槛未改变。

| 候选 | 生产项目完成 | 全部项目完成/阻塞 | response / no-response | combine / exert / expose | 已核验响应 | 响应驱动后续尝试 | 长矛 | 熟食 | 记录 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v23a seed 185 | 6 | 13 / 15 | 15 / 55 | 46 / 20 / 4 | 10 | 10 | 0 | 4 | 1 |
| v23a seed 20260815 | 3 | 9 / 22 | 11 / 87 | 86 / 9 / 3 | 8 | 7 | 1 | 3 | 0 |
| v23a seed 20260816 | 2 | 14 / 8 | 4 / 34 | 26 / 11 / 1 | 3 | 1 | 0 | 1 | 1 |
| v23b seed 185 | 5 | 12 / 8 | 19 / 46 | 43 / 19 / 3 | 15 | 24 | 0 | 3 | 1 |
| v23b seed 20260815 | 3 | 5 / 15 | 15 / 53 | 41 / 25 / 2 | 13 | 19 | 0 | 2 | 1 |
| v23b seed 20260816 | 1 | 13 / 11 | 3 / 43 | 26 / 20 / 0 | 3 | 4 | 0 | 0 | 1 |

全部项目/人物/campaign/action、operation、签名、来源、重复、三类预算、ordinal、diff/outcome 与可靠知识守卫均为 `0`。三种子既有首试 response，也有首试 no-response；每个种子都出现大量真实失败。v23a 三种子均完成生产项目并出现熟食、长矛和记录三类结果，证明分阶段机制自然可达；v23b 也出现熟食和记录，但没有稳定抬高整体完成率。

流畅性门槛失败：v21 同种子 10 年生产项目完成为 `12 / 14 / 12`，中位数 `12`；预登记要求 v23 中位数至少 `6`。v23a 为 `6 / 3 / 2`，v23b 为 `5 / 3 / 1`，二者中位数均为 `3`，只达到 v21 的 `25%`。项目 action person-month 中位数分别为 `41 / 37`，均高于 v21 的 `28 × 60%` 下限，说明人物不是没有行动，而是操作角色假设仍然过于混乱。

真实成功链已经不再机械：seed 185 的一个 food project 先经历 `Wood+Fiber` 无反应，再做出并核验 StoneTool；随后对 RawMeat、Food 施力均无反应，才由 StoneTool+Fiber 得到并核验 Fire，最后 Food+Fire 产生 CookedFood。另一个 durable-record project 经 Stone+Wood、核验工具、StoneTool+Wood、核验载体后写入记录。失败链也保留：不少人物做出并核验 StoneTool 后，仍把 Stone、Hide、BoneTool 当作施力输入，或把 Stone 当工具、StoneTool 当输入；全局 4 次 no-response 很快耗尽。另一些项目先反复 Stone+Stone、Stone+Seed、Stone+Food，正确的 Stone+Wood 没进入有限窗口。

最早剩余断点因此不是“再加尝试次数”，而是 **人物只有无方向的材料分数，没有可学习、可说明的操作角色问题**。一个便携硬质响应物没有稳定成为 manipulator；食物项目没有把“获得热源”分解成“便携硬物作为工具、轻软干燥物作为输入”；记录项目也没有稳定区分工具与可刻写表面。直接提高 StoneTool+Fiber 或 StoneTool+Wood 的 pair 权重会重新泄漏答案。

决定：**接受 v23 的多操作 campaign、实体绑定核验、响应后候选来源、有限三类预算与 observer 守卫；拒绝整体流畅性，按预登记停止 30 年。** v24 单独检验“由局部困境形成操作问题，并给实体分配可观察、可学习的 tool/input/surface 角色”，不得写入正确材料或产物。

产物：

- `three-body/data/experiments/candidate-response-driven-inquiry-stage-v23-quick.json`
- `three-body/data/experiments/candidate-response-driven-inquiry-stage-v23b-quick.json`
- `three-body/data/experiments/candidate-response-driven-inquiry-stage-v23b-vs-v23a-quick.json`
- `three-body/data/experiments/candidate-response-driven-inquiry-stage-v23b-vs-v21-quick.json`
