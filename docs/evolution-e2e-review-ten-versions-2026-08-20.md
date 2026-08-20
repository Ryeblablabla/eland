# 整体游戏审查与十版因果演进（2026-08-20）

## 范围与方法

本轮同时运行两条相互约束的演进闭环：

1. 世界内闭环：`压力 → 感知 → 记忆 → 需要 → 项目 → 计划 → 合法行动 → 后果 → 学习 → 传播 → 制度`；
2. 工程闭环：`新鲜基线 → 最早断点 → 单一假设 → 最小机制 → 定向回归 → 同种子配对 → 接受或拒绝`。

端到端测试覆盖宇宙与人间的连续缩放、人物与建筑观察、对话、进度、存档 / 读档、新文明、移动视口与后端恢复。规则候选不读取文明指数，不为种子或期望结局增加特判；拒绝样本与失败运行均保留。

## 冻结基线

- 代码版本：`7a50b51`（矩阵启动时工作树无规则代码改动）；
- 种子：`185, 20260815, 20260816`；
- 时长：`10, 20, 30` 年；
- 配置：`chaosIntensity=0`、`climateBias=balanced`、纯本地规则；
- 产物：`three-body/data/experiments/review10-baseline-7a50b51-20260820.json`；
- 历史 v9 只作旁证，不能作为当前基线；差异文件为 `three-body/data/experiments/compare-v9-review10-baseline.txt`。

| 时长 | 人口中位数 | 项目完成中位数 | 项目阻塞中位数 | 移动占比中位数 | 记录使用完整链 | 技术学习完整链 | 孤立悬挂项目意图 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 年 | 9 | 14 | 8 | 56.80% | 0 | 0 | 1 个样本出现 |
| 20 年 | 9 | 21 | 17 | 53.42% | 0 | 0 | 1 个样本出现 |
| 30 年 | 8 | 29 | 30 | 55.63% | 0 | 0 | 1 个样本出现 |

基线没有灭绝，但项目阻塞持续累积，知识的记录使用和技术学习闭环均未发生。种子 `20260815` 在三个时长都保留了一个孤立悬挂项目意图，直接支持第一版的断点判断。

## 逐版登记

每版先做确定性因果回归；会改变群体行为的版本再以唯一前缀运行 `3 seeds × 10y`，通过后扩展 `20/30y`。修正引擎不变量但没有足够自然触发频率的版本，定向回归是主要验收证据，矩阵只作回归护栏。

### v1：协议履约使用显式父子中断

**预登记假设。** 协议履约 continuation 替换人物现有项目意图时，当前实现只把父意图裸设为 `suspended`。本地规划器不会生成恢复动作，故父意图可能永久悬挂。若 continuation 复用统一的父子中断协议，则履约终结后应精确恢复同一个父意图，且不丢失项目进度和行动历史。

**最小修改。** 仅统一 `installAgreementContinuation` 的中断不变量：child 写入 `returnToIntentId`，parent 写入 `suspendedByIntentId`，终结后仍由 `resolveInterruptedIntentReturn` 处理。

**定向验收。** 构造另一方已有进行中项目、随后接受水源协助或交换履约；要求父子引用对称，履约完成或失败后返回结果已解析，同一个 parent ID 恢复，原进度与 `actionEventIds` 不变，且能够继续执行项目动作。

**矩阵门槛。** 三个配对种子的 `orphanSuspendedProjectIntents` 全部为零，`interruptUnresolvedTerminalChildren` 不增加；项目完成、儿童死亡和移动占比不得出现一致性严重回归。

**结果与决定。** 接受。`npm run test:intent-interruption` 与主模拟回归通过；候选矩阵为 `three-body/data/experiments/review10-v1-intent-recovery-20260820.json`，配对差异为 `three-body/data/experiments/compare-review10-v1.txt`。10 年矩阵里只有种子 `20260815` 自然触发了一次 fulfillment child，它被解析并恢复；三个种子的孤立悬挂项目意图都为 0，未解析终态 child 都为 0。基线相同种子有 1 个孤立悬挂项目意图。项目完成中位数从 14 到 17，阻塞中位数保持 8，移动占比没有一致方向，儿童死亡均为 0。该机制通过，但自然触发仍稀少，不能据此推断长期协作频率。

### v2：生命周期统一使用将要提交的月份

**预登记假设。** `prepareMonth` 已把本次提交定义为 `elapsedMonths + 1`，但候选生成、年龄门禁和行动刻度仍有路径读取旧 `elapsedMonths`，执行器却读取新月份。人物跨越 1、12、16 岁边界时，同一规则月可能同时拥有前后两个生命阶段，导致候选与执行许可互相冲突。

**最小修改。** 把当前规划月作为显式 `atMonth` 传入决定资格、候选生成和全部年龄相关过滤；提交前的只读 UI 查询继续使用当前已提交月，不偷看下一月。创世月 bootstrap 单独保留，不通过回退旧时钟实现。本版不顺手改写项目和社会选项中所有时间 ID，那是另一个更宽的时钟协议问题。

**定向验收。** 通过真实 `stepSimulation` 分别跨越 1、12、16 岁边界，记录同一月的 DecisionContext、计划与执行；要求每条路径使用同一个阶段，满 1 岁不再被携带，满 12 岁可参与既有项目，满 16 岁才可提出完整项目 / 生育选择，且边界前一月仍受原阶段约束。

**矩阵门槛。** 三个 10 年配对种子无年龄越权、无新增未解析意图；生存、项目完成、移动占比和人口不出现一致性严重回归。年龄边界是确定性不变量，群体矩阵只作护栏，不要求聚合指标单向上升。

**第一次候选（v2a）决定。** 修订，不升级基线。`review10-v2-life-stage-clock-20260820.json` 虽通过 1 / 12 / 16 岁定向回归，但同时把关系提议 basis 的年龄带推进到新月，超出最小假设。在三个 10 年配对种子中，战略意图占比中位数从 23.35% 降至 15.26%，项目完成从 17 降至 12，沟通从 353 增至 402；其中两个种子同向出现社交挤压。v2b 删除这部分额外变化，只保留决定资格、年龄门禁、教学 / 生殖年龄与执行刻度的一致月份，再以新 run ID 复验。失败矩阵和 `compare-review10-v2.txt` 保留。

**v2b 结果与决定。** 生命周期机制级接受，组合候选继续修订。v2b 的定向回归仍通过，说明 1 / 12 / 16 岁的候选和真实执行已使用同一个提交月；但 `review10-v2b-life-stage-clock-20260820.json` 的群体结果与 v2a 基本相同。进一步定位发现，生殖年龄改为新月后，“本月是否已尝试”、有效协议与重编译仍读取旧月，能在同一个真实月份重新暴露生殖行动。生殖尝试中位数从 6 增至 13，与战略占比和项目完成回落同时出现。不能回退正确年龄门禁；下一版必须先统一协议行动的当前月。配对差异为 `compare-review10-v2b.txt`。

### v3：协议行动、重编译与事实 ID 使用当前提交月

**预登记假设。** v2 修正年龄后，生殖候选按新月开放，但“本月已尝试”及部分有效协议判断仍按旧 `state.clock.elapsedMonths`，使同一真实月可能重复生成生殖行动；交换、许可、预言、教导和社会提议也存在同类一月偏差。若所有当月候选与重编译显式使用 `atMonth`，则同一伴侣每月最多一次生殖尝试，协议过期月不会继续行动，事实 ID / 到期月与提交月一致。

**最小修改。** 沿 action/social/conversation/agreement-continuation 规划链显式传递 `atMonth`，替换候选期与重编译期的旧月读取；项目内部已明确以 `elapsed + 1` 表示规划月，本版不机械改动项目状态机。

**定向验收。** 同一有效生殖协议在一个 `stepSimulation` 的 15 tick 内最多一次尝试，下一月可按窗口重试；接受月、到期月和撤回边界一致。交换、许可和 mandate 在提交月过期后不产生履约动作；新建社会表示、教学与实验事实 ID 携带实际提交月。

**矩阵门槛。** 三个 10 年种子的生殖尝试不再因同月重复而翻倍；战略 / 项目指标应从 v2 的社交挤压中恢复，且 v1 的意图恢复不变量保持。

**第一次候选（v3a）决定。** 拒绝并修订。定向测试证明同月新接受的协议能够立即授权行动，`review10-v3-current-month-protocol-20260820.json` 也让协议、社会表示和事实 ID 使用了提交月；但运行历史显示断点还在更深一层。种子 `185` 的第 37 月先出现一次成功的 `reproduce`，下一 planning tick 另一方预先安装的生殖意图又执行了一次，才被执行器以 `attemptedThisMonth` 阻塞。也就是说候选生成已不再重复开放，既存的镜像履约意图仍浪费一个行动。该样本直接违反“一个伴侣对每月最多一个生殖 ActionFact”的预登记门槛，因此即使人口、战略占比和项目行动回升，也不能接受。失败矩阵及 `compare-review10-v3.txt` 保留；v3b 只修正镜像履约意图的同月终止 / 延后语义后重跑。

**v3b 结果与决定。** 接受。镜像意图现在把另一方已提交的生殖尝试视为同一个联合过程的本月终点，不再伪造第二条 blocked ActionFact；若没有受孕，仍由有效协议在下一月暴露一项新选择。整月 15 tick 回归通过，三个矩阵状态按“月份 + 无序人物对”重投影后均没有重复生殖 ActionFact。候选矩阵为 `review10-v3b-current-month-protocol-20260820.json`，差异为 `compare-review10-v3b.txt`。10 年中位人口 9、出生 3、项目完成 14、项目阻塞 12；孤立悬挂意图和未解析终态 child 都为 0。生殖尝试中位数 22 高于 v2 的 13，是有效协议在不同月份的真实重试，不是同月重复；它没有增加受孕中位数（仍为 3），因此不把该数量上升本身当收益。

### v4：失败冷却绑定失败意图与事实基础

**候选假设（待 v3 完成后正式启动）。** 当前规划只要发现六个月内的失败记忆中文摘要包含候选摘要，就直接删除候选；它既无法区分新来源 / 新目标 / 新前提，也可能在 required-response 收敛前吞掉必须回应和履约。若冷却只匹配一条可追溯失败 intent 的稳定目标—行动 basis，并在出现新 `sourceFactIds` 或前提变化时重开，则人物既不会机械重复同一次失败，也不会对变化后的世界永久失明。

**最小修改。** 不扩展 SQLite schema。只解析四类带精确 intent ID 的结构化失败记忆，回查旧 intent 的 goal、target、next/opening action、project、record-use basis 与 sources；普通 action failure 和无法关联 intent 的旧文字记忆 fail-open。required-response 与 fulfillment 完全绕过普通冷却。

**定向验收。** 同一 collect / 项目行动在同一 basis 的 1–6 月被冷却；新增真实来源、目标位置、目标数量或人物、项目 / record basis 后立即恢复；第 7 月恢复；相似中文摘要不误杀；exchange 的必须回应与真实履约即使有同 basis 失败记录仍保留并被本地规划器优先选择；JSON round-trip 后结论不变。

**矩阵门槛。** 三个 10 年种子的强制回应、履约、失败、项目与移动观察器无结构性错误；不把“候选更多”自动当成功，需检查新增行动是否确有新事实 basis。

**结果与决定。** 机制接受，性能实现列为需继续收敛。`test-failure-basis-retry.mjs` 覆盖四类结构化 memory、含冒号 intent ID、同 basis 0–6 月冷却、第 7 月恢复、新来源 / 位置 / 数量 / 人物 / 项目 / record / relationship basis 重开、相似摘要 fail-open，以及 required response / fulfillment 绕过。候选矩阵为 `review10-v4-failure-basis-retry-20260820.json`，差异为 `compare-review10-v4.txt`。项目完成中位数从 14 到 17，阻塞保持 12；移动占比中位数从 58.03% 到 53.26%，但三个配对种子方向不一致；所有来源、项目、意图和物流观察器仍无结构错误。不能把项目上升直接归因于重试，因为规则分支已经分化。代价是失败后合法候选扩张让主模拟回归从约 11 秒增至约 26–35 秒；索引与同目的地寻路缓存已消除全表重复工作，剩余热点是新增候选的真实寻路。本版不回退到摘要误杀，但最终交付前必须重新测量；若后续局部项目去重不能收回成本，应把合法性与路径估价拆成惰性阶段。

### v5：材料贡献请求按当前缺口续期

**预登记假设。** 当前项目只要历史上请求过同一种材料，就永久禁止再次请求；请求过期、听者死亡、材料已换持有人或只完成部分缺口时都会形成不可恢复死路。若阻挡条件改成“当前仍有一份可履行且未满足的开放请求”，则旧历史继续可追溯，但失效请求不再封死项目。

**最小修改。** 本版不引入大型请求状态机或数据库 schema：从现有 append-only request basis 派生 `open / expired / fulfilled / contributor-unavailable`；只有 open 请求阻挡同项目同材料的新请求。executor 用同一派生规则拒绝真正重复的开放请求。贡献量始终截断为 `min(请求剩余量, 当前 branch 缺口)`；旧请求不因续发而删除。先保留已实现的 alloy 固定场地范围，不在同一版顺手泛化全部项目类型。

**定向验收。** 初始持有人不交付后死亡、材料转到新持有人，应允许立即续发；请求过期后仍有缺口应允许续发；同一开放请求必须被规划器和 executor 双重拒绝重复；已由 owner 自采补齐的缺口不得继续运输；贡献只计入有效期限内对应请求。

**矩阵门槛。** 三个 10 年种子的重复开放请求、超缺口运输、无存活贡献者开放请求和请求后项目 / actor / material 失配均为 0；材料贡献与项目完成可变化，但不得以制造重复请求换取。

**结果与决定。** 接受。定向回归覆盖旧听者死亡、请求过期、开放请求双层去重、owner 自采补齐、按缺口截量、精确 `requestEventId`、有效期边界、旧无引用事实兼容与 JSON 往返。候选矩阵为 `three-body/data/experiments/review10-v5-material-request-renewal-20260820.json`，差异为 `three-body/data/experiments/compare-review10-v5.txt`。三个自然样本共形成 4 份材料请求；其中种子 `20260815` 的同项目同材料请求在首份过期后真实续发，另外两个种子没有行为变化。该种子的材料贡献进度从 262 增至 404、项目完成从 17 增至 19，同时阻塞从 17 增至 18；三种子中位项目完成从 17 到 19、阻塞仍为 12、移动占比从 53.26% 到 52.97%。这足以证明死路被打开，但不足以把后续所有分支增长归因于一次续发。

### v6：客观功能完成先于 owner 丧失判定

**预登记假设。** 月内行动已经形成项目要求的客观功能时，owner 若在同一月死亡，当前同步顺序会先把项目阻塞并清空需求，再检查完成条件。这样会把已经存在的耕地、住所、设施或记录结果改写成失败。若先冻结完成证据并完成项目，再处理仍未满足功能的 owner 丧失，则终态应忠实于客观世界。

**最小修改。** 只把 `projectFunctionSatisfied` 与 `completionEvidence` 移到 active 项目的 owner 生存分支之前；不在本版引入继任者或项目所有权转移。个人背包型功能仍由既有满足谓词要求 owner 存活，照护项目仍不会误完成。

**定向验收。** 构造已完成 6 次播种与 2 次收获的定居耕作项目，在同步月把 owner 标为死亡；要求项目成为 `completed` 而非 `blocked`，保留全部客观行动证据，并以 `project-completed` 关闭物流。未满足功能的死亡 owner 仍按原逻辑阻塞。

**矩阵门槛。** 三个 10 年种子的项目终态月份与证据引用无结构错误；自然触发可为零，不能因稀有事件把无变化误报为收益。人口、项目完成 / 阻塞和孤立意图只作守护。

**结果与决定。** 接受不变量，宏观效果不作结论。`test-project-completion-before-owner-loss.mjs` 证明已形成 6 次播种与 2 次收获证据的项目在 owner 同月死亡时完成、证据不丢且物流以 `project-completed` 结束；未满足项目仍阻塞。候选矩阵为 `review10-v6-complete-before-owner-loss-20260820.json`，差异为 `compare-review10-v6.txt`。三个 10 年样本的 94 个项目没有自然命中“功能满足与 owner 丧失同月”，人口、项目终态、行动和移动指标逐种子与 v5 完全相同；所有终态月份、证据引用及终态后进展违规为 0。唯一变化是完成检查提前后少做一次无效压力刷新，因此本版的接受依据是确定性不变量，而非自然矩阵收益。

### v7：同功能项目只在局部事实重叠时去重

**预登记假设。** 除耕作外，任意地点只要已有同 `desiredFunction` 的 active 项目，当前规划就把它当文明级单例；与此同时，陌生人只有看见带行动历史的 construction site 才能加入。远方项目因此会压掉本地真实压力，却又不能被本地人物接手。若去重只依赖可见 site、重叠受益者或本人已被项目事实明确关联，则隔离群体可以并行解决同类问题，同地人物仍优先加入已有工程。

**最小修改。** 新增局部重叠谓词：同功能项目仅在 site 服务范围重叠、beneficiary 交集、本人是 beneficiary / contributor、收到有效项目请求，或看见已有真实进展的 construction site 时阻挡新提案。没有显式 site 的 construction 提案冻结在提案者当前地点；加入已有项目与新提案复用同一“已知且可加入”边界。不引入文明级 registry 或隐藏 owner 位置读取。

**定向验收。** 远方 active 同功能项目存在与不存在时，本地候选深等价且仍可新建；交换人物 / ID 仍成立。同地可见、有真实行动的项目不重复新建；本人已是 beneficiary / contributor 或在现场看见进展时，若可编译下一步则优先返回已有 `projectId`，不再同轮新建。

**矩阵门槛。** `localDuplicateStarts=0`；允许出现有真实行动的远距同功能项目；按 `desiredFunction` 报告并行启动、完成和阻塞，不以项目总数上升自动判成功。人口、孤立意图、移动及 v1–v6 结构守卫不得回归。

**第一次候选（v7a）决定。** 拒绝并修订。局部谓词、construction site 锚定和已有工程接续的定向回归都通过；矩阵也出现 19 个外部 actor–project 贡献对、212 个绑定项目的行动，证明“可加入”不再只是静态候选。但历史重投影发现 `localDuplicateStarts=3`，都是已有同址 `weather-shelter` 仍 active 时又新建同类项目。首轮把三项都归因于更高优先级的 shelter adaptation 入口，因而 v7b 先让 adaptation 复用同一 overlap 边界；失败矩阵 `review10-v7-local-project-dedup-20260820.json` 与 `compare-review10-v7.txt` 保留。

**第二次候选（v7b）决定。** 仍拒绝。更精确的项目字段审计纠正了第一次归因：v7b 消除 adaptation 重复后仍有 `localDuplicateStarts=2`，两项都不是 adaptation，而是同一 planning tick 预先编译的两个人物候选。第一个人的项目在 tick 内先提交，第二个人仍持有提交前快照中的新建候选，于是同址 `weather-shelter` 再次创建。失败矩阵 `review10-v7b-local-project-dedup-20260820.json` 与 `compare-review10-v7b.txt` 保留。v7c 必须在 `ensureProject` 的权威提交边界再次运行同一局部 overlap 判定，把竞态候选链接到刚创建的 existing project；仅靠候选生成期去重不足以保证不变量。

**第三次候选（v7c）决定。** 仍拒绝。提交边界成功把两项竞态 proposal 合并，`localDuplicateStarts` 降为 0，173 条项目意图的 goal / project ID、项目存在性和孤立悬挂均无异常；但两条被合并的第二人物意图都在 0 次行动后立即 blocked。原因是 existing project 仍只保留第一份 proposal 的 beneficiary，第二个人虽然作出了有真实建材和压力依据的权威选择，却在合并时丢失参与关联，重编译因而返回空。种子 `20260816` 同时出现人口 8→5、完成项目 15→8、移动 49.22%→62.25% 与一例儿童暴露死亡；死亡距早期合并 109 个月，不能直接归因，但已经构成明确守护回归。失败矩阵 `review10-v7c-local-project-dedup-20260820.json` 与 `compare-review10-v7c.txt` 保留。v7d 只在合并时把第二份已提交 proposal 的 beneficiary 与 trigger facts 并入 existing project，不预先伪造 contributor；真实行动后才登记贡献。

**第四次候选（v7d）决定。** 仍拒绝。合并后的 beneficiary 与 trigger facts 已完整保留，定向夹具中第二人持有建材时也能重编译；但自然样本的第二人候选都是绑定 drop / source 的物流起步，而 existing project 当时仍有第一人物的 active logistics episode。项目意图执行前无条件重编译，忽略了仍保存在 intent 中的预选 `choice.nextAction`；foreign episode 规则随后返回空，因此两条合并意图依然 0 action blocked。宏观指标与 v7c 完全相同。失败矩阵 `review10-v7d-local-project-dedup-20260820.json` 与 `compare-review10-v7d.txt` 保留。v7e 不创建第二个物流 episode，只把已通过规划和提交校验的 coalesced `choice.nextAction` 执行为一次 opening action，并把事实归入 existing project；之后才恢复普通重编译。

**第五次候选（v7e）决定。** 仍拒绝。两条 coalesced intent 的 opening move 都真实执行并归入 existing project，人口与儿童暴露守护也从 v7c / v7d 的极端分支恢复；但两人都只完成这 1 个动作，下一 planning tick 在第一人物 episode 尚未结束时再次重编译为空，仍于同月 blocked。Armstrong 的 linked project 随后在同月完成，说明这不是不可恢复失败，而是协作步骤的提交顺序。失败矩阵 `review10-v7e-local-project-dedup-20260820.json` 与 `compare-review10-v7e.txt` 保留。v7f 只允许非 owner 的新共享项目意图在创建月遇到 active project 暂无步骤时等待后续 tick；项目完成则由 goal 收敛，episode 释放则继续重编译，跨到下一月仍无步骤才沿原逻辑阻塞。

**第六次候选（v7f）结果与决定。** 接受。v7f 撤回了 v7e 的隐式 opening：合并意图不执行陈旧 proposal 的 `nextAction`，也不把它伪装成现有项目行动；仅在“active existing project + 非 owner + intent 创建月”这一有界条件下等待。同种子矩阵 `review10-v7f-local-project-dedup-20260820.json` 与 `compare-review10-v7f.txt` 中，`localDuplicateStarts=0`，两次权威提交合并都没有 stale opening。Armstrong 的意图在零行动等待后随 existing project 同月完成而完成；Heidi 等到 owner 的物流 episode 释放后，基于 existing project 重编译出 8 个真实项目行动、真实贡献木材并成为 contributor，项目于第 10 月完成。她的意图最终因真实 combine 占位冲突阻塞，不再是空重编译造成的假失败。155 条项目意图的 goal / project 引用、项目存在性和孤立悬挂均无异常；远距同功能并行有 2 对且双方均有行动，局部重复仍为 0。三种子最终人口为 9 / 10 / 9，儿童暴露死亡为 0。保留一项非阻断观察：等待释放后的首次重编译仍可能追向已被 owner 取空的旧 drop，执行器会以 source invalidated 拒绝并继续恢复；它没有破坏本次不变量，但应由后续物流候选新鲜度版本单独处理。

### v8：观察到工具或构件不等于已经拥有能力

**预登记假设。** 局部材料证据已经区分“看见过”“本人持有或眼前可拾取”和“设施已经放置”，但项目门禁仍用 `observedMaterialIds` 判断生产工具与设施存在。因此另一人物背包里的木工具、谷仓或高温设施构件会错误抑制本人项目，失效的历史地点也可能被当成现存能力。若门禁按能力类型消费正确证据，则观察仍可形成认知线索，却不能替代本人可使用工具或真实落地设施。

**最小修改。** 生产工具及非设施完成产物只读 `accessiblePortableMaterialIds`；Workshop、Granary、Cistern、Mill、CouncilHearth、CivicHall、KeepCore、Kiln、Foundry 与 Smithy 的存在门禁只读 `placedFacilityMaterialIds`。删除“看见别人携带设施构件就不再立项”的特殊抑制；真实项目重复仍由 v7 的局部 overlap 不变量处理。不扩张为路径、容器权限或文明级设施注册表。

**定向验收。** 看见别人持有 WoodTool 时，本人仍可提出 `efficient-production`；本人持有或眼前有可拾取 WoodTool 时才抑制。看见别人携带 Granary / Kiln 构件不抑制储备或高温能力项目；真实设施体素会抑制；指向已消失体素的 stale `knownPlace` 只能证明曾观察，不能证明设施仍存在。

**矩阵门槛。** 三个配对种子的能力项目按功能报告启动、完成和阻塞；检查他人携带构件造成的错误抑制为 0、已放置设施附近的无必要重复不增加。人口、项目终态、局部重复、孤立意图、移动与 v1–v7 结构守卫不得严重回归。设施或工具项目增加不是自动收益，必须有完成与实际行动 / 使用证据。

**结果与决定。** 接受。定向回归证明旁人背包中的 WoodTool / Granary / Kiln 仍只进入观察集合，本人或眼前 drop 中的工具才进入便携能力，真实设施体素才进入设施能力，失效 `knownPlace` 不再抑制项目。矩阵为 `review10-v8-accessible-capability-20260820.json`，与 v7f 的差异为 `compare-review10-v8.txt`。自然历史中有 4 / 8 个 `efficient-production` 项目在创建时 owner 没有可用工具、但视野内另一人物持有工具；旧错误抑制为 0 / 4，四项都完成。其中两个样本可与 v7f 同月同人精确对照：旧版错误进入 `workshop-production` 并阻塞，v8 改为个人工具项目并同月完成。`efficient-production` 从 5 启动 / 5 完成变为 8 / 8，`workshop-production` 从 9 / 1 / 6 / 2 变为 3 / 1 / 1 / 1（启动 / 完成 / 阻塞 / active），不是简单增加项目数。13 次设施放置之后，所有同设施功能的新项目都在视野外，局部无必要重复为 0；矩阵没有“旁人携带设施构件时正好形成新项目”的自然样本，因此这部分只由定向夹具支持。总项目仍为 58，完成 30、阻塞 22、active 6；局部重复、意图引用、项目引用、孤立悬挂、死亡和儿童暴露均为 0。

### v9：耐久记录必须经过项目绑定的公开发布

**预登记假设。** 当前 `durable-record` 项目只要作者在私有背包载体上写出 record 就立即完成；六份历史记录中五份一直由作者私有持有，知识链在潜在读者看到载体之前已经断裂。若“写出”与“公开保存”被拆成两个可回放事实，则完成项目应保证同一 payload 被 owner 主动放到提案时冻结的固定地点，死亡掉落或错误地点不会冒充公共记录。

**最小修改。** `durable-record` proposal 固定 owner 当时的 site；写入后先保留私有 carrier，再移动到 site 并执行精确的 person→ground transfer。项目完成同时要求：本项目中 owner 的已完成 record write、同 payload 的 owner→ground 投放、当前同 site drop 仍存在且 lineage 引用该投放。completion evidence 只由写入与投放组成。ground destination 增加近身合法性，禁止远程放置。不引入公共容器，也不改变直接教学可靠性。

**定向验收。** 写入完成后 record 在作者背包、项目仍 active；离开 site 时下一步是移动，到位后才投放；投放后 drop 的 payload 与来源链完整、项目完成且证据含两项事实。私有载体、错误 site、死亡掉落、缺失 lineage 均不完成；远程 ground transfer 被阻塞且数量守恒。给 inquiry 项目增加 site 后，不得把同地但不同知识目标的记录项目按 v7 的 construction 空间规则误合并；同月前一 tick 的写入 / 投放事实必须在下一 tick 可见。

**矩阵门槛。** 由于 10 年基线常为 0 条记录，主证据使用 3 seeds × 30y，并保留同种子的 10 年守卫。`durable-record` 完成必须 100% 具有 write→project-bound placement 链；private-only、wrong-site、death-drop completion 为 0。报告 record 的最终位置与公开投放延迟；另一人物取得或阅读仅作 v10 前置观测，不作为本版成功条件。人口、项目、移动、局部重复与结构引用不得严重回归。

**第一次候选（v9a）决定。** 发布机制接受，整体候选继续修订。候选矩阵为 `review10-v9-public-record-20260820.json`；10 / 30 年分别与 v8 配对于 `compare-review10-v9-10y.txt`、`compare-review10-v9-30y.txt`。10 年没有 durable proposal；30 年共有 4 个项目，1 完成、3 阻塞。唯一完成样本是种子 `20260816` 的李白：第 240 月在本项目中写入，第 241 月把同 payload 从本人背包投放到固定 `site=1522/z5`，completion evidence 精确等于写入和投放两项；write→place 延迟 1 月。completed-without-chain、private-only、wrong-site、death-drop、unbound 与 evidence mismatch 全为 0，payload 数量为 1、无重复或丢失。公共载体在原 site 停留 34 月后被一名非作者孩子拾取，说明公共可达性真实发生；但她没有阅读或理解，不能把 v9 误报为知识传播闭环。审计同时发现，李白写入时已经位于固定 site，旧 material-search logistics episode 却继续优先，驱使他离开并产生 17 个项目绑定 move 后才返回投放。它是 write→publication 之间更早的计划优先级断点，v9b 只在存在本项目合格 written carrier 时让发布步骤绕过过时搜索 / 物流，再配对复验。10 年人口均值 10→9.33、死亡仍为 0、项目完成均值 10→12.67、移动占比 47.77%→40.87%；30 年人口配对差异为 -8 / -3 / +7、死亡均值 4.67→5.67、项目完成均值 23→24.67、移动占比 52.32%→40.99%。长期人口方向强烈分化，不能归因于仅一项发布；作为守卫警示保留。

**v9b 预登记。** 不改记录完成证据、项目压力或权重；只在 owner 已持有与本项目写入事实匹配的 record carrier 时，把 `durableRecordStep` 放到 active search / logistics 之前。旧 episode 不提前伪终结，真实投放使项目完成后仍由现有 `project-completed` 收束。定向回归要求人在 site 时 write 后下一项目动作就是投放，不发生离场移动；不在 site 时只走回 site 的必要路径。矩阵继续要求有效发布链 100%、伪完成 0，并比较 write→place 延迟和发布前项目移动；人口与死亡仍只作配对守卫。

**v9b 结果与决定。** 发布优先级机制通过，整体仍修订。唯一自然成功仍是种子 `20260816` 的李白，但写入 `e-240-action-libai-2` 后，下一 planning tick 就在同月以 `e-240-action-libai-9` 原地投放；write→place 延迟从 1 月降为 0，投放前项目绑定 move 从 17 降为 0，旧 search episode 由 `project-completed` 正常关闭。随后载体在第 281 月被非作者孩子拾取，却在第 330 月被她的 `workshop-production` 项目当作普通 WoodenRecordTablet，与 WoodPlank 结合成 ToolShed；该 action 不再携带 payload，终态记录实体丢失。发布完成没有伪证，但“耐久记录”被普通材料规划无意抹除，违反载体守恒，因此 v9b 矩阵 `review10-v9b-publication-priority-20260820.json` 不能整体接受；30 年配对为 `compare-review10-v9b-30y.txt`。

**v9c 预登记。** 带 `recordPayloadId` 的 stack 是信息载体，不得被普通 `combine / exert / expose` 当消耗性材料；未来若要擦除或回收必须设计独立、可追溯动作。本版在领域执行器提交前拒绝任何以带 payload 背包 stack 为消耗输入的普通 act，并让项目已知配方、假说配对和通用子组件选择忽略这类 stack，避免制造 blocked 循环。transfer、attend 与 record communicate 保持合法。定向回归要求普通结合被阻塞且物质 / payload 守恒，规划器在只有已写载体时不生成消耗动作，加入空白同材质载体后仍可正常制作；矩阵要求发布后的 payload 不重复、不丢失、不被普通 action 消耗，其他项目与物流不回归。

**v9c 结果与决定。** 载体守恒机制通过，整体仍修订。李白仍在第 240 月连续两个 tick 完成 write→place；第 281 月被非作者拾取后，payload 到终态仍由同一存活人物的一份 stack 持有，holder 总量 1，duplicate / lost / dangling 与普通加工的 completed consumption 都为 0。矩阵 `review10-v9c-record-carrier-preservation-20260820.json` 同时暴露规划层遗漏：`action-options.ts` 的 `tangibleInventoryStacks` 仍把带 payload 的 WoodenRecordTablet 加入普通库存试验，第 282–332 月生成 8 次 `try-inventory-combine`，全部被 executor 正确 blocked；其中一次还是 grounded conversation 的 follow-up。执行兜底不能替代候选合法性，因此不接受整体候选；与 v9b 的配对为 `compare-review10-v9c-30y.txt`。

**v9d 预登记。** 只在通用人物行动候选入口把带 `recordPayloadId` 的 stack 从消耗型 tangible inputs 中排除；同一集合同时供普通 combine、exert 与 expose 使用，所以不再为三类动作生成这类 option。record write、attend、transfer 与项目 publication 有自己的显式入口，不依赖该集合。定向回归要求记录载体不出现在 direct option 或 grounded conversation follow-up 中，空白同材质载体仍可生成试验；executor 的保护继续作为提交边界兜底。30 年矩阵要求 payload 相关普通候选 / blocked action / completed consumption 全为 0，载体唯一且公开链保持。

**v9d 结果与决定。** 接受，作为 v10 的冻结基线。定向回归证明带 payload 的载体不会进入普通 combine、exert、expose 或 grounded conversation follow-up，空白同材质载体仍可形成合法试验，执行器的最终守恒保护继续生效。30 年矩阵为 `review10-v9d-record-carrier-options-20260820.json`，与 v9c 的配对为 `compare-review10-v9d-30y.txt`。唯一自然记录仍由李白在第 240 月 tick 1 写入、tick 2 于固定 site 精确投放，发布延迟为 0 月、发布前项目移动为 0；第 281 月被非作者拾取后，终态仍由一名存活人物的一份同 lineage stack 唯一持有，数量为 1，lost / duplicate / dangling 均为 0。v9c 中第 282–332 月的 8 次普通加工候选全部消失：payload 相关 selected candidate、blocked ordinary action 与 completed combine / exert / expose 均为 0。四个 durable 项目仍是 1 完成、3 阻塞；所有完成项目都具有严格 write→placement 证据，private / wrong-site / death-drop / unbound 伪完成、局部重复、项目 / 意图 / 物流引用异常及孤立中断都为 0。只有自然成功种子的第 281 月后轨迹发生分化，人口、项目完成和移动有所上升；这些不是本机制验收证据。自然阅读仍为 0，说明下一个最早断点已经从“发布与守恒”推进到“读者如何发现并使用公共载体”，不构成本版回归。

### v10：公共记录由读者本人取得、阅读并实验

**预登记假设。** 当前 record-use 候选由记录持有者遍历可见人物，并读取对方的私有 active intent、knowledge 与 inventory 决定是否分享；它既违反认知边界，也完全不扫描 v9 的公共地面载体。若把读者设为唯一认知主体，只从本人背包和本人可见公共 drop 形成候选，并在同一稳定 basis 中重编译取得、阅读与真实实验，则 v9 已证明可达的 payload 才可能成为知识链输入。

**最小修改。** 新候选只生成 v2 `RecordUseBasis`，冻结 reader、project、payload、technique 与物理来源；来源仅为本人背包或可见 ground，本版不扩公共容器。删除遍历他人背包、知识和 active intent 的 share 分支。地面来源按精确 drop ID / cell / z 依次编译 move、ground→self transfer、attend read、基于本人当前项目与真实材料的 act experiment；来源消失不得偷偷切换同 payload 的另一个 drop。旧 v1 basis 只保留恢复兼容。直接技术教学仍一次达到可靠 60，且不恢复旧 demonstration / imitation 链。

**定向验收。** 公共 ground carrier 先移动 / 精确取得，再在本人 inventory 中 attend；阅读后置信度仍不超过 54，真实实验恰好增加 18 并推进项目。导航 move 不计取得；本人已有 carrier 时跳过取得。他人即使可见且私有持有相同 record、codebook、项目或材料也不能为 reader 生成候选；不可见 drop、原来源消失、缺 codebook / 输入、已可靠掌握均不能越权。v1 intent 可恢复；direct-teaching 回归保持 60 且无 demo / imitation。

**矩阵门槛。** 同种子 10 / 30 年与 v9 配对；若公共记录自然出现，完整链必须满足 `acquire < read < experiment <= project progress`，来源、读者、payload 与 basis 全匹配，private-source 与 source-switch 违规为 0。本人背包来源从 read 开始。由于 v9 只有一项自然发布，零完整链仍可能是稀有性结果；定向回归是机制主证据，矩阵必须明确分母并继续检查人口、项目、移动、局部重复、引用与孤立意图。

**第一次候选（v10a）决定。** 在矩阵完成前拒绝并修订。核心 acquire→read→experiment 定向夹具已经通过，但独立代码审查发现 record-use option 仍进入通用 `followUpOptions`；当 grounded conversation 与它共享项目来源时，对话可把记录使用吸收成普通 follow-up，随后 `startIntent` 会放弃父项目，而不是创建带 `returnToIntentId` 的 record-use 子中断。观察器也会把理解失败、阅读置信度超过 54、错误产物或非 +18 的实验误计进完整链，并可能把旧 v1 复合 intent 的普通 conversation opening 当作记录行动。矩阵在种子 `185` 的第 348 / 360 月被主动停止；拒绝前缀 `review10-v10-public-record-reader-20260820` 只保留 SQLite 中这一份未完成 run，没有生成 JSON，且不再复用。v10b 从通用 follow-up 池排除 record-use、保留其主选项中断路由，并让完整链只接纳通过共同身份 / 项目 / payload / codebook 与阶段守卫的事实；旧 v1 fallback 只识别语义匹配的 transfer / attend / act。新增反例必须先通过，再以新前缀复验。

**第二次候选（v10b）决定。** 拒绝并修订。三颗种子都跑满 30 年，矩阵为 `review10-v10b-public-record-reader-20260820.json`，与 v9d 配对为 `compare-review10-v10b-30y.txt`；自然记录使用分母仍为 0，share / acquire / read / experiment / project progress / complete chain 全为 0，因此这次矩阵不能证明新机制。更重要的是，种子 `185` 在全程没有 record 的情况下从第 45 月 tick 2 开始确定性分叉，移动增加 3536 次、占比增加 17.44 个百分点。根因是 v10 为扫描公共 drop，把 `checkRecordUseOpportunity` 从“持有记录载体”放宽成“任何非 record-use 的 active project”，并用这个粗标志绕过 `alreadyReviewed`；同 tick 新协议使 `fullReview=true` 时，真实 record preview 甚至不会执行，于是无记录人物也会被重复全量重评、放弃刚恢复的父项目。重投影报告的 10 次 same-project replacement 实为 2 个唯一 parent→replacement transition，仍是硬回归。候选轨迹还暴露了一项潜伏通用缺陷：新建的 copper-smelting 项目没有自己的 action，却因 owner 背包里 24 个月前由 food-preparation 偶然产出的铜而立即完成，并把旧项目事件写入 completion evidence。v10c 先让 `alreadyReviewed` 只由真实 preview 确认的记录机会绕过；同时把便携产物完成证据限定为“当前目标材料栈来源与本项目 actionEventIds 的交集”，不禁止可靠技术跨项目复用。两项都是拒绝矩阵揭示的硬不变量修复，后续宏观差异不作单一机制归因。

**v10c 预登记。** 调度器先做本人背包 / 当前可见公共地面 written carrier 的廉价预检，再惰性缓存完整 record-use preview；只有 preview 真正产生合法候选时，才允许绕过本月已经复核过的门禁。同月新产生且明确点名本人的 request / offer 事实进入规划 overlay，但是否唤醒人物仍以真实 required option 为准，required response 必须压过 record-use 与 life review。便携产物的满足谓词与 completion evidence 共用项目来源交集，旧项目产物不能让新项目即时完成。定向回归必须同时证明：无载体时同月 proposal 不触发第二次普通复核；真实公共载体仍能唤醒 record-use；proposal-only 与 proposal+record 时都先处理必须回应；旧铜与旧事实不能完成新冶炼项目，新项目事实写入后才能完成且 completion evidence 只含新事实。

**v10c 结果与决定。** 接受调度、便携产物来源与 reader-owned record-use 的确定性机制；公共记录的自然使用率仍记为 `INCONCLUSIVE`，不宣称生态闭环已经发生。30 年候选矩阵为 `review10-v10c-public-record-reader-20260820.json`，与 v9d 的配对为 `compare-review10-v10c-30y.txt`，三颗种子都完成 360 月。历史中 535 个唯一当月 offer 产生 576 次当月 accept / reject，required 决策前插入 life-review 或 record-use 为 0；无记录样本的同月重复 life-review、重复 basis 与唯一 parent→same-project replacement 都为 0。39 个便携产物完成项目的 39 条 completion ref 全部属于各自 `actionEventIds`，且不早于项目创建；v10b 的第 327 月案例现在由新项目同月真实 expose 动作完成，旧产物即时完成数为 0。局部重复、项目 / 意图 / 物流引用与孤立中断异常均为 0。种子 `185` 自然形成 3 条合法 durable write→exact-site placement，三个 payload 到终态都各有一份、数量 1，lost / duplicate / dangling / ordinary consumption 为 0；但三种子的 acquire / read / experiment / project progress / complete record-use chain 仍全为 0，所以 record-use 的接受依据是包含公共地面链、私有状态负例、固定来源、置信度上界与真实实验的定向回归，而不是自然矩阵。最终人口配对差异为 +2 / +10 / -8，儿童暴露死亡为 +2 / -2 / +1，移动为 +4587 / +704 / -1044，项目完成为 +13 / +6 / +4；方向显著分化，且本候选同时包含同月 required response 和便携产物来源两项硬修复，不能把宏观变化归因于记录使用。

### 十版之后

第 10 版完成后再根据真实历史选择下一断点，不预先把 demonstration / imitation、公共容器、跨代 steward 或物流候选新鲜度写成既成答案。历史已证明直接教学与旧示范链存在产品语义冲突；任何恢复都必须作为独立假设，不能混入 record-use。

## 端到端与整体审查发现

已确认的高优先级问题：

- 玩家向人物提问时会错误继承人物间的待处理结伴提议，并生成“接受织女提议”的玩家选项；
- 触摸端没有把 pinch 纳入宇宙进入 / 人间退出的连续缩放协议；
- step patch 失配后的全量回源可能丢弃服务端权威历史；
- 天空采样在请求成功前提交本地游标，失败会永久跳过一个采样区间；
- fetch 缺少超时 / 取消，挂起请求可能锁住自动推进；
- 新文明在后端确认前清空当前 UI；
- Canvas 缺少完整键盘入口、对话框焦点约束和 WebGL 降级；
- 宇宙场景在隐藏后仍维持动画循环，主包约 1.12 MB，移动端后处理成本偏高；
- 客户端提交天空 / 命运 / 宇宙快照，而服务端仅校验形状与时间，权威边界需要收紧。

这些问题分为“本轮直接修复”“演进机制候选”和“后续产品优化”三类；不会把 UI 指标或视觉装饰写回文明规则。

## 本轮直接修复

- **玩家对话上下文隔离。** 服务端先保守判断本轮是否明确请求行动；纯问句不再暴露人物之间的 required response 或 legal choice，解析器也会拒绝在非行动轮次提交 accept / decline / choice。明确说“我建议你接受……”仍可进入合法选择，不是关闭主动建议。
- **连续触摸缩放。** 宇宙双指张开可聚焦并进入人间，人间双指收拢可返回宇宙；反向移动会抵消累计量，一次手势只触发一次，cancel、三指与点击抑制都有确定性状态机。wheel、双击与键盘替代路径继续保留。
- **权威历史恢复。** step patch 基线失配时，客户端应用后端回源的完整 frame 与 authoritative history；即使月份未前进，也会精确替换遗漏的本地历史。
- **天空采样事务。** 天空区间改为 prepare / commit / rollback；begin 或 step 失败不会提前推进游标，请求期间的新观测会按成功或失败路径进入正确的下一段。
- **请求超时、取消与幂等步进。** 所有 JSON GET / POST 统一使用 30 秒默认超时并支持外部 signal。`/step` 额外使用稳定 `stepId`、不透明会话 `authorityRevision` 与文明 / 分支 / 月份坐标做 CAS：同一权威月份的并发请求等待同一个 promise，旧请求和完成收据只读回权威 head，不再推进。begin、restore / load、seek 分叉都会换 revision，恢复历史时也不会复活持久化旧 ID；带 `stepId` 的调用必须提交完整身份。客户端在 begin / load / seek / end 时递增 per-run authority epoch，延迟的旧 full response 或 patch fallback 不能覆盖新权威缓存；天空样本只有在服务端精确确认 `expectedMonth + 1` 与同一 sample 时才提交。
- **文明规则不变量。** 十版依次修复协议中断恢复、生命周期月份、协议当月语义、失败 basis、材料请求续期、项目终态顺序、局部项目去重、能力证据分层、记录公开与载体守恒、读者侧记录使用；拒绝候选及其 SQLite / JSON 历史全部保留。
- **最终回归收口。** v9 为避免 durable inquiry 按 site 误合并时，曾把 site overlap 过度收窄为 construction；最终定向套件重新暴露了同址 fixed-site production 的提交竞态。现仅在项目 site 当前可见且 `cellId / z` 精确相同时合并 production，远方 remembered site 不参与，durable inquiry 仍按知识目标隔离。

## 后续优化建议

按风险与收益排序：

1. **收紧前后端权威边界。** 当前客户端仍提交 sky / fate / cosmos 快照，服务端主要校验结构和时间相等；应让服务端从权威输入重算，或至少验证输入来源、连续性和哈希，避免前端成为第二套演进来源。
2. **让“新文明”切换成为事务。** 后端确认创建成功前保留当前场景与历史；失败时原地恢复并显示情境化错误，避免先清空 UI 再失败。
3. **补齐可访问性和降级路径。** Canvas 需要可聚焦的键盘入口、对话框 focus trap / 返回焦点、`prefers-reduced-motion`、WebGL 不可用时的清晰替代画面；这些不改变世界规则。
4. **降低常驻渲染成本。** 宇宙场景隐藏时暂停 RAF；按设备动态限制 DPR / GTAO / 后处理；拆分约 1.12 MB 的主包并延迟加载人间体素、对话与模型设置代码。
5. **收敛规则规划性能。** v4 使被摘要误杀的合法候选恢复，也把主模拟单测从约 11 秒推高到约 26–35 秒；下一步应把候选合法性与昂贵寻路估价拆成惰性阶段，并用 profiler 证明热点后再改，不能重新引入摘要误杀。
6. **继续从最早知识断点演进。** v9 已让公共载体真实出现并保持；v10 的自然完整链仍可能是稀有事件。若三种子矩阵没有自然分母，下一轮应先研究“潜在读者为何没有形成项目缺口或接近记录”，而不是直接加记录吸引权重、全局广播或读取他人私有状态。
7. **产品细节。** 音乐静音 / 预加载状态需要更易发现；更新 Three.js 阴影 API 以消除 `PCFSoftShadowMap` 弃用警告；这些均属表现层，不应写回模拟事实。

## 验证与产物

- 定向回归覆盖玩家对话、前端会话恢复与幂等步进、25 月回放 / seek / fork、pinch、意图中断、年龄边界、协议生殖、失败 basis、材料请求续期、owner 丧失前完成、局部项目因果、记录发布和读者侧 record-use，均通过。
- `npm run test:simulation` 通过：schema 17、9 人、4417 条事实、22 个里程碑，20 / 20 普通上下文与 5 个豁免上下文通过。
- `npm run backend:build` 与 `npm run build` 通过；前端只保留已登记的主 chunk 大于 500 kB 警告，当前 minified JS 约 1.13 MB、gzip 约 325 kB。
- 最终浏览器烟测从 SQLite 恢复第 13 号文明到第 14 年 9 月，权威历史继续推进到第 14 年 10 月；观测菜单可打开、显示文明 / 年月并关闭。最终 `/step` 协议经独立并发复核后无剩余 P0 / P1。
- Knowledge Base 已运行 `npm run sync:docs`，同步 5 份核心文档；`rules-page.js` 语法与仓库 `git diff --check` 通过。
- 冻结基线：`three-body/data/experiments/review10-baseline-7a50b51-20260820.json`。
- 最终第十版：`three-body/data/experiments/review10-v10c-public-record-reader-20260820.json`；配对：`three-body/data/experiments/compare-review10-v10c-30y.txt`。
- v10c 长程矩阵在最终“可见且精确同址 production 提交去重”补丁之前冻结；旁车中 `localDuplicateStarts=0`，没有自然命中该回归分支，因此没有为这一处恢复既有 v7 不变量的窄修复重跑 3×30 年。当前代码由专门的同 tick 提交回归、远距负例与 durable 不误合并回归共同验收。
