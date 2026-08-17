# v25 实体绑定且无调用方配方门控的操作问题实验

状态：10 年机制通过；30 年整包拒绝，不进入 50/100 年。

## 冻结断点

v24 的三种子 10 年生产项目完成中位数从 v23b 的 `3` 恢复到 `7`，说明 tool/input/surface 暂定角色有用；但 v24 不能接受：

1. food 与 durable-record 调用方仍以 `StoneTool / Fiber / Wood / Air / Fire` 决定未知人物何时进入某类盲试，候选模块虽无规则查询，问题选择本身仍泄漏配方；
2. 已核验 response 按 material ID 奖励，可能把证据转移给同材质的另一实体；
3. 已尝试候选会在个人获得新 no-response 后被刷新重写，历史 basis 不再等于行动发生时的判断；
4. technique/no-response ID 解析允许缺段、多段和未知材料 ID；零分候选没有明确 `no-fit` reason。

## 单一因果假设

若项目只凭当前困境、真实 subject/target、本人持有或看见的具体实体与严格可解析的个人经验来开启操作问题，并把核验奖励、角色 source key 和最终动作绑定到同一实体，那么 v24 的流畅性提升可以在不依赖调用方隐藏配方的情况下保留；失败仍由世界规则产生，人物仍不知道产物。

严格解析、basis 冻结和零分 `no-fit` reason 是因果账本正确性修复，不作为额外玩法杠杆。v23 的 `4 / 3 / 7` 预算、response 实体 attend、世界结果裁决、项目完成语义、模型缺省和文明观察器隔离保持不变。

## 候选机制

### 问题选择

- `prepared-food` 有真实待改善 subject 且近旁已有真实 hot voxel：开启 `transform-subject-with-observed-heat`；subject 由该 inventory stack 的 source key 指定，不由 edible output 表决定。
- 没有 hot voxel但存在可评分的 held tool/input：直接尝试 `seek-local-heat`；不存在可执行候选才回到 `connect-manipulator-shapes`，不得先检查正确工具是否已经制造。
- `durable-record` 有待保存的可靠知识但没有空白 record carrier：直接尝试 `shape-portable-surface`；不存在可执行候选才回到组合问题，不得先检查正确工具或正确表面材料。
- 可靠 exact technique 可读取本人已核验的完整输入、target 与结果来直接执行或形成缺料需求；这是知识使用，不是盲试提示。未知分支不得查询权威 output。

### 实体角色

候选除 material ID 外保存 `toolSourceKey / inputSourceKey`；surface 问题另存显式 surface role。核验奖励只在所选 source key 等于该 response attempt 的 exact `responseRef` 时成立。执行动作优先使用同一个 source key；若地面实体已按物流取得，可退化为当前同材质 stack，但不得保留“exact verified”奖励。

角色先验只使用 phase、`solid / fiber / plant`、hardness、mass、项目 subject source 和个人方向性 response/no-response。不得使用 `tool / tool-material / recordable / fuel / flammable` 作为未知人物天然知道的成功用途。`recordable` 仅可用于本人已有可靠 technique 后的直接执行或已存在 carrier 的现实功能检查。

评分扰动缩到 `(seededFraction - 0.5) × 3`；exact verified entity 只提供有限加分，不把 response 变成必然正确的下一个答案。具有相同可观察属性、但没有权威响应的 decoy 应得到相同 `observableScore`。

### 事实与历史

- technique/no-response ID 必须完整锚定、段数准确、全部材料 ID 为已登记安全整数；output 段只验证语法与登记存在，不返回给未知角色评分；
- combine technique 只接受总输入量为 2 的规范签名，不按不受控 quantity 展开数组；
- attempted 或 active candidate 的 question、role score、reason 与 entity source keys 一旦用于行动就冻结；后续经验只重排尚未尝试的候选；
- 任何零分候选保存明确 `role-*-no-observed-fit`，零分不是缺失 basis。

## 禁止项

- 在 blind food/record 分支以 `StoneTool / Fiber / Wood / WoodTablet / Fire` 的存在决定问题阶段；
- 候选模块读取 interaction rule、expected output、文明指数或里程碑；
- 仅因 material ID 相同就继承 exact response 核验奖励；
- action 执行另一实体但 diff/attempt 仍声称使用已核验实体；
- response 后重置失败预算，或由模型裁决物质结果；
- 为通过矩阵改种子、只保留成功历史或放宽 v24 的流畅性门槛。

## 定向测试

1. 静态检查同时覆盖候选模块与项目调用方；未知 food/record 分支没有正确材料门控，可靠 exact technique 分支仍可直接编译。
2. 五类 question 的 candidate/attempt/action diff 都保存一致的 entity source role basis；surface 显式可区分于 generic input。
3. exact responseRef 的实体作为 tool/input 时可得到有限证据；同材质替身不能继承，实际 action 使用候选保存的实体。
4. malformed、缺段、多段、未知 ID 的 technique/no-response 不改变评分，也不成为可靠 exact technique。
5. no-response 写入后，已尝试候选 basis 与 attempt 保持一致；未尝试候选可按本人的新经验重排，另一人不继承。
6. 无 StoneTool 但有真实硬物与合适 input 的 food/record fixture 仍能开启 exert question；世界可以 no-response。
7. 相同可观察属性 decoy 的 `observableScore` 相同；置换权威 output 不改变未知评分。
8. v18、v21、v22、v23、v24 与 intent 中断最小回归通过；模型为 0 时完整运行。

## 配对矩阵

- 直接基线：`candidate-grounded-operation-role-v24-quick`；
- 无泄漏流畅性参照：`candidate-response-driven-inquiry-stage-v23b-quick`；
- 历史流畅性上界：`candidate-demand-bound-record-use-v21-quick`；
- 候选：`candidate-entity-bound-operation-question-v25`；
- 种子：`185, 20260815, 20260816`；
- 先运行 3 seeds × 10 年；只有全部门槛通过才运行同种子 × 30 年；
- chaos `0`、模型调用和 token 必须为 `0`。

## 10 年继续门槛

1. 全部定向测试通过；blind 调用方材料门控静态/行为守卫为 `0`。
2. v23/v24 的来源、operation、签名、重复、预算、核验、ordinal、diff/outcome、role basis 和 exact entity 守卫全部为 `0`；candidate/attempt role coverage 均为 `100%`。
3. 至少两个种子有真实 no-response；合计既有首试 response，也有失败后 response；首试成功率不是 `100%`。
4. 每个种子至少完成 1 个生产项目，合计至少 2 类进阶成品；生产完成中位数至少 `6` 且不低于 v23b。
5. 项目 action person-month 中位数至少为 v21 的 `60%`；至少两个种子有 exact verified entity 驱动的后续操作。
6. 同材质替身归因 violation 为 `0`；已核验实体作为 tool 的自然使用不能少于 2 个种子。
7. 模型调用与 token 为 `0`，人口、生存、建造和社会没有新的明显系统性坍塌。

## 30 年接受条件

除 10 年门槛外，个人角色经验跨项目持续生效；至少两条生产链继续出现；项目不会因找不到正确材料而无限盲试；exact entity 证据不随转移、合堆或同材质替身漂移；无调用方隐藏配方回归。若不满足，冻结真实断点进入 v26。

## 10 年候选结果

冻结产物：`three-body/data/experiments/candidate-entity-bound-operation-question-v25-quick.json`。种子顺序均为 `185 / 20260815 / 20260816`。

| 观察量 | 三次结果 | 门槛判断 |
| --- | --- | --- |
| 生产项目完成 | `7 / 8 / 5`，中位数 `7` | 通过；每个种子至少 1，且不低于 `6` |
| 项目行动人月 | `42 / 27 / 38`，中位数 `38` | 通过；高于 v21 中位数 `28` 的 60%（`16.8`） |
| response / no-response | `22/44 / 21/23 / 10/20` | 通过；三个种子均有真实失败与响应 |
| 首试 response / no-response | `8/11 / 7/8 / 3/6` | 通过；首试成功率不是 100% |
| 已核验 response / 后续迁移 | `15/20 / 14/14 / 7/5` | 通过 |
| exact entity 作为 tool | `15 / 10 / 3` | 通过；三个种子均自然发生 |
| exact entity 作为 input | `1 / 0 / 0` | 观察项；不是继续门槛 |
| 候选/尝试/action diff 实体 basis 覆盖 | `100% / 100% / 100%`（每个种子） | 通过 |
| 同材质替身归因 violation | `0 / 0 / 0` | 通过 |
| 进阶成品 | 长矛 `11/5/0`；熟食 `5/7/3`；记录 `0/1/2` | 通过；合计三类 |
| 人口 / 文明指数 | `7/42.37 / 7/42.87 / 14/52.56` | 无新系统性坍塌 |
| 模型调用 / token | 全部 `0` | 通过 |

来源、operation、签名、重复、预算、核验、ordinal、diff/outcome、role basis、可靠知识和 exact entity 的全部预登记守卫均为 `0`。10 年候选因此通过继续门槛；这只接受“无泄漏且实体证据一致”的局部机制，不代表文明上限已经提高。

矩阵过程中还暴露了实验脚本问题：长前缀与长种子拼接后可能超过后端 64 字符 run id 限制。skill runner 已改为按实际后缀确定性截断前缀，并通过长前缀 dry-run；失败的首轮创建不计入本结果。

## 30 年候选结果与决定

冻结产物：`three-body/data/experiments/candidate-entity-bound-operation-question-v25-30y.json`。种子顺序仍为 `185 / 20260815 / 20260816`。

| 观察量 | 三次结果 | 判断 |
| --- | --- | --- |
| 人口 / 文明指数 | `12/55.86 / 6/52.21 / 18/64.80` | 未灭绝，但指数不能替代因果审计 |
| 生产项目完成 | `11 / 13 / 14` | 短期流畅性没有消失 |
| 项目行动人月 | `166 / 102 / 123` | 人物持续投入真实行动 |
| campaign / exhausted | `75/56 / 48/35 / 65/49` | 失败；耗尽占绝大多数 |
| response / no-response | `34/246 / 31/132 / 34/201` | 失败不是被掩盖，但长期搜索失去边界 |
| exact entity 作为 tool / input | `16/6 / 17/1 / 10/13` | 实体角色机制跨项目继续发生 |
| 同材质替身归因 violation | `0 / 0 / 0` | 实体归因机制通过 |
| 实体 basis 覆盖 | seed 185 candidate `99.78%`、attempt/action `99.64%`；其余 `100%` | 守卫失败；3 个总分归零候选缺显式 no-fit，1 个进入行动 |
| 项目启动 / 完成 / 阻塞 | `89/22/61 / 59/23/33 / 88/32/52` | 失败；阻塞不是少数边缘事件 |
| 记录读/验证/完整使用链 | 三种子全部 `0` | 载体出现但没有形成跨人知识闭环 |
| 模型调用 / token | 全部 `0` | 规则闭环可独立运行 |

最早的长期因果断点不是“没有正确配方”，而是功能探究没有跨项目的机会记忆：

- 同一人物、同一功能在没有新能力机会时额外重开项目 `58 / 32 / 45` 个；
- durable-record 启动/完成/阻塞为 `42/1/36 / 17/3/13 / 32/4/26`；
- prepared-food 启动/完成/阻塞为 `29/7/21 / 28/10/17 / 31/8/22`；
- 个人对同一材料签名通常只重复两次，第二次会把 no-response 提升为可靠经验；真正浪费来自“项目结束后，功能问题在没有新材料类型、可靠知识、目标环境或已核验 response 时再次开启”。

因此 v25 接受以下机制：严格事实解析、attempted basis 冻结、exact source key 角色与核验、未知调用方去配方门控。整包拒绝，且不进入 50/100 年。三个零总分候选缺 no-fit 是记账缺口，随下一版基础修复；行为断点进入 v26 的“功能探究机会记忆”，不能靠缩预算、降低项目压力或隐藏正确材料解决。
