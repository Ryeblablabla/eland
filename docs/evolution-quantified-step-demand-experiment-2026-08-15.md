# v18 带数量的当前步骤物料需求实验

状态：机制接受；整包继续修订。

## v17 最早断点

配方和执行器本身支持精确数量，但项目编译器把当前步骤压成 `materialIds[]`：它丢失数量，也混淆“同时需要”和“任选一种”。物流 episode 只要库存比起点增加就算成功，每次固定最多拿 3 个。

v17 真实历史仍有：

- seed 185 的熟食项目在已有 45～60 份 Fiber 时继续开 drop episode；
- seed 20260816 的熟食项目在已有 51、81 甚至 102 份 Fiber 时仍继续取得；
- v16 的定向审计中，Wuzetian 一次熟食项目取得 Fiber×54 才生火；Usagi 一个项目制造 15 把 StoneTool，却只需一次生火。

这不是资源稀少，而是 `当前步骤缺口 → 数量需求 → 搬运量 → 步骤满足` 之间没有结构化事实。

## 单一因果假设

项目只应为当前已知且可执行的下一步保存定量需求，不提前泄露整条隐藏配方：

- `ProjectMaterialDemand` 保存 material、required、available-at-compile、outstanding、分支 key 和来源；
- 已知配方按真实 input quantity 计算 deficit；未知试验按实际 pair 数量计算；替代材料保持 OR 分支，不能被当作 AND；
- drop episode 保存该次 `requestedQuantity` 与起始库存，只取得 `min(outstanding, source.quantity)`；非正 outstanding 不能建立 episode；
- 当前步骤一旦满足，编译器必须转向加工、建造或验证，不能继续搬同料；
- 熟食项目在已有 StoneTool 时只缺 Fiber×1，不再回到 Stone+Wood 假设制造额外工具；
- 生存动作仍可消耗库存，下一次编译据当前真实数量重算，不为项目创造不可侵犯的资源所有权。

本版不实现跨项目 drop claim。两个项目仍可能竞争同一来源，该断点留给后续独立实验。

## 预登记矩阵

- 基线：`candidate-cross-project-search-memory-v17-observer-v10`；
- 候选：`candidate-quantified-step-demand-v18`；
- 种子：`185, 20260815, 20260816`；
- 三种子 × 10 年快速诊断，三种子 × 30 年最终配对；
- 模型调用与 token 为 0。

主要指标：带 demand 的 drop episode 覆盖率、requested/transfer quantity、建立时已有量、同项目同阶段的重复取得、prepared-food 项目 Fiber 最大起始量和 StoneTool 产出；并检查 search、项目完成/阻塞、生产链和 v12～v17 护栏。

接受护栏：

- 定向测试证明重复输入与双输入配方按真实数量形成 deficit；替代材料只选一支；
- demand 覆盖率 100%，非正 outstanding、transfer 超 requested、material/actor/project/source 错配为 0；
- 熟食在已有 StoneTool 时需求为 Fiber×1；取得一份后不再为同一步搬 Fiber 或制作额外 StoneTool；
- 不阻止真实材料取得、未知试验、建造逐块需求或生存抢占后的重编译；
- v17 跨项目重搜和其他既有完整性护栏保持为 0。

不要求某种产物、项目完成、人口或文明指数上升。若定量需求暴露世界缺料，应诚实阻塞并进入资源生成、替代材料或协作诊断。

## 结果与决定

保存产物：

- 10 年快速诊断：`data/experiments/candidate-quantified-step-demand-v18-quick.json`；
- 30 年候选：`data/experiments/candidate-quantified-step-demand-v18.json`；
- v10 观察器重投影：`data/experiments/candidate-quantified-step-demand-v18-observer-v10.json`；
- 与 v17 的同种子配对：`data/experiments/candidate-quantified-step-demand-v18-vs-v17.json`。

三组 10 年和三组 30 年运行均到达边界，模型调用和 token 均为 0。30 年候选的 drop/search demand 覆盖率均为 100%；非正缺口、数量不平、起始库存不符、请求或搬运超量、材料/人物错配、未解析事件，以及 v17 的跨项目重搜护栏，在三个种子中全部为 0。

目标行为发生了结构性变化：

- 熟食 Fiber drop episode 为 `62/26/107 → 8/17/12`；
- episode 建立时已经持有 Fiber 的次数为 `54/13/98 → 0/0/0`，最大已有量为 `60/18/102 → 0/0/0`；
- 每次 Fiber 请求恒为 1；熟食项目多造 StoneTool 的项目数为 `3/3/4 → 0/0/0`，额外 StoneTool 为 `18/38/24 → 0/0/0`；
- 三个种子仍产出 `13/17/12` 份熟食，完成生产项目为 `22/29/20`，并非用停止生产换取护栏通过。

配对中位数同时显示：完成项目 `28 → 31`、生产项目 `17 → 22`、项目行动人月占比 `19.06% → 23.56%`；移动占比 `77.61% → 77.13%`。建造完成中位数 `10 → 7`，文明指数 `56.27 → 51.34`，均作为不利结果保留，不能用观察器分数替代机制判定。

决定：接受“当前步骤的分支与数量必须成为可审计事实”这一机制，整包继续修订。新的最早断点不是 drop 认领：v18 中只有 seed 185 出现 1 次跨项目来源失效，且没有因此产生移动浪费；贸然加入认领缺少足够证据。更稳定的断点是 search episode 中位数 `243 → 458`，其中候选的 1178 次需求搜索指向 Wood。代表历史中，人物已经因熟食或记录明确缺 Wood，视野内世界也存在可分离树木，但项目编译器只会追逐地面 drop 或逐格搜索，不能调用普通生活层已有的“从树木分离木材” affordance。v19 应先打通 `定量需求 → 可见世界来源 → 分离 → 地面产物 → 精确取得`，而不是继续扩大搜索预算。
