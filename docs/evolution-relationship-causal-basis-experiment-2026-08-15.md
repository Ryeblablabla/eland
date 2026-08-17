# v12 关系提议因果 basis 实验

状态：机制接受。最终候选为 `candidate-relationship-causal-basis-v12c`。

## v11 最早断点

v11 的只读预览和 life-review basis 消除了同月重复，但 basis 只约束项目中的生活复核。普通规划生成的 companion/reproduce 提议仍按短冷却放行，并没有把 basis 写入 Proposal 与 Agreement。真实历史中，同一方向的人物对出现多次过期后重提；seed 20260816 的 `sima-qian → bai-suzhen` 共提议 6 次，其中第 247 月的未回应提议在第 251 月再次出现。

此外，当前 basis 混入全部 `relation.sourceEventIds`。普通对话、提议、接受或拒绝都可能写入关系来源，使“被拒绝本身”错误成为下一次提议的新证据；年龄压力也在同一年龄段内逐月增长。

## 单一因果假设

所有 companion/reproduce 提议，无论来自空闲规划还是项目生活复核，都必须携带同一种 `RelationshipCausalBasis`。一项旧提议结束后，只有当前 basis 相对旧 basis 新增了合格关系证据，或跨入新的离散生育年龄窗口，才允许同一发起者向同一对象重提。

合格证据白名单：

- 真实履约、物质转移、照料、共同项目动作或完成；
- 与预言正确性等客观结果绑定的非沟通事件；
- 离散女性年龄窗口：`<30 / 30–34 / 35–37 / 38–40 / 41–45`。

排除项：

- 普通 claim/talk；
- offer/request/accept/reject/revoke/withdraw 本身；
- 月份、冷却时间、连续年龄值；
- 人口、文明指数、里程碑和项目压力。

年龄压力改为段内常量，不得在同一年龄段靠过月跨过阈值。basis 随 ActionOption、SocialProposal、ActionFact 和 Agreement 持久化；Agreement 创建时明确合并 basis 的来源事件。旧存档没有 basis 时采取保守门：只认可协议结束后新增的合格证据或年龄跨段。

## 预登记矩阵

- 基线：`candidate-causal-edge-life-review-v11`；
- 候选：`candidate-relationship-causal-basis-v12`；
- 种子：`185, 20260815, 20260816`；
- 时长：30 年；规则模式；同配置配对；
- 同时只读回看 v11 的重复 directed pair，不能只看 life-review 计数。

主要指标：

- companion/reproduce 提议总数；
- 同一 directed pair 的提议次数；
- 旧 basis 无新增合格证据的重提数；
- 提议、接受、尝试、受孕漏斗；
- life review 的重复 basis 与同月重复；
- 项目完成/阻塞和模型独立性。

接受护栏：

- 无新增合格证据的重提必须为 0；
- 普通沟通、提议、接受、拒绝不能单独改变 basis；
- 年龄段内单纯过月不能改变压力或 basis；
- 第一候选被门槛阻止时，仍能选择另一个有合法新 basis 的对象；
- 已有在途或 proposed 提议不能重复；
- 真实履约或跨年龄窗口后可恰好解锁一次；
- 不要求提议数或出生数上升，模型调用与 token 保持 0。

## 结果与决定

先后保存了三个候选，而不是覆盖失败历史：

- v12a 首次把 basis 接入全部路径，三条历史的重复 proposal basis 和无 basis 新提议都为 0；但 seed `20260815` 在第 90 月由同一人物先后用生殖与结伴两个不同 basis 对同一项目做了两次生活复核。
- v12b 只检查了已进入 `world.past` 的决策，结果与 v12a 完全相同。原因是月内事件要到月末才归档，修补没有碰到真实断点。
- v12c 让月内规划只读看见本人本月刚完成的 life-review 决策。原故障种子复现后，同月重复由 1 降为 0；随后重跑完整三种子矩阵。

最终 30 年配对结果：

| seed | v11→v12c 关系提议 | v12c 唯一/重复/缺 basis | directed pair 最大次数 | v11→v12c 出生 | v11→v12c 项目完成/阻塞 | v11→v12c 履约物流 |
|---:|---:|---:|---:|---:|---:|---:|
| 185 | 13→12 | 12 / 0 / 0 | 4→3 | 7→6 | 41/5→39/4 | 195→175 |
| 20260815 | 14→8 | 8 / 0 / 0 | 3→2 | 3→2 | 28/3→26/5 | 88→125 |
| 20260816 | 39→19 | 19 / 0 / 0 | 6→3 | 5→5 | 34/2→30/1 | 78→131 |

事实审计进一步逐条检查了所有 39 个 v12c 关系提议：

- basis 来源无法解析 0 个，非白名单来源 0 个；
- 三条历史的重复 exact basis 均为 0，缺 basis 均为 0；
- 重复 directed pair 仍有 `2/1/5` 个，但每次都新增了可解析的合格关系事件，或跨入新的离散年龄段；这属于允许的真实重提，不是冷却绕过；
- life review 为 `1/1/0` 次，同人同月重复和重复 life basis 均为 0；
- 终局人口 `9/5/8`，相对 v11 的配对差为 `0/+1/-1`；出生有所下降但三条历史均非灭绝，不能把出生数上升当作接受条件；
- 模型决策、输入 token、输出 token 全部为 0。

决定：接受 v12 的关系因果门机制。它消除了普通规划绕过、对话/拒绝自我解锁和纯时间冷却重提，同时保留了新共同经历之后重新选择的可能。项目完成均值略降、阻塞分布变化与 seed `20260815` 的出生下降保留为后续风险，不用文明指数掩盖。项目 intent 的 interrupt/suspend/resume 保持为 v13 独立机制；项目压力随新事实动态变化留给 v14。

证据文件：

- `three-body/data/experiments/candidate-relationship-causal-basis-v12c.json`
- `three-body/data/experiments/candidate-relationship-causal-basis-v12c-vs-v11.json`
- `three-body/data/experiments/candidate-relationship-causal-basis-v12c-vs-v12b.json`
