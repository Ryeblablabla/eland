# v14 局部事实边沿驱动的动态项目压力实验

状态：机制接受；整包继续修订。

## v13c 最早断点

v13c 已经保证短期事项中断后恢复同一个项目 intent，但项目保存的 `pressure` 仍是创建时常量。三条 30 年历史共有 111 个项目，压力历史均为 0；后续伤病加重、材料获得、天气解除或知识中断都不能改变项目紧迫度，生活复核长期拿一个过期数字比较。

来源语义也不可靠。当前 `recentPersonalEvents` 把“此刻可见格子中曾经发生的旧事件”当作人物近期经验。三条历史的捕猎安全项目共有 44 条触发来自其他人物的捕猎失败；例如人物后来走到旧猎场附近，就会像亲历过几个月前的失败一样建立项目。另有 243 条项目触发直接引用全局气候/天气历史。事件都能解析，但“存在于世界历史”不等于“当事人曾感知”。

## 单一因果假设

项目紧迫度应由项目拥有者可追溯的局部离散事实边沿更新，而不是创建时冻结、随月份线性变化，或从当前位置倒推过去可见性。每次变化保存一个 `ProjectPressureBasis`：

- `need`、`observerId`、`atMonth`、`pressure`；
- 规范化 `edgeKeys`，表达身体状态分段、本人行动结果、当前可见实体/物品、受益者伤病、年龄分段或物质状态；
- 可解析的 `sourceFactIds`；当前可见的权威实体状态允许只保存在 `edgeKeys`，不能伪造历史事件；
- 稳定 `basisKey` 和 `reasonKeys`；
- 项目保存 initial basis 与只在 basis 变化时追加的 `pressureHistory`。

六类 need 的白名单边沿：

1. `thermal-safety`：本人 cold/heat condition 的进入、加重、退出，或隔热物获得；
2. `hunting-safety`：本人的捕猎失败/反击、本人作为受害者的兽袭、当前真实可见且存活的攻击性动物；普通动物觅食、出生、远处死亡和他人的捕猎失败不合格；
3. `care-capability`：当前可见受益者的 wound/illness 分段及其来源，恢复后形成 resolution edge；
4. `food-preparation`：本人持有或当前可见的生肉堆、本人食用生肉的后果、熟食获得/生肉耗尽；
5. `shelter-capacity`：本人暴露 condition、本人当前位置是否已有功能住所，以及当前天气/纪元状态；不从当前站位反推旧天气事件是否被看见；
6. `knowledge-preservation`：本人有来源的成熟 technique、本人脱水/记忆中断经历和离散年龄段；年龄只在跨段时形成新边沿，不按每月年龄线性加分。

压力允许升降，但同一个 `basisKey` 不重复追加历史。项目同步可以检查当前事实，只有白名单边沿变化才改写 `pressure`；单纯过一个月、文明指数变化、里程碑达成和隐藏资源变化都不能更新。

## 预登记矩阵

- 基线：`candidate-intent-interruption-resume-v13c`；
- 候选：`candidate-dynamic-project-pressure-v14`；
- 种子：`185, 20260815, 20260816`；
- 快速诊断：三种子 × 10 年；最终判定：三种子 × 30 年；
- 规则模式、同配置配对，零发生与不利种子保留。

主要指标：

- 建立 initial pressure basis 的项目数与覆盖率；
- 每个 need 的压力更新项目数、上升/下降次数、basis 去重数；
- source event 无法解析数、cross-owner hunt trigger 数、非威胁 animal trigger 数；
- 无新 edge 的纯过月更新数，必须为 0；
- 项目开始/完成/阻塞、项目行动人月、生活复核与中断恢复；
- 人口、出生、死亡、生产、建造、物流和模型调用。

接受护栏：

- 新建项目均有 initial basis；同 basis 重复记录、无法解析 source、cross-owner hunt trigger、非威胁 animal trigger、纯时间更新均为 0；
- 出现合格新边沿的活动项目必须留下 pressure history；没有边沿的项目保持原压力，不为了证明“动态”而伪造变化；
- v12 的关系提议重复/缺 basis 与生活复核重复保持为 0；
- v13 的未解析 return、child 项目污染、恢复后无 parent 行动、瞬时同项目替换和孤儿 suspended 保持为 0；
- 文明指数只作观察，不进入 basis 或规划；模型调用和 token 保持 0。

不要求压力单向上升，也不要求项目完成、人口或文明指数普遍上升。若清理错误来源使某类项目减少，这是允许的因果修正；必须检查真实需求是否仍能建立项目，而不能用产量补偿来源错误。

## 结果与决定

候选经历了两次快速诊断。`v14-quick` 发现 `basisKey` 把来源 ID 当成边沿的一部分；最终 `v14b` 将 key 收敛为 need、observer 与规范化离散 `edgeKeys`，来源只承担证据作用。定向测试证明：他人的捕猎失败即使被听说也不能冒充本人失败；普通鹿不形成猛兽压力，可见狼形成；纯过月与同一边沿更换来源不追加历史；跨越年龄段才产生年龄边沿。

最终证据：

- 快速矩阵：`candidate-dynamic-project-pressure-v14b-quick.json`，3 seeds × 10y；
- 最终矩阵：`candidate-dynamic-project-pressure-v14b-observer-v6.json`，3 seeds × 30y；
- 固定基线重投影：`candidate-intent-interruption-resume-v13c-observer-v6.json`；
- 配对比较：`candidate-dynamic-project-pressure-v14b-vs-v13c.json`。

三条 30 年候选共有 104 个项目，initial basis 覆盖率均为 100%。有 24～26 个项目发生动态变化，每条历史分别产生 99、65、99 次 basis 更新；上升 19/15/20 次，下降 34/43/53 次。六类白名单中，热安全、捕猎安全、食物加工、住所和知识保存均在真实条件出现的种子留下更新；本矩阵没有形成照护项目，因此照护更新为合法零发生，未用伪事件补齐。

完整性护栏全部通过：重复 basis、不可解析来源、非边沿变化、observer/owner 错配均为 0。旧基线的捕猎项目分别含 38、6、0 条他人捕猎失败来源，候选全部归零；非威胁 animal 来源为 0。关系 basis 重复/缺失、同月生活复核、未解析 interrupt return、child 项目污染、恢复后 parent 无动作、瞬时替换及孤儿 suspended 均为 0；模型调用和 token 为 0。

人口不是接受依据，且三个种子明显分化。终局人口从基线 12/3/10 变为 3/8/12，出生从 11/4/10 变为 4/5/12；配对差为 -9/+5/+2 与 -7/+1/+2。清除错误动机改变了后续因果级联，但不能由三条历史归因为普遍改善或退化。

决定：接受“局部离散边沿驱动的动态项目压力”机制，不接受整包已经完成。下一最早断点是进展语义：多个被判“持续无进展”的项目实际已有 73～181 个项目动作，物流移动没有更新 `lastProgressAtMonth`，造成进展假阴性。v15 预登记修复有证据的项目进展与停滞判定。
