# v27 renewal 机会承诺实验

状态：v27 原版 30 年拒绝；v27.1 机制与整包接受。

## 冻结断点

v26 证明跨项目失败记忆能够消除按日历重启：seed 185 的 hypothesis 尝试从 `66` 降到 `36`，无新机会重开与 reliable no-response 超额复试均为 `0`。但 3×10 年候选没有通过整包门槛：

- 生产项目完成 `4 / 7 / 5`，中位数 `5`；不能靠恢复无来源复试抬高产量；
- 自然出现 `1 / 2 / 0` 个 renewal 项目；seed 20260815 中 Tesla 的 prepared-food 项目由 `material:31` 开启，但该材料在 campaign 中没有任何仍可执行的候选，首试退回旧材料，导致 renewal 候选/首试覆盖均为 `100% / 50% / 100%`；
- 机会 basis 只记录“提议时看见过什么”，尚未证明新机会能成为项目下一步真正围绕的对象。

## 单一因果假设

若每个 renewal 不仅保存抽象 opportunity key，还保存当时的 exact source 与来源事实，并且项目只有在能编译出围绕该承诺的合法首步时才允许创建，那么“有新机会才重开”将升级为“有可执行的新机会才重开”。承诺兑现前，campaign 不得退回继承来的旧候选；来源失效时项目可以有来源地等待、失效或阻塞，但不能把旧盲试伪装成 renewal。

这仍然不读取配方、expected output、文明指数或里程碑。新材料可能失败，新火源可能熄灭；世界规则继续裁决响应。

## 结构化承诺

每个正向 opportunity 保存一个 `ProjectInquiryOpportunitySource`：

- `opportunityKey` 与 kind；
- 对材料机会保存 material ID、提议时的 exact inventory/drop source key 与其 source fact IDs；
- 对 target 保存 exact voxel key；
- 对知识保存本人可靠 technique ID 与知识来源事件；
- 对 verified response 保存核验事件与仍存在的 exact response entity；
- 对 ready record carrier 保存 exact inventory source。

新项目的 `renewalKeys` 必须能映射到至少一个来源承诺。材料类型相同但 exact source 不同，只能保持可执行性，不能再次制造新的抽象机会。

## 执行约束

1. 提议阶段先构建临时项目并编译首步。若没有任何首步使用 renewal commitment，该提议不进入决策选项，也不创建项目。
2. 首步可以是：直接使用已持有的 renewal 实体、前往/取得已锁定 drop、抵达 exact target、使用新可靠知识，或围绕已核验 response 实体形成候选。
3. 在至少一次有来源的 renewal 尝试或直接已知路径执行前，hypothesis selector 只允许 renewal 候选；没有 renewal 候选时返回空，不得 fallback 到旧候选。
4. exact drop 被取得后，允许通过 source-event lineage 识别背包中的后继 stack；同材质无 lineage 的替身不能冒领承诺。
5. exact source 在行动前消失、不可达或不再满足性质时，记录失效；项目随后按既有停滞规则阻塞。时间、压力和其他同材质实体都不能偷偷改绑。
6. 一旦真实 renewal 已被尝试，后续有限预算仍可比较其他尚未被 reliable no-response 排除的候选；新机会不保证成功。

## 禁止项

- 只看 `materialId` 判断首试使用了 renewal；
- 为了达到生产阈值恢复冷却期、随机重置或按年龄清除失败记忆；
- 来源消失后自动改绑最近的同材质 drop/stack；
- 把“世界规则存在某配方”当作 material opportunity 可执行的依据；
- 直接把 renewal 项目标成完成，或把没有行动的项目计作生产；
- 用文明指数、里程碑缺口、模型提示决定承诺是否合法。

## 定向测试

1. 新 material type 仍可生成 candidate 且 exact source 可解析时，项目创建，首选候选带 commitment reason 与 exact source/lineage。
2. 新 material type 的所有候选都已被本人 reliable no-response 排除时，不能仅凭 material ID 创建 renewal 项目。
3. 提议后 exact drop 消失时，campaign 在第一次 renewal 尝试前不得选择旧候选；项目最终有来源地失效/阻塞。
4. exact drop 被本人取得后，后继 inventory stack 的 source events 能兑现原承诺；无 lineage 的同材质替身不能。
5. 新 exact hot target 与新可靠个人知识分别可直接兑现；另一人物不能继承承诺。
6. v26 的同材质替换、个人隔离、可靠 no-response、零总分 no-fit 与 exact-entity 测试继续通过。

## 配对矩阵

- 直接基线：`candidate-cross-project-inquiry-opportunity-memory-v26-quick`；
- 候选：`candidate-renewal-opportunity-commitment-v27`；
- seeds `185, 20260815, 20260816`，chaos `0`，先 3×10 年；
- 10 年通过后才运行同种子 30 年，并同时对照 v25 的长期重复项目；
- 模型调用与 token 必须为 `0`。

## 10 年继续门槛

1. renewal source/lineage/actor/function/status、basis、operation、签名、预算、ordinal、diff/outcome 与 exact-entity 守卫全部为 `0`；三层 entity basis 覆盖 `100%`。
2. 每个自然 renewal 项目都有来源承诺；创建时可执行 commitment 覆盖、首个 hypothesis candidate 覆盖与首试覆盖均为 `100%`。没有自然 renewal 的种子按空集合记 `100%`，但定向 fixture 必须证明正反路径。
3. 无新机会重开与 reliable no-response 跨项目超额复试继续为 `0`；承诺兑现前旧候选 fallback 为 `0`。
4. 每种子至少完成 1 个生产项目，生产完成中位数不得低于 v26 的 `5`，合计至少 2 类进阶成品；不要求恢复 v25 中无来源重试产生的三次成功。
5. 每个种子同时有 response 与 no-response；人口、生存、建造、关系无新的系统性坍塌；模型与 token 为 `0`。

## 30 年接受条件

除 10 年门槛外：无来源的同人同功能重开保持为 `0`；renewal 来源失效不能转化为旧盲试；至少两个种子自然出现并执行有来源 renewal；生产与复杂性不能因项目门控继续单调收缩。通过后，v28 才引入“观察并记住公共功能地点/示范”的正向社会学习机会。

## 10 年冻结结果

产物：`three-body/data/experiments/candidate-renewal-opportunity-commitment-v27-quick.json`。观察器 `causal-person-month-v20`；seeds `185 / 20260815 / 20260816`；模型与 token 均为 `0`。

| 指标 | v26 | v27 | 结论 |
| --- | --- | --- | --- |
| 生产项目完成 | `4 / 7 / 5` | `4 / 7 / 5` | 中位数 `5`，不低于基线；每种子至少 1 个 |
| 项目启动 | `21 / 20 / 24` | `18 / 19 / 24` | 删除不可执行的伪 renewal，没有恢复盲试 |
| hypothesis 尝试 | `36 / 46 / 30` | `36 / 42 / 30` | 未新增试错浪费 |
| response / no-response | `11/25 / 19/27 / 10/20` | `10/26 / 19/23 / 10/20` | 三种子均同时存在正负响应 |
| 自然 renewal 项目 | `1 / 2 / 0` | `1 / 1 / 0` | seed 20260815 的 Tesla 伪 renewal 被拒绝；白素贞合法 renewal 保留 |
| source basis / commitment key 覆盖 | 未实现 | 全部 `100%` | 通过 |
| exact-source 首候选 / 首试覆盖 | `100 / 50 / 100%`（material-only v19） | 全部 `100%`（exact-source v20） | 通过 |
| commitment 前旧候选 fallback | 未实现 | `0 / 0 / 0` | 通过 |
| material-only commitment 冒领 | 未实现 | `0 / 0 / 0` | 通过 |
| unresolved source、actor/function/inherited status mismatch | 未实现 | 全部 `0` | 通过 |
| 无新机会重开 / reliable no-response 超额复试 | `0 / 0 / 0` | `0 / 0 / 0` | 继续通过 |
| exact-entity 三层覆盖 / 归因 violation | `100% / 0` | `100% / 0` | 继续通过 |

进阶成品跨种子包含长矛、兽皮衣、熟食与记录载体，满足至少两类。人口 `9 / 7 / 14`，无灭绝；建造完成 `6 / 4 / 12`，seed 185 有局部下降但没有跨种子系统性坍塌。10 年门槛通过，按预登记进入 3×30 年。

## 30 年冻结审计：v27 原版拒绝

产物：`three-body/data/experiments/candidate-renewal-opportunity-commitment-v27-30y.json`。三种子的 renewal source、首试、fallback、material-only、无机会重开、reliable no-response 与 exact-entity 守卫均通过；生产完成 `7 / 11 / 8`，模型调用仍为 `0`。但 seed 20260816 的首候选 exact-source 覆盖只有 `90.91%`，因此不能接受整包。

唯一违规项目是 `project-278-wuzetian-food-preparation`：第 278 月，武则天因两个死亡遗留 drop（`material:23`、`material:26`）重新开启熟食探究，连续移动并取得 exact `material:23`，但死亡遗物没有 source event；transfer 又只给新 inventory stack 写入拾取事件，未保存 `drop → stack` 的实体谱系。最终 campaign 有 24 个普通候选，却没有一个能证明使用了原承诺，0 次试验后项目阻塞。这不是观察器误报，也不能通过把任意同材质 stack 当作 renewal 来绕过。

## v27.1 冻结修补

v27.1 不改变机会、预算、评分、配方、压力或项目门槛，只补充物品在 `drop / inventory / container / drop` 转移中的 exact physical lineage：

1. stack 与 drop 可保存有限长度的 `sourceLineageKeys`；每次真实 transfer 继承直接前身实体 key 与既有祖先。
2. 人物死亡时，背包遗物继承原 stack 的事件与实体谱系，不再成为无来源的新物。
3. renewal 候选必须使用当前仍可执行的实体；仅当该实体的 lineage 包含原承诺 key，才追加 commitment reason 与原始 source key，供历史观察器重放。
4. 同材质但没有实体 lineage 的替代物仍不得冒领；原承诺实体取得后消耗或消失，也不得自动改绑。

新增定向反例为“source events 为空的 exact drop”：拾取后 successor stack 必须保留原 drop key，首候选必须同时包含当前 stack key 与原承诺 key；无 lineage 替身测试继续通过。v27.1 沿用原 v27 的全部 10/30 年门槛，并使用相同 seeds 重跑，原 v27 产物永久保留为失败证据。

v27.1 的 3×10 年产物为 `three-body/data/experiments/candidate-renewal-opportunity-physical-lineage-v27-1-quick.json`：生产完成 `4 / 7 / 5`，自然 renewal `1 / 1 / 0`；source、首候选、首试与三层 entity basis 覆盖均为 `100%`。commitment 前 fallback、material-only 冒领、无机会重开、reliable no-response 超额复试以及来源/角色/操作/diff 守卫全部为 `0`，模型调用为 `0`。通过 10 年门槛，进入同种子 3×30 年。

## v27.1 30 年冻结结果与决定

产物：`three-body/data/experiments/candidate-renewal-opportunity-physical-lineage-v27-1-30y.json`；观察器仍为 `causal-person-month-v20`。

| 指标 | seed 185 | seed 20260815 | seed 20260816 |
| --- | ---: | ---: | ---: |
| 终局人口 | 13 | 7 | 9 |
| 项目启动 / 完成 / 阻塞 | 49 / 26 / 21 | 35 / 20 / 14 | 49 / 26 / 23 |
| 生产 / 建造完成 | 10 / 16 | 11 / 9 | 9 / 17 |
| hypothesis campaign / 尝试 | 30 / 105 | 25 / 71 | 28 / 94 |
| response / no-response | 23 / 82 | 25 / 46 | 19 / 75 |
| renewal 项目 / 实际首试项目 | 7 / 7 | 6 / 6 | 10 / 10 |
| source、首候选、首试、entity 覆盖 | 100% | 100% | 100% |

全部来源、角色、operation、budget、ordinal、diff/outcome、fallback、material-only、无机会重开和跨项目 reliable no-response 守卫为 `0`，模型与 token 为 `0`。相较 v25 的项目启动 `89 / 59 / 88`、campaign `75 / 48 / 65`、尝试 `280 / 163 / 235`，v27.1 仍大幅删除失败后的无来源盲试；同时生产完成从 v27 原版的 `7 / 11 / 8` 回升为 `10 / 11 / 9`，没有继续单调收缩。

自然历史直接复现了原断点：seed 20260816 的 `project-278-wuzetian-food-preparation` 仍由两份死亡遗物重开。原版在取得 `material:23` 后有 0 次试验；v27.1 的 successor `inventory:wuzetian:stack-wuzetian-23-278` 保存原 drop key，形成 7 个有承诺候选并执行 4 次有限试验。另一个 `project-253-heidi-food-preparation` 使用 source events 为空的 `drop:seed-935`：第一次直接围绕 drop 试验，拾取后又以 successor stack 执行第二、三次试验，证明 physical lineage 路径不是只在 fixture 中成立。

决定：接受 v27.1 的机制与整包。它没有让失败必然转化为成功，只保证“为什么重开、围绕哪个实体行动”在跨项目与跨持有者形态后仍可追溯。下一断点转向 v28：成功技术仍主要停留在个人身上，社会交流尚不能把真实示范转化为他人可验证的暂定技术。
