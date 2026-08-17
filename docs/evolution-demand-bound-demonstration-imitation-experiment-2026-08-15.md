# v28 需求绑定的现场示范—模仿实验

状态：v28 请求机制可达，整体候选拒绝；定向合法性通过，3×10 年自然矩阵未形成示范。

## 决定（2026-08-16）

3×10 年自然矩阵 `candidate-demand-bound-demonstration-v28-quick.json` 中，请求为 `2 / 1 / 21`，重复请求与全部来源守卫均为 0，但示范、模仿、可靠学习者均为 0。生产项目完成为 `2 / 7 / 2`，中位数 2，低于预登记继续门槛 5，因此按协议停止 30 年扩展。

代表历史显示，请求者只向按 ID 排序的第一个近身者请求。seed 20260815 在第 95 月已有 3 名 prepared-food 可靠技术持有人，seed 20260816 在第 35 月已有 durable-record 可靠持有人、100 月后已有 prepared-food 可靠持有人，但所有实际请求受众均不是这些人。最早断点是本地请求覆盖，而不是示范动作合法性：保留 request → demonstration → imitation 基础设施，拒绝 v28 整包；下一轮检验同地广播能否让真实持有人收到请求。

## v27.1 后的真实断点

v27.1 已让失败探究只围绕新的 exact opportunity 重开，并在 3×30 年中把 hypothesis campaign 从 v25 的 `75 / 48 / 65` 压到 `30 / 25 / 28`，生产完成仍有 `10 / 11 / 9`。下一个断点不再是“人物不会自己试”，而是成功经验仍很难形成有因果证据的社会学习。

当前已有 `teach:` 选项，但它把任意可靠 technique 口头传给任意近身人物。30 年发生 `90 / 16 / 75` 次 teach，其中 technique claim 为 `87 / 11 / 48` 次。执行器只把听者置信度设为 `46`、上限锁在 `54`；它既不要求听者有对应需求，也没有现场动作、输出与个人复现链。结果是：

- seed 185 的在世后代 8 人中有 3 人可靠技术为 0；`born-227-persephone-17` 有 `9` 项暂定、`0` 项可靠技术；
- seed 20260816 的 3 名在世后代可靠技术全部为 0；`born-199-sima-qian-16` 有 `10` 项暂定、`0` 项可靠技术；
- 现有 `transmittedTechniques` 只按多人拥有同 ID 计数，无法区分独立发现、口头 claim 与真实教学，不能作为因果证据。

同地交流并不稀缺。按“学习者当时有 active inquiry、交流对象当时已拥有能满足该功能的 technique”保守回放，30 年至少有 `4 / 17 / 13` 个同月同地交流窗口。真正缺少的是请求、真实展示和复现之间的闭环。

## 单一因果假设

若未完成探究的人只能基于自己的 active inquiry 向近身人物请求帮助，而掌握匹配可靠技术的人必须用自己的真实材料和眼前目标现场执行一次，学习者只获得低于可靠阈值的暂定 technique；随后学习者必须用自己的实体亲手复现，并由世界物质规则产生匹配响应，才把 technique 提升为可靠知识，那么技术扩散将从“词语复制 ID”变为可重放的社会因果链，同时不会把教师知识直接写成学生能力。

v28 只改变技术教学路径，不提高配方命中率、不赠送材料、不延长 hypothesis 预算、不读取文明指数或里程碑，也不保证示范一定发生或复现一定成功。

## 冻结链条

```text
学习者 active inquiry
  → 对近身人物发出 project-bound demonstration request
  → 对方确实拥有匹配功能的 reliable technique
  → 双方仍同地，教师持有真实输入且眼前存在合法 target
  → 教师执行 authoritative primitive action
  → 世界规则真实产生该 technique 对应响应
  → 项目保存 request + demonstration + exact action/output basis
  → 学习者获得 confidence < 55 的 tentative technique
  → 学习者以自己的当前实体执行一次 imitation action
  → 世界规则再次产生同 technique 响应
  → 学习者 technique 才可达到 confidence >= 55
```

任一边断裂都不能越级：请求无人会、教师缺料、双方分开、target 改变、动作无响应、学习者没有自己的输入，都会等待、失效或让原项目按既有规则阻塞。

## 数据与合法性

项目保存 `ProjectTechniqueDemonstrationBasis`：

- `projectId / desiredFunction / learnerId / demonstratorId`；
- `requestEventId / demonstrationEventId / techniqueId`；
- demonstration 的 operation、input/tool/target/output material IDs；
- exact source keys、source fact IDs、发生月份；
- 初始置信度必须 `<55`。

示范 action 只能由 request 的实际受众执行；执行时再次检查项目仍 active、学习者仍是 owner、双方同地、教师本人仍有可靠 technique，且编译出的 action 与 technique ID 对应。示范成功后，学习者项目才得到 basis。模仿 action 绑定同一 basis 和学习者自己的当前 source keys；最终由 executor 的真实响应决定是否可靠化。

## 动机与选择

1. 学习者只有 active inquiry 且本人没有匹配可靠 technique 时才请求；请求表达的是功能困境，不指定上帝视角中的配方。
2. 同一 project 对同一人物最多保留一个未回答请求；可以在新近身人物出现时向另一人请求，不能按月份重复刷同一请求。
3. 教师只有收到本人可解析的 request，且自己的可靠 technique 能满足所请求功能、当前又能真实执行时才得到 demonstration 选项。
4. demonstration 是有受益者的生产行动，不是普通闲聊；教师的 affiliation、代际关系可影响排序，但不改变合法性。
5. 原有 codebook 教学保留；无 project/request 的 technique `teach:` 口头灌输停止。普通 claim 仍可形成主张或暂定线索，但不能进入 imitation 快路径。

## 禁止项

- 教师只说一句话就把学生 technique 提到 `>=55`；
- 学习者没有 active inquiry 或没有发出 request，教师便读取其内部项目并自动教学；
- demonstration action 没有消耗/作用真实材料，或 expected output 直接写进世界；
- 教师 source action 与 technique 不一致仍创建 basis；
- 学习者用教师的动作事件冒充自己的 imitation；
- 同材质替代实体在没有当前 source binding 时冒充模仿输入；
- 因示范重置整套 hypothesis/no-response 预算；
- 用文明指数、里程碑缺口、配方表中的“应当发展什么”选择教学目标；
- 为达到自然发生率强制把人物传送到一起或无条件赠送输入。

## 定向测试

1. 学习者有 active prepared-food inquiry、与教师同地；教师拥有可靠生火 technique 且持有 exact tool/input 时，可发出 request 并执行真实示范。
2. 示范前、只完成 request 后，学习者没有 technique；示范真实响应后才获得 `<55` 的 tentative technique 与完整 basis。
3. 学习者随后用自己的 stack/target 复现；响应 technique ID 匹配后置信度越过 `55`，action diff 与 project basis 可互相解析。
4. 无项目、功能不匹配、教师 technique `<55`、双方异地、教师缺输入、request 不是发给该教师、source action 无响应，均不能创建 demonstration basis。
5. 普通 technique claim 仍至多为 tentative，且没有 request/demonstration basis 时不能编译 imitation step。
6. 同 project/teacher 重复请求为 0；示范与模仿不能增加 hypothesis 总预算，v27.1 exact-source/fallback/material-only 守卫继续通过。

## 观察器 v21

新增只读指标：

- request 数、唯一 project/teacher basis、重复 request；
- demonstration basis、来源覆盖、教师/学习者/project/function/同地/operation/response mismatch；
- tentative lesson 数与 demonstration 后直接可靠 violation；
- imitation 尝试/响应、exact source 覆盖、source/actor/technique mismatch；
- reliable learner、可靠但无本人 imitation violation；
- demonstration → imitation → reliable → project progress/completion 完整链；
- generation `>0` 的 causal reliable learner；
- 旧式无 request technique teach 数。

文明指数与里程碑只重投影，不进入选择器；旧 `transmittedTechniques` 不作为 v28 成功门槛。

## 配对矩阵与门槛

直接基线：v27.1 的
`candidate-renewal-opportunity-physical-lineage-v27-1-quick.json` 与
`candidate-renewal-opportunity-physical-lineage-v27-1-30y.json`。

候选先跑 seeds `185 / 20260815 / 20260816`、chaos `0` 的 3×10 年；守卫通过后跑同种子 3×30 年。模型与 token 可为 0，模型不可成为链条成立条件。

10 年继续门槛：

1. request/basis/demonstration/imitation 的全部来源、人物、项目、function、operation、response、顺序和 exact-source 守卫为 0；v27.1 全部守卫继续通过。
2. 普通无 request technique teach 为 0；单次 demonstration 后直接可靠 violation 为 0；可靠学习者必须有自己的成功 imitation。
3. 至少 2 个种子出现 request；至少 1 个种子自然形成 demonstration，若 10 年窗口太短但守卫全过，可进入预登记的 30 年检验，不能宣称自然机制已接受。
4. 每种子生产完成至少 1，中位数不低于 v27.1 的 `5`；项目行动月、建造、人口与关系不能跨种子系统性坍塌。

30 年接受条件：

1. 至少 2 个种子自然形成 demonstration，至少 2 个种子形成成功 imitation；至少一个完整 `request → demonstration → imitation → reliable` 链来自 generation `>0` 学习者。
2. 所有因果守卫保持为 0；没有靠重复 request 或恢复 blind budget 制造产量。
3. 生产完成中位数不低于 v27.1 的 `10`，或在中位数略降时有明确的跨人可靠技术链且 campaign/项目碎片没有回升；不以文明指数上涨代替行为证据。
4. 若自然 demonstration 为 0，判定为动机/会合断点并拒绝整包；不得靠定向 fixture 或换种子接受。
