# v15 有证据的项目进展与停滞实验

状态：机制接受；整包继续修订。

## v14b 最早断点

v14b 已能动态更新项目压力，但 `lastProgressAtMonth` 只在加工、转移、照护、记录等 `materialContribution` 上更新。固定物流目标上的真实移动被写入 `actionEventIds`，却不算进展。三条 30 年历史中，被“复核期内持续缺少可执行步骤”阻塞的项目包括 73、92、103、115、130、147、166、169、170、175、178、181 个动作的案例；部分项目 `lastProgressAtMonth` 仍停在创建月。

因此当前断链不是缺少行动，而是：

```text
固定局部目标 -> 向目标移动 -> 距离真实缩短
-> action 已发生 -> project progress 未记录 -> 停滞误判
```

## 单一因果假设

项目只应因可验证的目标接近或物质/功能变化刷新进展时钟。新增结构化 `ProjectProgressEvidence`：

- `eventId`、`atMonth`、`kind`、`actorId`；
- 对物流移动保存 `episodeId`、固定目标、`distanceBefore` 与 `distanceAfter`；
- 只有同一活动物流 episode 中 `distanceAfter < distanceBefore` 的已完成/推进移动才记为 `logistics-advance`；
- 已有加工、转移、照护、记录等项目贡献记为 `material-contribution`；
- 同一事件只记录一次，`lastProgressAtMonth` 取证据月份最大值；
- A-B-A、远离目标、失败/阻塞移动、无项目移动和求生反射不得给项目续命；
- 搜索 episode 仍受原 action budget 限制，进展证据不取消 review deadline，也不把“很努力”当作项目完成。

项目进入 blocked/abandoned/completed 时保存终止月份。停滞阻塞必须满足：超过 review 月，且距离最近真实进展至少 4 个月；死亡、功能已满足、受益者恢复等权威终止条件保持不变。

## 预登记矩阵

- 基线：`candidate-dynamic-project-pressure-v14b-observer-v6`；
- 候选：`candidate-project-progress-evidence-v15`；
- 种子：`185, 20260815, 20260816`；
- 快速诊断：三种子 × 10 年；最终判定：三种子 × 30 年；
- 同配置、规则模式、零发生和不利种子保留。

主要指标：项目进展证据覆盖、物流接近与物质贡献次数、重复 event、非接近移动误记、终止月份、阻塞时距最近进展月份、项目完成/阻塞、物流 episode 和移动反转；继续观测生产、建造、人口、关系、interrupt、动态压力与模型独立性。

接受护栏：

- 定向测试证明接近固定目标才刷新；远离、失败、重复事件和无 episode 移动均不刷新；
- 所有 progress event 可解析，actor/episode/project 一致，重复为 0；
- 不出现 `blockedAtMonth - lastProgressAtMonth < 4` 的停滞阻塞；
- 至少一个 v14b 中“移动但未记进展”的真实路径在候选留下 `logistics-advance`；若三条历史没有此条件，保持合法零发生并扩大诊断，不伪造；
- 搜索 episode 仍有界，项目不能仅靠不接近目标的移动永久存活；
- v14 压力来源护栏和 v12/v13 关系/中断护栏保持为 0；模型调用与 token 保持 0。

不要求阻塞数单向下降。若真实接近延长项目后仍因材料枯竭阻塞，这是合法结果；若完成数变化，必须沿具体进展证据解释，不能用文明指数归因。

## 结果与决定

候选 `candidate-project-progress-evidence-v15` 完成三种子 × 10/30 年；基线为重投影到 observer v7 的 `candidate-dynamic-project-pressure-v14b-observer-v7`，配对比较保存在 `candidate-project-progress-evidence-v15-vs-v14b.json`。

三条 30 年历史分别保存 1140、1350、2039 条结构化进展，其中 `logistics-advance` 为 968、1155、1758 条，物质贡献为 172、195、281 条。所有 evidence event 均可解析；重复 event、actor 错配、episode 错配、intent/project 错配、非接近移动、终止后进展均为 0。停滞阻塞没有一例发生在最近进展四个月内，terminal month 覆盖率从旧状态的 73.33%～85.71% 提升到 100%。

项目完成数逐种子保持 22/30/28，说明“记录努力”没有冒充完成功能。阻塞由 8/5/9 变为 8/3/8；候选中所有停滞项目都在最后真实进展后至少四个月才终止。人口从 3/8/12 变为 5/8/8，出生从 4/5/12 变为 5/5/9，仍是分化的下游级联，不作为机制接受依据。v12～v14 护栏和模型独立性保持通过。

决定：接受可验证接近与物质贡献作为项目进展证据。新断点是搜索范围没有项目级边界：例如 Tesla 的知识保存项目有 77 个 search episode、422 个接近动作、0 个物质贡献，却只访问 7 个不同目标，70 次为重复回访；另一个 Washington 项目则随移动视野扩张到 42 个目标。v16 将搜索收敛为由本地事实开启、固定锚点与候选格、可耗尽且不重复目标的 campaign。
