# v24 有来源的操作问题与材料角色实验

状态：机制有信号；整包拒绝。10 年门槛矩阵已完成，未进入 30 年。

## 冻结问题

v23 已经让真实 response 经实体 attend 后开启 combine / exert / expose 后续阶段，但 v23a/v23b 的三种子 10 年生产项目完成中位数都只有 `3`，低于 v21 中位数 `12 × 50% = 6` 的流畅性门槛。人物有行动、有失败、有核验，却没有稳定的操作角色概念：

- 已核验 StoneTool 后仍频繁把 Stone 当 tool、StoneTool 当 input；
- 食物项目对 Stone、Hide、BoneTool、RawMeat 施力，有限失败预算在 Fiber 进入窗口前耗尽；
- 记录项目无法稳定区分“施力工具”和“便携表面”；
- 组合阶段反复 Stone+Stone、Stone+Seed、Stone+Food，局部困境没有被分解成可说明的形态问题。

这不是缺少正确 pair 权重，也不是预算太小。直接优先 Stone+Wood、StoneTool+Fiber 或 StoneTool+Wood 会恢复 v21 的答案泄漏；直接增加尝试次数只会放大无意义动作。

## 单一因果假设

若项目把局部困境先表达为一个 **有来源的操作问题**，再依据本人眼前可观察的硬度、质量、柔软度、形态、便携性、刚核验的响应以及个人过往 response/no-response，把实体暂时分配为 tool、input 或 surface 角色，那么有限试错能更集中于合理方向，同时仍可能失败且不知道产物。

本轮只改变候选的“角色形成与排序”。v23 的三类操作、实体绑定核验、`4 / 3 / 7` 预算、世界裁决、项目完成语义、社会传播、模型使用和文明观察器口径保持不变。

## 操作问题

问题不是科技树节点，也不包含目标 material/output/rule。它必须由当前项目压力、本人持有实体和局部环境构成，并保存 source fact/key：

- `connect-manipulator-shapes`：当前功能需要更安全、可控的操纵方式，但本人没有可靠方法；尝试连接形态互补的硬质、便携或可绑定物。
- `connect-flexible-layers`：寒冷/照护压力使柔软、纤维、植物或轻质层的连接值得试验。
- `seek-local-heat`：本人持有待改善的食物且近旁没有热源；用便携硬物作为 tool，向轻软、细小、干燥形态的 input 施力。
- `shape-portable-surface`：知识中断风险存在但没有空白实体载体；用便携硬物作用于可携带、可留下痕迹的固体表面。
- `transform-subject-with-observed-heat`：近旁已有真实 hot voxel，本人把已知食物主体暴露于该实体，观察变化。

这些名称只描述人物的问题。候选中不得出现 StoneTool、Fiber、Wood、Fire、WoodTablet、CookedFood、Spear 等答案，也不得保存 expected output。

## 角色 basis

每个未知候选保存可回放的 `questionKind` 与 role basis：

- tool role：硬度、质量/便携性、是否为本人刚核验的响应物、本人是否曾用同类实体产生 response、本人是否多次以该角色得到 no-response；
- input role：柔软/纤维/植物/轻质/便携固体等与当前问题有关的可观察属性，以及个人方向性 response/no-response；
- surface role：固体、便携、不过硬、当前可持有；
- target role：只能是相邻受支撑的真实 Air 或近旁真实 hot voxel，不得虚构。

同一材料在不同问题中可以承担不同角色。角色不是世界真值：它只是人物的暂定判断，可能错误。权威执行器 response 后，角色获得一条有事件来源的正证据；no-response 只降低该人物在同类问题下对相同方向角色的偏好，不把“这个材料永远没用”写成全局规则。

个人角色经验只允许从本人 knowledge 中已经存在的 technique/no-response 事实解析操作方向，不能从 technique ID 的 output 段反推目标，也不能扫描世界规则表。可靠 exact technique 仍直接编译，不经过角色盲试。

## 禁止项

- 候选模块导入或调用 inventory/exert/exposure 权威规则、output 查询、里程碑或文明指数；
- `prepared-food → StoneTool/Fiber/Fire`、`durable-record → StoneTool/Wood/WoodTablet` 等材料级映射；
- 看到项目目标后自动补齐 tool/input、产物、知识或核验事件；
- 把 functional material tag 当成人物天然知道的成功用途；
- response 后清空 v23 失败预算，或按月份/intent/项目预览重置；
- 为通过实验而让模型裁决物质结果。模型调用为 0 时必须完整运行。

## 定向测试

1. 静态检查角色模块不导入交互规则表，不含上述正确材料链或 expected output。
2. 每个未知候选都有 questionKind、tool/input/surface role score、reason keys、实体 source keys；分数可由保存状态重算。
3. 相同局部状态与 seed 完全回放；不同 seed 仍允许合理错误先发生，首试不能被角色系统变成 100% 成功。
4. 已核验的便携硬质 response 在 exert 中作为 tool 的角色分高于把它当 input；但这条判断只来自实体属性、核验事件和个人经验。
5. `seek-local-heat` 偏好轻软/纤维/植物形态 input，仍至少构造一个有来源的错误候选；世界执行器决定是否产生热源。
6. `shape-portable-surface` 偏好便携、中等硬度固体作为 input/surface，仍不知道载体 output。
7. 同一个人以某材料承担相同方向角色多次 no-response 后，该角色在后续项目降权；另一个没有这些事实的人不继承该降权。
8. exact reliable technique、reliable no-response、三类预算、实体核验、签名去重与 JSON 持久化不回归。
9. 完整 food 与 durable-record 定向链继续通过；v18、v21、v22、v23 和 intent 中断最小回归通过。

## 配对矩阵

- 行为基线：`candidate-response-driven-inquiry-stage-v23b-quick`；
- 流畅性参照：`candidate-demand-bound-record-use-v21-quick`；
- 候选：`candidate-grounded-operation-role-v24`；
- 种子：`185, 20260815, 20260816`；
- 先运行 3 seeds × 10 年；满足继续门槛后才运行相同种子 × 30 年；
- 同规则模式，模型调用与 token 为 `0`。

## 主要观察量

- 各 question/operation 的 candidate、attempt、response/no-response 与完成链；
- role basis 覆盖率、来源缺失、分数重算不一致、tool/input 方向错配；
- 已核验 response 作为 tool/input 的次数，个人角色正负证据对下一项目排序的影响；
- StoneTool、BoneTool、Rope、Spear、Clothing、LeatherClothing、HerbalMedicine、CookedFood、WoodTablet、记录；
- 项目完成/阻塞、生产与项目 action person-month；
- 人口、生存、社会、建造、文明指数和 137 个里程碑只观察副作用，不进入人物规划。

## 10 年继续门槛

1. 全部定向测试通过；问题/角色生成与世界结果裁决分离。
2. v23 的全部来源、operation、签名、重复、预算、核验、ordinal、diff/outcome 和可靠知识守卫为 `0`；新增 role basis 守卫也为 `0`。
3. 至少两个种子出现真实 no-response，三种子合计既有首试 response，也有失败后 response；首试成功率不得为 100%。
4. 三个种子都至少完成一个生产项目，合计至少出现两类进阶成品。
5. 生产项目完成数中位数至少为 `6`（v21 10 年中位数的 50%），且不低于 v23b；项目 action person-month 中位数至少为 v21 的 60%。
6. 至少两个种子自然出现已核验 response 驱动的后续操作；成功不能只来自开局已有可靠知识。
7. 模型调用与 token 为 `0`，旧回归不破坏。

## 30 年接受条件

在 10 年门槛之外，30 年还需满足：角色经验不是每个新项目从零开始；个人失败会改变本人而不是全体的候选顺序；至少两种生产链持续出现；阻塞项目不会无限试验；社会、生存和建造没有被异常挤压。若记录或交流传播角色经验自然出现，只观察，不在本轮强制。

## 修订或拒绝条件

若角色 basis 只是正确配方的别名、项目功能直接指定成功材料、角色分读取 output/rule、全部首试成功、生产仍低于门槛、或候选通过更多无意义动作换取偶然成功，则整包修订。基础角色数据结构可以保留，但下一版本必须由最早真实断点决定。

## 结果模板

实现：`<candidate revision>`

10 年矩阵：`<artifact>`

30 年矩阵：`<artifact or stopped by preregistered gate>`

决定：接受 / 机制保留、整包修订 / 拒绝

## 实现与 10 年结果

实现版本：`candidate-grounded-operation-role-v24-quick`

证据：`three-body/data/experiments/candidate-grounded-operation-role-v24-quick.json`

同种子 `185 / 20260815 / 20260816` 的 10 年结果：

- 生产项目完成 `7 / 7 / 4`，中位数 `7`；高于 v23b 中位数 `3`，也越过预登记门槛 `6`；
- 项目 action person-month `43 / 36 / 37`，中位数 `37`，高于 v21 中位数 `28 × 60% = 16.8`；
- response `22 / 22 / 10`，no-response `29 / 17 / 19`；首试 response `6 / 6 / 4`、首试 no-response `8 / 5 / 5`，没有把角色系统变成必胜答案；
- response 驱动的后续转换 `22 / 16 / 9`；熟食 `4 / 7 / 2`，长矛 `2 / 1 / 0`，记录 `1 / 0 / 2`；
- 三个种子的模型调用、输入 token、输出 token 均为 `0`。

这些数据证明“操作问题 + 方向角色”能把 v23 的无方向试错恢复到可玩的产出水平，但不能据此接受整包。

## 拒绝原因

第一，新增守卫未归零：候选 role basis 缺失 `14 / 19 / 4`，candidate-attempt role basis mismatch `3 / 0 / 1`。缺失来自零分 subject 候选没有保存明确的 `no-fit` reason；不一致来自 action 之后个人 no-response 已改变评分，而 campaign 又重写了已经尝试过的候选 basis。历史证据必须冻结，不能随之后的知识回写。

第二，并行只读审计发现更严重的调用方泄漏：候选模块本身没有读取权威规则，但 food / durable-record 编译器仍先检查 `StoneTool` 是否存在，再用 `Fiber / Wood / Air / Fire` 决定是否进入 blind exert/expose。也就是说，正确答案从候选评分移到了“何时开启哪类问题”的调用方。v24 的生产恢复有一部分不能与这条隐藏配方门控分离。

第三，`verified-response-as-tool` 只按 material ID 归因。多个同材质实体存在时，评分和动作可能把核验奖励转移给另一件没有被 attend 的替身；这不满足实体绑定因果链。

因此 v24 决定为：**角色机制保留，整包拒绝；不运行 30 年。** v25 必须先让盲试问题选择脱离正确材料门控，把角色与核验绑定到 exact entity，并严格解析个人事实与冻结已尝试 basis，再用完全相同的三个种子重跑。
