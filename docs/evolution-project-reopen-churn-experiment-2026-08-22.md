# 搜索耗尽项目重复重开实验（2026-08-22）

状态：v2 为 `revise/preliminary`；v3 为 `accept/preliminary`。

## 可证伪假设

目标能力：人物应记住本人已经穷尽的有限材料搜索；同一功能只有出现真实的新资源来源、新的可执行计划依据或其他可追溯机会时，才能创建后继项目。

最早断点位于 `memory -> project`：搜索 campaign 会跨项目继承已尝试地点，但纯搜索型失败没有进入项目机会终局记忆，旧的 `hasObserved` 事实仍可反复触发同一提案。

最低层候选：让 search-only blocked 项目冻结可继承的终局机会依据；提案统一比较先前终局依据与当前人物可感知机会，不使用冷却期，不取消搜索穷尽后的及时阻塞。

## 基线与矩阵

- 基线产物：`three-body/data/experiments/candidate-civ61-breaks-v1-20260822.json`
- 基线前缀：`candidate-civ61-breaks-v1-20260822`
- 种子：`185, 20260815, 2739165673`
- 时长：10 年、30 年
- 重复：每种子一次确定性运行
- 配置：`civilizationNo=1`、`chaosIntensity=0`、`climateBias=balanced`
- 候选使用相同矩阵与配置，并使用新的唯一前缀和产物路径。

基线 30 年三运行累计：启动 319、完成 112、阻塞 197、边界月仍活跃 10。相同 owner + desiredFunction 在上次阻塞后 3 个月内共重开 82 次，其中 81 次没有真实 renewal；铜料与锡料项目贡献 109 个阻塞。

## 验收与护栏

机制验收：

1. 纯材料搜索耗尽的 blocked 项目必须进入跨项目终局记忆。
2. 人物、功能、真实机会和计划依据均未变化时，不得再次生成同一提案。
3. 新的可感知资源来源或新的可靠计划依据出现时，允许重开，且后继项目绑定该 renewal 来源。
4. 搜索型无 renewal 重开必须能被报告指标观察，不能因缺少 hypothesis attempt 而漏报。

10/30 年初步矩阵接受条件：所有运行完成且无新增灭绝；无 renewal 重开指标为 0；30 年三种子的 3 个月内同 owner + function 重开总数至少较基线下降 75%；平均完成项目不低于基线超过 1 个，平均结构与移动占比不出现方向一致的明显回归。若机制测试通过但群体护栏不满足，则机制接受、候选维持 `revise`。

本轮不承担 50/100 年与终局审计，结论只能是初步诊断。

## v2 初步结果与新断点

v2 产物：`three-body/data/experiments/candidate-project-reopen-memory-v2-20260822.json`。六次运行全部到达边界，无灭绝；30 年项目完成均值从 `37.33` 升到 `45.33`，累计 blocked 均值从 `65.67` 降到 `58.33`，终局机会依据覆盖与来源解析均为 `100%`，当前口径的无 renewal 重开违规为 `0`。

按全部后继项目计数，30 年同 owner + desiredFunction 在阻塞后 3 个月内重开从基线 `82` 次降到 `21` 次，下降 `74.39%`；剔除带真实 renewal key 的后继项目后，预登记的无续证口径为 `81 -> 20`，下降 `75.31%`，数值护栏通过。逐对检查仍显示，剩余 21 次中：

- 18 次是 construction 项目耗尽实体假说后，无 renewal key 原样重开；
- 2 次是没有 search / hypothesis 的定居耕作复核超时；
- 1 次 prepared-food 项目带真实 `material:41` renewal。

因此 v2 的材料搜索记忆机制成立；但 18 次 construction hypothesis churn 被当时的机制与观察器共同排除，不能拿通过的窄口径宣称整个重复立项问题已经解决，整包决定仍为 `revise/preliminary`。新的最早断点仍在 `memory -> project`：旧实现明确让 construction 绕过 hypothesis 终局机会记忆，导致 Workshop 与 CouncilHearth 等建造假说按月份重新立项。

## v3 建造假说续证预登记

可证伪假设：若 construction 项目已经提交过实体假说并冻结终局机会依据，那么同一人物、同一 desiredFunction 的后继建造项目也必须出现此前未探索的正向材料类型、可靠功能计划、目标环境或 verified response 才能重开；项目 ID、月份、压力和相同材料的新栈都不构成机会。没有做过实体假说、也没有耗尽搜索的普通建造项目保持原行为。

最低层候选只移除 construction 对 hypothesis 跨项目记忆的豁免，并把相同语义加入观察器；不改变配方、假说预算、项目压力、完成条件或 0–6 月普通动作失败冷却。

- 候选前缀：`candidate-project-reopen-memory-v3-20260822`
- 候选产物：`three-body/data/experiments/candidate-project-reopen-memory-v3-20260822.json`
- 基线、种子、10/30 年时长、配置与上文完全相同。
- 继续使用原验收：无 renewal 违规为 0；30 年 3 个月内重开相对基线下降至少 75%；完成项目均值不低于基线超过 1 个；无灭绝，结构与移动占比无跨种子一致明显回归。
- 另要求 fixture 证明：无新机会的 construction hypothesis 后继提案被抑制，真实新机会仍能形成有来源 renewal 并通过首步承诺。

## v3 配对结果

v3 产物：`three-body/data/experiments/candidate-project-reopen-memory-v3-20260822.json`。与基线按相同 seed、时长、repeat 和配置配对的六次运行全部到达 10 / 30 年边界，无灭绝、无提前结束。

30 年三运行汇总：

| 指标 | 基线 | v3 | 变化 |
| --- | ---: | ---: | ---: |
| 项目启动均值 | 106.33 | 97.67 | -8.66 |
| 项目完成均值 | 37.33 | 44.00 | +6.67 |
| 累计 blocked 均值 | 65.67 | 52.67 | -13.00 |
| 世界结构均值 | 11.67 | 14.00 | +2.33 |
| 完成结构均值 | 4.67 | 4.67 | 0 |
| 移动动作占比均值 | 60.81% | 62.08% | +1.27 个百分点 |
| 终局人口均值 | 7.67 | 9.33 | +1.66 |

这里的 `projectsBlocked` 是截至边界月曾经进入 blocked 的累计终局项目数，不表示同一时刻有 52.67 个项目正在阻塞。逐种子移动占比变化为 `+0.31 / -2.66 / +6.17` 个百分点，结构数变化为 `+7 / -2 / +2`，没有出现跨种子方向一致的退化。

直接按完整项目历史复核“同 owner + desiredFunction，前项 blocked，后项在 3 个月内创建”的宽口径：

- 基线共 82 次，其中 81 次没有真实 renewal；
- v2 共 21 次，其中 20 次没有真实 renewal；
- v3 仅剩 2 次，下降 `97.56%`；两次都是 prepared-food 因新材料 `material:19` / `material:41` 合法续证；
- v3 无 renewal 的快速重开为 `0`，相对基线 `81 -> 0`。

观察器对六次 v3 运行均报告终局机会依据覆盖 `100%`、无 renewal 重开违规 `0`、无法解析来源 `0`。当前 `/report` 重投影还显示 4 / 6 个运行真实出现 construction renewal；这些运行的首候选、首尝试及其精确来源覆盖均为 `100%`，提前 fallback 与仅按材料类型错误归因均为 `0`。矩阵工具的固定摘要白名单尚未携带这 8 个 construction 子指标，因此它们不在冻结 JSON 中；这里将其作为当前报告重投影旁证，不伪写回实验产物。定向 fixture 另证明：项目 ID、月份、压力、移动或同一来源的转移 / 改名不能重开；精确的新材料来源或与目标功能相关的可靠技术可以重开；`search-source` 的候选与尝试必须命中编码的当前精确来源，旧 lineage 不能替代；即使客观出现新方案或来源，后继项目没有声明 renewal 也仍计为违规，首步不使用所声明 renewal 时同样会被拒绝。普通、从未发生搜索 / 假说终局失败的 construction 提案保持原行为。

## 判定

v3 满足预登记的全部 10 / 30 年初步条件：快速重开下降超过 75%，无 renewal 违规为 0，完成项目均值没有回归，六次运行无灭绝，结构与移动护栏无一致退化。因此接受“跨项目终局机会记忆 + renewal 首步承诺”这一通用机制，状态为 `accept/preliminary`。

这不是文明已能无限发展或第 61 号文明已被单例复现的结论。当前数据库没有可直接回放的第 61 号文明权威状态，本轮依据的是三个固定种子的匹配实验；尚未承担 50 / 100 年和终局审计。后续若仍停滞，应从新的最早断点继续诊断，而不是再次放宽已经穷尽的项目重开。

比较产物：

- 基线 → v3：`three-body/data/experiments/compare-project-reopen-memory-v3-20260822.txt`
- v2 → v3：`three-body/data/experiments/compare-project-reopen-memory-v2-v3-20260822.txt`
