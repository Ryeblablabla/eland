# v32 示范后的模仿承诺实验

状态：定向承诺机制暂存；自然历史候选拒绝。

## 决定

v32 与 v31 的同种子 `3×10y` 配对矩阵在全部引擎指标和观察指标上逐项 `Δ=0`。请求仍为 `15 / 11 / 11`，示范为 `0 / 0 / 1`，模仿为 `0 / 0 / 0`，生产项目完成为 `0 / 1 / 3`；seed 20260816 仍有 `reliableWithoutOwnImitation=1`，完整学习链为 0。所有 imitation exact-source、project、operation、response、order 守卫为 0，但这是因为自然历史没有进入 imitation，而不是候选已通过。

定向测试证明项目编译器在 pending demonstration basis 存在且本人缺 Fiber 时，会只生成示范技术的精确 Fiber 缺口，不再回退旧 hypothesis。自然历史却在第 59 月示范完成后的下一规划 tick 选择了全局选项 `repeat-inventory-combine:stack-washington-13-57:stack-washington-24-57`，继续复现第 56 月已可靠的长矛技术；其 intent 没有 projectId，项目编译器因而没有获得执行权。v32 改动未触及这条更早的规划入口，所以三组历史完全不变。

保留“pending basis 阻断项目内 fallback、精确补齐示范输入”的窄语义，但拒绝 v32 作为完成的学习链候选；因 10 年门槛未出现 imitation 且旁路可靠化仍为 1，按预登记不扩展 30 年。下一可证伪断点是：存在 pending demonstration basis 时，未绑定该 basis 的普通已知技术复现选项是否仍能抢占同一人物的 project-bound imitation commitment。

## v31 后的最早断点

v31 已产生真实示范，但学习者缺少示范输入时，`demonstratedTechniqueStep` 返回空，编译器随即回退到旧 tentative/hypothesis 分支。示范 basis 没有成为项目当前步骤的持久承诺，导致学习者后来用未绑定示范的普通核验路径可靠化。

## 单一因果假设

若 active project 中存在尚未完成的 demonstration basis，则当前工作分支只能是：用本人实体立即模仿，或按该 technique 的精确输入数量取得/制作缺料；在模仿成功、basis 失效或项目真实终止前，不得退回旧 hypothesis、普通 tentative verification 或无关材料链，那么示范可成为连续、可审计的项目承诺，而不是一次旁路提示。

```text
demonstration basis
→ exact technique input demands
→ project logistics / known production for outstanding units
→ own bound imitation action
→ matching world response
→ reliable knowledge
→ project progress or completion
```

## 守卫与矩阵

- 缺料时 `planKnowledgeId`、branchKey、required/current/outstanding quantity 和 source facts 必须绑定 demonstration event/technique；不得增加 hypothesis budget。
- pending basis 存在时不得执行其他 hypothesis 或普通 verification；没有可取得输入或合法 target 时保持可解释停滞，不得伪造材料或结果。
- imitation 必须使用学习者当前 exact source keys；教师实体不得进入 imitation；只有 matching response 才可靠化。
- 定向测试移除学习者 Fiber、放置真实 Fiber drop：示范后先精确取得 1 单位，再编译 imitation，不得编译旧 hypothesis。
- 以 v31 `3×10y` 为直接基线跑相同矩阵。全部守卫为 0，至少 1 个自然示范后形成 imitation，且 `reliableWithoutOwnImitation=0`、生产中位数不低于 1，才扩展相同 seeds 的 `3×30y`。
- 30 年若至少 2 个种子出现示范且至少 1 个完整 request→demo→imitation→reliable 链，并无系统性人口/项目回归，则接受；否则保留机制并给出下一可证伪断点。

## 证据

- 候选矩阵：`three-body/data/experiments/candidate-demonstration-imitation-commitment-v32-quick.json`
- v31/v32 配对比较：`three-body/data/experiments/compare-v31-v32-imitation-commitment-quick.txt`
- 代表 run：`v32-imitation-commitment-20260816a-s20260816-y10-r1`
- 代表事实：第 59 月 `e-59-action-washington-8` 请求、`e-59-action-libai-11` 示范、`e-59-decision-washington-5-12` 选择无项目绑定的旧长矛复现。
