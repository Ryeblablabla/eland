# 信息时代长期双循环演进（2026-08-20）

状态：已按用户要求在 v1c 完成后收口。本文记录从当前可执行工作树出发的长期基线、逐版预登记与配对决定；失败样本、提前灭绝和停滞样本均保留。世界仍未达到信息时代，本文不把阶段性机制接受改写为最终目标完成。

## 目标与证据边界

本轮同时运行两条闭环：

1. 世界内闭环：`压力 → 感知 → 记忆 → 需要 → 项目 → 计划 → 合法行动 → 后果 → 学习 → 传播 → 制度`；
2. 工程闭环：`冻结基线 → 最早断点 → 单一假设 → 最小机制 → 定向回归 → 同种子全矩阵 → 接受 / 修订 / 拒绝`。

目标不是把时代字符串改成“信息时代”，而是让世界历史同时留下以下八类可回放事实：

1. 连续可调度电能，包含源、转换、连接、负载、中断和恢复；
2. 消耗真实能源与材料的受控机器生产，以及故障、维修和零件替换；
3. 无需人物携带者移动的跨地点编码、传输、接收与解码；
4. 可复制、可寻址、可由工具读取且能影响后续行动的信息载体；
5. 作为世界内实体存在、能对至少两组输入执行并产生被使用结果的算法；
6. 问题、测量、实验、记录、独立复现和知识修订组成的科研链；
7. 电网运维、信号网络、研究复核与数据 / 质量标准等具名制度；
8. 至少两处功能地点、三名人物的反复采用，以及关键操作者或节点丧失后的替任 / 修复。

文明指数、时代名称、里程碑名称、单次演示和观察器数值都不能替代上述事实。只读审计入口为 `three-body/scripts/audit-information-age-chain.mjs`；当前 schema 对八项门槛均明确报告 `unsupported`，不会从名称猜测成功。

## v0 冻结基线

- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`；
- 规则来源：启动矩阵时的实际脏工作树，而不是仅以 HEAD 代称；
- backend bundle：
  - `main.mjs` SHA-256 `5f01abf2bede1c2470575d3cf79579c3f1476d23097274077e0aa2f50b1ef807`；
  - `eland-worker.mjs` SHA-256 `1d45baa29bd76645ab2aed8fef4867fc8dd47cf59e97800cae03cbee98bce23c`；
- 冻结目录：`three-body/data/experiments/info-age-v0-current-20260820-freeze/`；
- seeds：`185 / 20260815 / 20260816`；
- horizons：`10 / 30 / 50 / 100 / 1000` 年，各自为独立运行；
- 配置：`chaosIntensity=0`、`climateBias=balanced`、`civilizationNo=1`、纯本地权威规则；
- 运行前缀：`info-age-v0-current-20260820`；
- 矩阵产物：`three-body/data/experiments/info-age-v0-current-20260820.json`；
- 信息时代旁车：`three-body/data/experiments/audit-info-age-v0-current-20260820.json`；
- 休眠恢复旁车：`three-body/data/experiments/audit-hibernation-v0-current-20260820.json`。

1000 年不是把较短运行重复计数。每个种子都从同一冻结规则重新开始，直到 12000 月或真实全员死亡；运行器不因全员脱水休眠而伪终止。SQLite 是权威事实源，最终矩阵 JSON 只作离线索引。

### 已完成的阶段性证据

30 年三个种子的终局人口为 `7 / 14 / 2`，全部仍是原始部落。它们已经发生大量直接技术教学，且 generation > 0 学习者后来用同一 `techniqueId` 完成真实行动的链分别为 `3 / 2 / 2`；旧 demonstration / imitation 指标为零不能解释成“没有跨代学习”。

50 年三个种子的终局人口为 `5 / 14 / 2`，脱水休眠行动分别为 `91 / 118 / 49`。因此断点不是人物完全不会休眠。seed `185` 在第 237–280 月的历史中出现：人物完成过休眠，在第 257 月恒纪元因附近有水而苏醒；第 264 月新一轮五级高温到来时，多人已有真实三级高温事实，但身体最低储备落在执行器可接受的 `38–44` 区间或很快跌过该区间，普通规划 / 生存反射没有生成新的紧急休眠行动，随后发生五次连续高温死亡。

seed `185` 的 100 年样本跑满 1200 月，终局人口 3；10 次死亡中 7 次有直接冷热暴露来源，2 次为终末衰老。其发展观察仍为原始部落，缺少 `food:cultivated-cells:6` 与 `food:stored-units:10`；青铜达到 repeatable，铁仍只有 hypothesis。该样本证明当前文明不一定在 100 年前灭绝，也证明延长时间不会自动闭合农业和后铁器链。

完整矩阵 15 / 15 个独立运行均已结束。100 年三个种子终局人口为 `3 / 8 / 1`；三个 1000 年目标运行都没有触及 12000 月上限，而是在第 `1943 / 1953 / 1299` 月真实全员死亡，终局人口均为 0。seed `20260815` 的历史峰值只到定居耕作，其余两个种子仍是原始部落；三者的第一项信息时代缺口都为 `continuous-electrical-energy`，状态均为 `unsupported`。因此“多给时间”在当前规则图谱中只会得到更长的铁器前历史，不会产生代码中不存在的电力、信号或计算事实。

1000 年终局分别留下 `8 / 11 / 0` 个记录 payload，但完整 `acquire → read → experiment → project progress` 链仍全部为 0。与此同时，直接教学后由 generation > 0 学习者复做同一技术的链为 `24 / 78 / 2`，教师死亡后仍由学习者复做的链为 `11 / 19 / 2`。这把“记录传播断裂”与“所有跨代学习都不存在”清楚分开。

休眠旁车进一步证明 v1 针对的是高频主链而不是单个案例。50 年三个种子共有 252 个可观察恢复 episode，其中 251 个由旧环境自动苏醒；1000 年终局前共有 539 个可观察 episode，其中 538 个自动苏醒。50 年中与苏醒后严重热灾有可解析来源联系的死亡为 `6 / 6 / 1`，1000 年为 `6 / 5 / 6`（少量死亡因旧事实缺来源而标为 partial）。旧 schema 没有恢复前后身体、阶段、连续 episode 与逐月成本事实，所以 `unsafe exit`、无来源储备增加、episode continuity 和月度成本在基线只能诚实报告 `unsupported / partial`，不能伪记为零；候选必须把这些口径变成可审计事实。

## v1 预登记：恢复门控的两阶段脱水休眠

### 可证伪假设

当前休眠结束逻辑在恒纪元到来时直接删除 `dehydrated-hibernation`，只增加少量 hydration，不恢复 health / nutrition，也没有恢复阶段。人物随后立即按清醒态结算；若下一轮乱纪元在储备恢复到新休眠准入线前到来，规划器和生存反射要求 `min reserve >= 45`，即使执行器仍允许 `>=38`，也没有可选行动。若休眠 episode 在真实恢复完成前保留一个受限的 recovering 阶段，并在下一轮乱纪元到来时继续原 episode，则下一轮暴露不应把刚苏醒的低储备人物困在“清醒但不能休眠”的死区。

### 最小机制

只扩展既有 `dehydrated-hibernation` episode 的阶段，不修改气候随机序列、死亡公式、人物寿命、文明指数或项目权重：

```text
dormant
→ 恒纪元提供苏醒条件
→ recovering（仍属于同一 episode）
→ 仅允许真实取水、进食、必要移动与照护
→ 储备恢复到安全线并具有物理来源
→ exited

recovering + 新乱纪元
→ dormant（沿用原 sinceMonth / stage / source）
```

进入一个全新休眠 episode 的预防性门槛仍保持不变。本版不顺手增加食物、住所、人口、农业或技术时代规则。

### 必须保持的不变量

- hydration / nutrition 的增加必须引用真实 ingest、rehydrate 或照护行动；不得由 `ambientRecovery` 凭空产生；
- 恢复完成前不删除 episode，完全退出时最低储备达到安全线；
- recovering 阶段不得执行社交回应、项目和生产；这些意图只能排队，不能丢失；
- 整个 episode 只用同一 condition marker 暂停原 active leaf 及其 `returnTo` ancestor 链；恢复取水 / 取食 / 移动不得制造逐 tick 瞬时 child，退出后只恢复 exact leaf，嵌套拓扑、项目进度和动作历史不变；
- 受抚养儿童在 recovering 阶段不得独自移动、拾取或采收，只能摄入自己的库存；同地照护者仍可真实转交食物；
- 多名帮助者同月预编译重新水化时只能有一条真实恢复行动；其余陈旧动作必须在 goal 或领域边界幂等停止，不能重复增加储备或关系；
- 新乱纪元只恢复 dormant，不重置 `sinceMonth` / stage，不重复扣除进入休眠的 hydration；
- dormant 与 recovering 每月都继续承担明确代谢和健康成本，health 归零仍死亡；
- 不能以永久休眠、全员无动作或观察器仍显示 running 的伪存活通过长程门槛。

### 定向验收

构造一名成年人，原 episode 开始于前一乱纪元，恒纪元开始时 `health=50 / hydration=40 / nutrition=42`：

1. 无水、无食物时推进到恒纪元第二月，不得凭空增加 12 hydration 或产生 `exited=true`；
2. 恢复完成前切回 severity 8 高温，必须继续同一 episode，不产生第二条 dehydrate、不重复扣 8 hydration，且仍有真实月度损耗；
3. 再回恒纪元并放置真实水和食物，只能通过带来源行动恢复，达到安全线后才退出；
4. 同时放入待回应社会请求，恢复完成前不得 communicate，退出后请求仍能继续；
5. 用 `project parent → 已有 interruption leaf` 的嵌套链跨过至少 4 个无来源恢复月：项目不得因假停滞 blocked，intent 数不得增长，退出后 exact leaf 恢复并能沿旧 `returnTo` 返回 parent；
6. 覆盖两名帮助者的同月幂等、recovering dependent child、普通 social intent 被 dehydrate 中断、episode 内死亡和安全退出同月死亡；不得留下 suspended orphan；
7. 保留现有预言争议、帮助者重新水化、受抚养者休眠与全员休眠结算回归。

### 配对门槛

候选仍运行相同 `3 seeds × 10 / 30 / 50 / 100 / 1000 years`。机制审计至少报告：

- `unsupportedAutomaticWakeups`；
- `unsafeHibernationExits`；
- `unbackedReserveIncreases`；
- `incompleteRecoveryRepeatHeatExposures`；
- `postWakeSevereHeatDeaths`；
- `continuedEpisodeResets`；
- `hibernationCostViolations`；
- `recoverySocialPreemptions`；
- `hibernationProjectStallBlocks` 与休眠挂起链 orphan / mismatch；
- `relevantRecoveryEpisodes`。

只要存在相关 episode，前七类不变量违规必须为 0，恢复完成前的新热灾保护覆盖率必须为 100%。50 / 100 年的 post-wake severe-heat death 比率中位数须下降，至少 2/3 配对种子不恶化；1000 年终止月份中位数不得下降，热死不能等量转移成饥饿 / 脱水死亡，也不能靠永久无动作休眠延长终局。若只改善 seed `185`，或违反任一来源 / 成本 / 终局不变量，本版拒绝。

## v1 配对结果：恢复机制成立，整体候选修订

- 冻结 bundle：`three-body/data/experiments/info-age-v1-hibernation-recovery-20260820-freeze/`；
- `main.mjs` SHA-256：`d184da241786fee1bb0c1512d53cfdd534a32d9637819f01eb9cf1e482ca7980`；
- `eland-worker.mjs` SHA-256：`f0f9617bde56ffaccd6eb377023222cb5fa129db3576f3d13b09dca93a1a2d55`；
- 矩阵：`three-body/data/experiments/info-age-v1-hibernation-recovery-20260820.json`；
- 休眠旁车：`three-body/data/experiments/audit-hibernation-v1-hibernation-recovery-20260820.json`；
- 信息时代旁车：`three-body/data/experiments/audit-info-age-v1-hibernation-recovery-20260820.json`；
- 冻结比较：`three-body/data/experiments/compare-info-age-v1-v0-20260820.txt`。

15 / 15 个独立运行均已结束。v1 在 1041 个恢复 episode、14176 个休眠成本人月中，把旧版自动苏醒、危险退出、无来源储备增加、episode 重置、月成本遗漏、恢复期普通 / 社交行动、marker orphan / mismatch 和瞬时恢复 child 全部降为 0。50 年 post-wake 严重热灾死亡率中位数从 `6.59%` 降为 `4.60%`，2 / 3 个种子不恶化；100 年从 `4.03%` 降为 `3.79%`，3 / 3 不恶化。唯一曾被旁车混入“休眠中项目终止”的事件，是 seed `185` 第 1224 月人物因 `aging-terminal` 死亡后项目按 owner-loss 合法终止；marker orphan / mismatch 均为 0。休眠旁车 v2 已把它单列为 `hibernationDeathTerminalizedProjects=1`，真实 `hibernationProjectStallsOrBlocks=0`。

但整体候选不能接受。1000 年运行仍全部真实灭绝，终止月为 `2012 / 1034 / 1319`；中位数由 v0 的 `1943` 降至 `1319`，下降 624 月。seed `20260815` 从第 1953 月提前到第 1034 月灭绝，50 年人口也从 14 降至 1。三个终端运行没有存活的 dormant / recovering 人物，没有 open recovery segment；最长 recovering 为 17 月，最长连续无恢复行动为 14 月，所有恢复段最终都有物理恢复行动。因此回归不是靠永久休眠伪存活，也不是恢复链卡死，而是更早的人口与热灾级联。

决定：**恢复阶段机制级接受，v1 整体候选 `REVISE`，不得晋级为长期基线。** 后续版本保留已经证明的来源、成本和 intent 连续性不变量，但必须先修复新暴露的最早候选断点，再继续食物、农业或能源层。

## v1b 预登记：统一紧急休眠的合法准入

### 最早断点与假设

seed `20260815` 第 70 月已经处于 severity 7 的乱纪元，Armstrong 本人具有 stage-3 heat 感知事实，动作窗口最低身体储备约为 `39.71`。领域执行器允许最低储备 `>=38` 进入脱水休眠，但普通 option 与 shelter reflex 用 `>=45` 提前删除候选；人物因此转去执行社会许可，最终在第 122 月热死并引发后续人口、建设与出生级联。

可证伪假设：若所有“已经发生的严重乱纪元”休眠候选统一复用领域合法线 38，并让带本人严重冷热证据的合法 dehydrate 抢占普通与必答社交，人物会在 `[38,45)` 的最后合法窗口进入同一可审计 episode；纯预测性的提前休眠仍保留 45 的保守线，恢复退出也仍要求 45。本版不增加水、食物、住所，不修改气候、伤害、寿命或人口公式。

### 最小机制与定向验收

- `domain/person.ts` 定义共享的进入合法线和身体 / 禁忌 predicate；executor、已发生乱纪元 option、failed-shelter reflex 与 dependent care 共用；
- `38.00` 必须可执行，`37.99` 必须被领域和候选同时拒绝；
- 稳定纪元中仅凭预测的提前休眠，在最低储备 `<45` 时仍不生成；
- severity 7、stage-3 heat、身体 `57.8 / 62.28 / 38.46`、同时存在 active project、普通社交与 required response 时，planner 必须先建立现有 `survival-reflex` interruption 并完成一次 dehydrate；退出后 required response 与原意图仍可继续；
- observed dehydrate 必须带非空、可解析、属于本人的严重冷热暴露来源，并与当前乱纪元种类匹配；仅有全局灾害、无本人暴露时，人物和照护者都不能代为绕过；
- active intent 已经准备执行 dehydrate 时，failed-shelter reflex 不得再建立第二个 survival child；安全退出后不得在恒纪元重放旧 dehydrate；
- required response 的原始截止月不改写；休眠 episode 只通过追加式 pause / resume 事实暂停该 responder 的期限，退出后按暂停时长延展，死亡仍取消；
- 同一人物只创建一个 episode；v1 的安全退出 45、真实来源、月成本、连续 marker、dependent care 与无瞬时恢复 child 回归保持不变。

### 配对门槛

仍使用相同 `3 seeds × 10 / 30 / 50 / 100 / 1000 years`。除 v1 的来源 / 成本 / marker 硬违规继续为 0 外，新增审计检查：

- 当前历史没有保存未选候选的紧急休眠 admission basis，因此 `eligibleObservedSevereHazardWithoutDehydrateOption` 必须诚实报告 `unsupported`，不能把不可观察写成 0；`[38,45)` 的已选动作、领域拒绝和定向夹具作为本版机制证据；
- `[38,45)` 的已发生严重灾害候选与 executor 结果一致，预测性候选没有放宽；
- 重复 dehydrate child、稳定纪元重放、无本人暴露的辅助休眠、休眠期间 required response 静默过期均为 0；
- 50 / 100 年 post-wake 热死率至少 2 / 3 配对不恶化；
- 1000 年终止中位数不得低于 v1，至少 2 / 3 种子不更早，且 seed `20260815` 不得再次在同一漏候选链上失败；
- 不能把热死等量转成饥饿、脱水、永久 dormant / recovering，required response 与 project intent 不得产生 orphan。

## v1b 配对结果：准入机制成立，搜索放大器要求继续修订

- 冻结 bundle：`three-body/data/experiments/info-age-v1b-hibernation-entry-consistency-20260820-freeze/`；
- 矩阵：`three-body/data/experiments/info-age-v1b-hibernation-entry-consistency-20260820.json`；
- 休眠旁车（marker / coverage 口径 v5）：`three-body/data/experiments/audit-hibernation-v1b-entry-consistency-v5-20260820.json`；
- 信息时代旁车：`three-body/data/experiments/audit-info-age-v1b-entry-consistency-20260820.json`；
- marker-aware 意图重投影：`three-body/data/experiments/reproject-info-age-v1b-marker-aware-20260820.json`；
- 配对比较：`three-body/data/experiments/compare-info-age-v1b-v1-20260820.txt`。

15 / 15 个运行均结束。原假设获得自然证据：seed `20260815` 的 Armstrong 在第 72 月以本人严重热暴露事实完成 dehydrate，v1 在第 1034 月毁灭的 100 年坐标在 v1b 走满 1200 月。50 年 post-wake 严重热灾死亡率 2 / 3 配对不恶化，100 年 3 / 3 不恶化；1000 年终止月由 `2012 / 1034 / 1319` 变为 `1319 / 1505 / 1518`，中位数由 `1319` 增至 `1505`，2 / 3 种子延后。重复 dehydrate、重复 survival child、稳定纪元已知重放、协议期限违规、来源 / 成本 / marker 违规在可判样本中均为 0；未保存未选候选的强准入率继续诚实标为 `unsupported`。

旧 `orphanSuspendedProjectIntents` 观察器把“由仍存在的 dehydrated-hibernation condition marker 持有、故意没有 interruption child 的项目意图”误报为 orphan。marker-aware 重投影把 15 个运行全部校正为 0；100 年边界上唯一 completed-project + recovering 样本在下一月安全退出时真实转为 completed。该问题属于观察链而非生产意图链，canonical runner 的行为观察器已改为同时承认 live child 与匹配的休眠 marker。

整体候选仍不晋级。10 年移动占比中位数由 `34.39%` 升至 `42.61%`，50 年由 `39.70%` 升至 `65.84%`，100 年由 `47.25%` 升至 `70.70%`；这不是仅由更多存活人月造成。50 年中约 36%–38% 的移动直接属于 project search，同一 blocked 项目可枚举 73–77 个目标并消耗 386–545 次 search move。最早放大点是 search 的 16-action 上限只约束单个 destination episode，每换目标就重置，campaign 本身没有总预算；目标排序还会先走较远路径。v1b 的休眠分支只是更早触发了这个既存放大器，不应回滚已经成立的来源化紧急准入。

决定：**v1b 的 observed-hazard admission 与重复抑制机制级接受；整体候选 `REVISE`。** 下一版只限制同一 search campaign 的累计行动预算，不同时修改气候、人口、目标排序、食物或农业。

## v1c 预登记：项目搜索 campaign 的累计预算

### 可证伪假设

同一物质缺口的搜索已经具有 project、plan、campaign、episode 与 action 事实，但预算只存在于 episode。若把同一 `searchCampaignId` 下所有 search episode 的已提交动作累计到一个 16-action campaign 上限，人物应在有限探索后进入既有 exhausted / review / blocked 结果，而不是用新的 destination 重置预算；真实来源在预算内出现时仍应正常转入 source / drop episode 并推进项目。

### 最小机制与定向验收

- 不改变 visible / reachable 约束、目标集合、排序、物质需求或 project 终态；
- campaign 累计动作只统计属于该 search campaign 的项目 action，survival reflex、协议回应与普通移动不得消耗它；
- 跨多个 destination episode 后，第 16 个 search action 可提交，第 17 个不得再编译；campaign 必须留下可回放 exhausted / closed 事实；
- 单个远目标仍受原 episode 预算约束；预算内遇到真实 source / drop 时必须完成已有转接；
- marker-aware orphan 正负例保持：匹配 dormant / recovering condition 不算 orphan，missing / mismatched condition 且无 live child 才算 orphan。

先运行 3 seeds × 10 年配对。若 `movement / actionPersonMonths`、search-move share、campaign 最大目标数明显回落，且项目完成、人口、休眠不变量没有硬回归，再扩展相同 30 / 50 / 100 / 1000 年矩阵。完整矩阵要求 1000 年终止中位数不低于 v1b 的 1505 月，至少 2 / 3 种子不更早，且不能用永久 suspended / dormant 延长终局。

## v1c 配对结果：搜索累计预算接受，本轮停止

- 冻结 bundle：`three-body/data/experiments/info-age-v1c-search-campaign-budget-20260820-freeze/`；
- 矩阵：`three-body/data/experiments/info-age-v1c-search-campaign-budget-20260820.json`；
- 10 年先行门槛：`three-body/data/experiments/info-age-v1c-search-campaign-budget-10y-preflight-20260820.json`；
- 休眠旁车：`three-body/data/experiments/audit-hibernation-v1c-search-campaign-budget-v5-20260820.json`；
- 信息时代旁车：`three-body/data/experiments/audit-info-age-v1c-search-campaign-budget-20260820.json`；
- 搜索 campaign 预算旁车：`three-body/data/experiments/audit-project-search-campaign-budget-v1c-20260820.json`；
- marker-aware 意图重投影：`three-body/data/experiments/reproject-info-age-v1c-marker-aware-20260820.json`；
- 配对比较：`three-body/data/experiments/compare-info-age-v1c-v1b-20260820.txt`。

10 年先行门槛通过后才扩展长程矩阵。三个种子的 `movement / actionPersonMonths` 分别由 `2.1467 / 2.1568 / 1.5586` 降为 `1.3856 / 1.3430 / 1.5586`；search move 由 `192 / 275 / 36` 降为 `24 / 70 / 36`，campaign 最大目标数由 `40 / 39 / 1` 降为 `2 / 3 / 1`。自然历史中跨多个 destination episode 抵达 16 步的 campaign 都在第 16 个已提交搜索动作后留下 exhausted / closed 事实，没有第 17 步；原本没有搜索放大器的 seed `20260816` 保持等价，构成自然负控。

完整 `3 seeds × 10 / 30 / 50 / 100 / 1000 years` 共 15 个独立运行全部结束。移动占比中位数在 10 / 30 / 50 / 100 / terminal horizon 分别由 `42.61 / 54.24 / 65.84 / 70.70 / 70.49%` 降为 `29.04 / 36.08 / 41.20 / 36.84 / 36.35%`；search episode 中位数由 `41 / 246 / 808 / 1363 / 1363` 降为 `6 / 45 / 131 / 226 / 228`，campaign 最大目标数中位数由 `39 / 48 / 77 / 83 / 83` 降为 `2 / 4 / 5 / 5 / 5`。这不是少活人月造成的比例假象：30 / 50 / 100 年人口中位数分别由 `11 / 6 / 2` 增至 `14 / 13 / 5`。search episode coverage 为 100%，missing campaign、重复目标、越界目标、actor / project / material mismatch 与 unresolved action 均为 0。

代价也保留在结论中。10 年完成项目中位数 `10→9`，30 年 `36→25`；搜索有限失败更快进入 review / blocked，50 / 100 / terminal 的 blocked 项目中位数由 `51 / 89 / 94` 增至 `64 / 123 / 136`。不过 50 / 100 / terminal 的 completed 项目中位数由 `62 / 82 / 83` 增至 `65 / 91 / 93`，说明预算没有把长期生产全部关死。1000 年上限运行仍全部真实灭绝，终止月由 v1b 的 `1319 / 1505 / 1518` 变为 `1538 / 1708 / 1265`：两个种子分别延后 `219 / 203` 月，一个种子提前 `253` 月，中位数 `1505→1538`，满足预登记的中位数不下降与至少 2 / 3 不更早，但不能宣称所有轨迹都改善。

休眠旁车在 15 个运行中没有发现自动苏醒、危险退出、无来源储备增加、月成本遗漏、项目假停滞、marker orphan / mismatch、恢复前普通行动、重复 dehydrate 或协议期限硬违规。`stableEpochDehydrateReplays` 因历史字段覆盖不足仍为 partial，照护者辅助恢复没有自然正例而为 unsupported，恢复后必答回应存在少量不可观察窗口，强未选休眠候选率因未保存候选全集继续 unsupported；这些空白没有被伪写成零。

最终全历史审计又发现一条必须保留的自然反例。seed `20260815` 从第 437 月开始的 copper-charge 项目，以同一 `actor + project + materials=13,35,38 + plan=none` basis 建立 campaign 0；它搜索 6 步后被 supersede，第 444 月又以同一 basis 建立 campaign 2，再搜索 16 步。单个 campaign 都没有超过上限，但同一因果缺口累计达到 22 步，且新 campaign 没有继承旧目标。该现象在 50 / 100 / terminal 三个独立 horizon 中重复出现，来自同一确定性历史，不是三个独立自然案例。这证明预算绑定在 `searchCampaignId` 仍可被 same-basis reopen 绕过；真正的失败记忆与总预算应绑定到 actor + project + material + plan 的因果 basis 生命周期。

决定：**v1c 的单一 project search campaign 累计预算机制 `ACCEPT`，预登记的移动与终局数值门槛通过；整体长程候选 `REVISE`，不得宣称无界搜索已经彻底封死。本轮按用户要求在此停止，不再实现 v1d。** 15 个信息时代旁车仍全部为 `unsupported`；历史峰值只到原始部落 / 定居耕作，铁最多为单个样本，完整记录读取链仍为 0。连续电能、受控机器、跨址信号、机读载体、世界内算法、独立科研复核、标准网络制度与社会替任八项事实均未实现。

## 后续边界

截至本轮停止点，休眠连续性、紧急准入和单一 campaign 内的项目搜索已经得到阶段性修复；same-basis reopen 仍是下一处最早断点。当前代码的项目与物理图谱仍确定性封顶于铁器 / 中世纪：没有钢、连续动力、电网、远距信号、程序执行与相应制度。若未来恢复演进，应先让搜索失败记忆跨 campaign 绑定因果 basis，再逐层增加通用的世界实体与可回放后果，而不是单独扩展时代枚举；本轮不再启动这些后续版本。
