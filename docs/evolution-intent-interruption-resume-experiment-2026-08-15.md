# v13 项目意图中断与恢复实验

状态：机制接受。最终候选为 `candidate-intent-interruption-resume-v13c`。

## v12 最早断点

v12 关闭了关系提议的因果门，但真实历史仍把短期生活事项当作“替换整个人生目标”。当项目中的人物接受提议、履约或触发生活复核时，`startIntent` 会把旧项目 intent 标成 `abandoned`，再创建一个新 intent。即使新 intent 说完话后继续同一个项目，原 intent ID、进度、物流上下文和中断原因也已经断裂。

三条 v12c 30 年历史中，至少出现了接受生殖、接受共同体、直接履行生殖和两次生活复核对项目 intent 的替换。另有乱纪元脱水、预言和教学等短事项，但本版本不把所有 revise 都推断为中断；只有规则规划器明确标记 `mode: interrupt` 的事项才进入机制。

## 单一因果假设

当规则规划器为了必须回应、已经生效的履约，或有来源的生活复核而暂离一个 active project 时，应创建独立 child intent，并把原项目 intent 暂停，而不是放弃或复制项目 intent。child 结束后，根据项目的真实状态恢复同一个 parent intent ID。

最小状态：

- `revise.mode = interrupt`：由规则规划器明确声明，不能从“社会选项”或耗时长短猜测；
- child 保存 `returnToIntentId`；child 不携带 parent 的 `projectId`，避免把说话、会合或生殖动作误计为项目劳动；
- parent 保存当前 `suspendedByIntentId` 与 `suspendedAtMonth`；
- child 进入 completed/blocked/failed/abandoned 后，写入 `returnOutcome` 与 `returnResolvedAtMonth`；
- parent 项目仍 active 时恢复原 ID、原 progress、原 actionEventIds 和物流；项目已 completed/blocked 时分别收束 parent，不伪造恢复；parent 不存在时记录 unavailable，不静默悬挂。

同月生活复核仍以 v12 的显式决策事实限制为每人一次。普通 replace、主动放弃和切换到另一个项目保持原语义，不在本版本扩大范围。

## 预登记矩阵

- 基线：`candidate-relationship-causal-basis-v12c`；
- 候选：`candidate-intent-interruption-resume-v13`；
- 种子：`185, 20260815, 20260816`；
- 时长：30 年；规则模式；同配置配对；
- 若某种子没有中断样本，保留为零发生，不能拿其他种子替代。

主要指标：

- interrupt child 数，按 life-review / required-response / fulfillment 分组；
- child completed/blocked/failed 分布；
- return outcome 中 resumed / parent-completed / parent-blocked / unavailable；
- 同一 parent intent ID 的恢复数、恢复延迟、未解析 child 与终局孤儿 suspended intent；
- child 错带 projectId 数，必须为 0；
- parent 在中断前后的 progress、actionEventIds 和 projectId 连续性；
- 项目完成/阻塞、项目行动人月、关系 basis、人口和生产副作用；
- 模型调用与 token。

接受护栏：

- 每个已终止 interrupt child 必须有一个显式 return outcome；
- 可恢复项目必须恢复原 parent ID，不能创建替代 project intent；
- child 项目归因污染、parent progress 回退、parent action 历史丢失、unavailable return 均为 0；
- 项目真实完成或阻塞时允许不恢复，但必须记录对应结果；
- v12 的重复关系 proposal basis、缺 basis、重复 life-review basis 与同月重复继续为 0；
- 不要求所有中断成功，也不要求人口或文明指数上升；模型调用和 token 保持 0。

## 结果与决定

### 三轮收口

- v13 首轮证明 child/parent ID 机制可运行，但 seed 185 的 required-response child 在同月接受生殖协议后，执行器只从尚未归档的 `world.past` 找接受事件，错误阻塞了已经 active 的协议。
- v13b 把生殖合法性改为读取有效期内的 authoritative active agreement，并保留 proposal/response/action 三个来源事件。原错误 child 由 blocked 变为 completed；同时观察器发现该 parent 恢复当月尚未行动，就因暂停期被计作停滞而被同项目新 intent 顶替。
- v13c 规定显式 child suspension 不计入项目停滞时间。parent 恢复后先在原 ID 上依据当前项目事实重编译并执行；观察器升级为 `causal-person-month-v5`，新增“恢复后无 parent 行动”和“恢复当月同项目替换”护栏。

### 最终配对矩阵

基线为 v12c，候选为 v13c；三种子均运行 30 年。

| seed | child（生活复核/必须回应/履约） | resumed | 原 parent 后续行动 | 无后续行动/同项目瞬时替换 | 终局人口/出生 | 项目完成/阻塞 |
|---|---:|---:|---:|---:|---:|---:|
| 185 | 2（1/1/0） | 2 | 2 | 0/0 | 12/11 | 45/7 |
| 20260815 | 0（0/0/0） | 0 | 0 | 0/0 | 3/4 | 26/3 |
| 20260816 | 2（2/0/0） | 2 | 2 | 0/0 | 10/10 | 23/6 |

四个真实 child 均 completed，return outcome 均为 resumed；return latency 为 0～2 个月。child 错带 `projectId`、unavailable return、未解析终止 child、孤儿 suspended project intent、parent 行动历史丢失均为 0。seed 185 的 required-response parent 在返回后保留同一 ID 并新增 18 个行动事件；其余三个 parent 分别新增 81、34、100 个行动事件。

v12 护栏仍成立：三条历史的关系提议为 28/5/24，unique basis 同为 28/5/24，重复 basis、缺 basis、同月重复生活复核和重复 life-review basis 均为 0。模型调用与 token 为 0。

同月 active agreement 修复改变了真实因果路径，不能当作只影响日志的小补丁：相对 v12c，出生逐种子变化为 +5/+2/+5，终局人口为 +3/-2/+2，项目完成为 +6/0/-7。因此本版本只按意图连续性护栏接受，不把人口、项目或文明指数的混合变化解释为普遍收益。

另有 1/0/3 次生殖尝试被协议规则拒绝。逐条回放显示，它们都发生在 accepted agreement 的 `dueAtMonth + 1`，协议已于当月生命周期推进时过期，属于正确合法性裁决；“已经过期的协议 continuation 仍走到执行器才失败”保留为后续独立断点。

决定：接受 v13c 的中断恢复机制与同月 agreement 权威状态修复。accepted companion 的长期共同停留、last-seen 跟随、过期 continuation 清理和协议履约连续性不并入本版本。下一版本按已发现顺序进入 v14 动态项目压力。
