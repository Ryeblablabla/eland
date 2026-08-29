# SQLite 持久化

状态：当前实现。自 2026-08-20 起，`three-body/data/eland.sqlite3` 是 ELAND 后端唯一持久化事实源；`THREEBODY_DATA_DIR` 只改变数据库父目录，文件名固定为 `eland.sqlite3`。

## 边界

长程运行、检查点、报告与叙事旁车、玩家手动存档、实时会话、文明编号高水位都写入同一数据库。运行时不扫描旧 JSON 运行目录、不读取独立存档或会话文件，也没有文件或混合存储回退。HTTP JSON 是传输协议，`three-body/data/experiments/` 中的矩阵 JSON 是离线交换与分析产物；两者都不是持久化事实源。

SQLite 当前完整运行 schema 使用 `user_version=3`、WAL、`foreign_keys=ON`、`synchronous=NORMAL`、5 秒 busy timeout 和 STRICT 表。两个 store 共用版本号：`SqliteElandStore` 只拥有 v2 基础表且不会先宣称 v3；`SqliteRunStore` 在 `BEGIN IMMEDIATE` 内完整创建 v3 run continuation schema 后才升版本，已是 v3 时 ElandStore 不会降级。

## 表与引用

| 表 | 内容 |
| --- | --- |
| `chunks` | SHA-256 内容寻址的 codec、codec 定义的校验长度 `raw_size` 和 BLOB；供其他表共享 |
| `runs` | 每个长程运行的当前状态 hash、摘要和 revision |
| `run_checkpoints` | 按 run、revision 和月份保存的状态 hash |
| `run_continuations` | 显式 bounded 演进路径的 exact checkpoint continuation manifest 行；绑定 root/history authority、热窗、冷事实租约与五类 sidecar bundle hash |
| `artifacts` | `evolution-path`、`evolution-report`、`narrative-enhancements` |
| `manual_saves` | 不可变玩家档案元数据及会话根 hash |
| `live_sessions` | 可恢复实时会话、租约、最近活动时间及会话根 hash |
| `campaign_state` | `civilization-high-water-mark`，只增不减 |

run 删除时其 checkpoint 与 artifact 由外键级联删除；内容块不携带领域含义，只有引用它的行决定用途。

HTTP、长程演进与非权威叙事增强分别依赖 `RunAccessStore`、`EvolutionExecutionStore` 与 `NarrativeEnhancementStore` 端口；只有 `server/main.ts` 组装具体 SQLite store 与 Worker launcher。`SqliteRunStore` 继续拥有 run 根、checkpoint、continuation、CAS 事务与 rollback seam；普通 bounded 月和 observer-boundary 月的高层 staging / publication 分别由 `SqliteBoundedNonProjectionPublication` 与 `SqliteBoundedObserverBoundaryPublication` 编排。两者只共享数据库无关的 publication contract，通过窄 host port 请求主 store 完成原子提交，不直接持有 SQLite 或彼此。三类输出 artifact 的 prepared statements、codec 委托和孤块回收另由同数据库上的 `SqliteRunOutputArtifactStore` 组件承接；主 store 的既有公开方法保持为薄委托。

## 编码与事务

长程状态使用增量历史 codec，artifact 继续使用 `v8-br-v1`。一个当前状态由以下内容块组成：

- `eland-run-state-root-v1` 保存 shell hash、历史 head、lineage、事件数与末事件摘要；当前写入根元数据为 schema v3，schema v2 仍可读。末事件摘要使用递归键排序的规范 JSON 和独立 domain 计算，不能依赖 V8 私有序列化字节；
- `eland-run-state-shell-manifest-v1` 与 `eland-run-state-shell-part-v1` 分段保存不含 `world.past` 的当前状态；旧 `eland-run-state-shell-v1` 仍用于兼容读取；
- `eland-run-history-node-v1` 只连接上一个 head 与本批新增事件段；
- `eland-run-state-events-v1` 每段最多保存 2048 条不可变事件。

正常年度检查点只编码新增事件和新的 shell/root，不再把完整 `world.past` 重复压缩。append 会校验旧事件数量、lineage 与边界事件摘要；截断或改写历史必须显式选择 replace，并生成新的随机 lineage。写入在事务外编码，提交时再用 run 的 `revision + state_hash` 做 CAS；陈旧并发写会失败，不能把两个旧 head 静默串成一条历史。旧根 schema v1 的事件段仍逐块校验 codec、长度、SHA-256、lineage 和累计事件数，但不再用跨进程不稳定的旧 V8 末事件摘要拒绝读取；下一次保存走 replace，升级到稳定摘要与分段 shell 的当前 schema v3。schema v2 与更早的 `v8-br-v1` run 也仍可读取，第一次保存时升级为新根，不修改其既有 checkpoint 证据。

run codec 现在另提供与 shell 无关的历史 cursor、schema 2/3 逐 segment 流式校验以及 `cursor + suffix` 编码。在同一 shell、旧 root 和新后缀下，它们与原完整数组 append 产生相同的 segment、node、root 字节和 hash；流式访问者必须先暂存或幂等处理，只在整条 Promise 成功后才能提交外部副作用。这些原语是有界热历史的基础；当前长程 Worker 尚未切换到 hot/pinned 状态，仍不应声称其内存已与总历史解耦。

codec 还有 exact-successor stream：它同步拥有 previous/next schema 2/3 root，再从 next history head 沿内容寻址 parent 链精确走到 previous head 与绝对 eventCount，只按权威正序交付新增 segment；相同 lineage/count/tail 但不同 head、跨过 previous 边界、引用替换、不同 root 的零事件改壳都会失败。每段事件在 visitor 前递归冻结，suffix node 和 segment-reference 分别有 4096/16384 的相邻 checkpoint 硬上限，超过即拒绝而非截断。该原语只证明“next 相对传入 previous 的历史继承”，不证明 previous 本身来自权威数据库；它只能放在持有 CAS/brand previous root 的封闭 wrapper 内，visitor 也只能写私有 staging，完整 resolve 后才能 swap。

领域状态另有观察器中立的 `world.historyCursor`，保存已提交历史的绝对 `eventCount`、内存热窗起点 `hotStartIndex` 与末事件 ID。新世界和受信任的完整旧状态收养可以初始化该 cursor；正常读取、月提交、注入事实与文明结算都必须先验证 cursor，再通过统一追加边界提交，不能把规划期临时 overlay 误认证成正式历史。该字段不进入人物决策、文明指数、时代门槛或化身执行 hash。当前持久化全量解码仍要求 `hotStartIndex = 0`，所以这里只完成了切换边界，没有启用热窗截断。

codec 另有尚未接入公共 `load` 或长程 Worker 的 bounded restore seam。它只接受带稳定末事件摘要的 schema 2/3 根，从 history head 逆向验证到 genesis，以累计事件数严格递减排除断链或循环；任一时刻只保留一个节点、一个事件 segment、指定的连续尾部热窗和按绝对 ordinal 选择的冷事实 pin。完整 root 校验成功前不返回部分状态；重复事件 ID 不合并，`lastStep` 遇到无法唯一确定的完全相同重复事实时保留 shell 副本而不猜对象身份。该 seam 解决的是恢复器的事件体峰值，不代表领域证据、checkpoint 累计或 suffix CAS 保存已经适配热窗，因此仍不能用于真实长程演算。

服务端还有尚未持久化的 retention shadow projection。它必须绑定确切的 state root hash，并从最终 shell 收集可靠活人机械知识、存活 owner 的活跃机械安装/维修项目、当前故障、最近三次负载来源、预留库存来源和每个活人的最近三条真实 Mill 劳动，再按绝对 ordinal 连续折叠已校验的冷账本。机械观察知识的来源在人物知识规则中至多 24 条，projection 全部保留，避免“较新的无效来源”挤掉较旧但语义有效的观察；通用需求格式仍区分 `all / any / audit-only`。输出 pin 只有 ordinal、事件 ID 与租约，不复制事件体；结果还带可由当前 shell 重算的 demand fingerprint 与 living-person set。观察器摘要累计 rule/model 决策与机械 P0，并只保留一对“明确教学后受教者真实独立负载”的 witness。projection 现在能把 recent-3、未闭合教学、存活人物见证、direct/selective/reproduction 需求和累计摘要封成带 hash 的 continuation basis；下一检查点验证旧 authority、绝对 seal、需求 payload/fingerprint 与 basis hash 后只折叠 suffix。新增旧 direct source 若未被旧 closure 覆盖且 suffix 也未命中会失败关闭；新增 pending prediction、非出生新增人物和生殖 selector 改写仍要求从 genesis 重建。该模块位于 server，不写回 `SimulationState`，人物规划不能读取；basis 尚未进入 run root 的同事务 CAS，`continuationReady` 仍为 false，不能作为已完成的长期复杂度解法。

另有两个未接生产的 observer streaming foundation。derived projection 只为当前结构/项目引用和显式 retained/future closure 保存 last-write basis，10 万个无关唯一事件不会扩大该表；新增旧需求没有旧 basis 且 suffix 未覆盖时失败关闭。civilization projection 能累计部分因果锚点和 milestone definition coverage，但非单调 shell gate、撤回、完整 detector、development 稳定期与 exact-root CAS 尚未闭合。二者都明确 `continuationReady: false`，不可作为人物目标、奖励、能力门槛或真实长程 observer。固定月份 endpoint 将来可以延迟昂贵重物化，但仍需每月维护精确的小型 development/gate sidecar；milestone endpoint 在没有等价逐月 accumulator 时必须拒绝 deferred 模式。

`SqliteRunStore` 已有独立但未接入 Worker 的 `loadForEvolution` / `saveFromHistorySuffix`。前者只接受 schema 2/3 segmented root，交叉校验 run 行与 root 总事件数，返回不可变的 `runId + revision + stateHash + history cursor` basis；后者用 `basis.eventCount - hotStartIndex` 换算局部 suffix，拒绝 overlay、断档、已裁掉的未提交事实和同 ID 内容改写。编码前和 `BEGIN IMMEDIATE` 事务内都校验 basis，chunk、run 行、checkpoint 与 pruning 同事务提交，只有 COMMIT 后才产生新 basis。加载结果单独携带 cold pins，保存结果不伪造空 pins。现有公共 full `load/save/replace` 签名不变；bounded trusted adoption、checkpoint 绝对累计和 Worker 异常语义完成前仍不得改线。

服务端另有独立的 `eland-run-continuation-v1` 完整性 manifest codec。它显式声明 `bounded-hot-tail-plus-cold-pins-v1`，绑定 run/revision/state root、root schema、shell、history lineage/head/count/tail ID/tail content hash、hot limit、由其唯一决定的 hot start、完整 cold pin/lease 清单，以及 retention、physical、derived observer、civilization observer、checkpoint 五类内容哈希或规范 digest 引用。输入顺序会规范化，但重复 ordinal/lease、冷热越界、空历史边界矛盾、未知字段和任何硬上限溢出都拒绝；压缩块按 codec domain 内容寻址，解码后深冻结，私有字节不向调用方暴露。该 codec 只证明 manifest 内容完整，不能铸造数据库权限；SQLite exact-root/revision CAS、sidecar 同事务提交和一次性 store token 完成前，它仍不是 continuation authority。

v3 schema 已预留 `run_continuations` current-manifest 行：`(run_id, revision, state_hash)` 通过复合外键精确引用 checkpoint，shell/head/bundle 均引用内容块，空历史的 head/tail 三元组必须同时为空，完整 DDL 与版本提升在同一个 schema 事务内。当前还没有公共或 Worker 写入 API，普通 save 也不会伪造 continuation 行；因此“表存在”仍不表示任何 run 已具备 bounded continuation。下一步必须由同一 `SqliteRunStore` 实例验证 exact root 与 bundle 后铸造不可序列化的一次性 token，并在状态、checkpoint、bundle、sidecar 的同一提交中更新该行。

领域层现有进程内 retained-cold registry，但它不属于 `SimulationState`，也不写入 SQLite。服务端必须从当前 `EvolutionRunBasis.stateHash` 传入确切 authority，再把 retention projection 的 root binding、shell demand fingerprint、blocking group、ordinal、event ID 与 bounded decoder 返回的冷事实逐一对齐，之后才把带 lease 的事实装入稳定热数组对应的 `WeakMap`。`worldEventById` 的优先级是 planning overlay → hot tail → cold pin；通用完整历史 API 在 `hotStartIndex > 0` 时失败关闭。机械项目仅通过专用 `living-mill-labor:<person>:recent-3` lease 合并冷劳动与热尾，压力证据在 full/bounded 小型夹具中一致。

领域层另有未接生产的 committed hot-window trim 基础件。它要求 resident 数组与绝对 cursor 精确一致、拒绝任何已注册 planning overlay、原地移出超过上限的已提交前缀，并立即失效 hot-only event index，使被移出的未 pin 事件不再由旧缓存强引用；同一数组上的既有 verified cold lease 仍可解析。当前传入的 `eventCount + tailEventId` seal 只是夹具边界，不是不可伪造的持久化权限；生产 wrapper 还必须使用 store-minted token 绑定 run、revision、state hash、exact root/head/lineage/count/tail，并在同一事务成功后原子安装所有新转冷事实及 sidecar，再允许 trim。`lastStep` 与异常恢复同样尚未闭合，因此 Worker 不能直接调用该基础件。

物理结构已有 bounded v2 provenance。它不再保留每条建造事实引用，而是按有限的 `position + building material` 组合记录首次和最近绝对序号、最近来源 ID，并以 `appliedHistoryEventCount + appliedTailEventId` 封存。这样既保留“体素后来非建造地恢复旧材料时重新采用旧建造来源”的现有语义，也让月末只折叠刚提交的 suffix；结构连通、住所几何和施工连接仍以当前 grid 现场重算。增量 suffix 的每个对象必须与 committed ledger 的对应绝对序号同一，不能只凭长度或重复 ID。旧 cache 或缺失 cache 的 bounded state 会失败关闭；从冷账本升级必须经 exact schema 2/3 root chunk 内部执行 verified segment stream，且在折叠前验证持久化网格仍是 canonical `84×52×12`，避免 hydrate 掩盖被伪造尺寸裁掉的 provenance；完整校验 resolve 后才能安装。planning overlay 只产生临时 preview，不写回 committed cache。`placeable` 建筑可以作为施工连接，但仍不冒充住所结构。

`checkpointFor` 与 path turning point 已改用绝对 history cursor：`eventCount` 不再取 resident array 长度，上一 checkpoint 的绝对序号先减 `hotStartIndex` 才成为本地下标；前缀已裁出且没有连续累计时直接报错，不从热窗零点重算。年度文明 observer 的完整有界累计仍未实现，因此 `hotStartIndex > 0` 的 `full / development-only` projection 会在生成任何 partial derived 前失败关闭；terminal facts report 同样拒绝 bounded hot tail，不能把局部历史静默解释成累计报告。另有未接控制器的封闭式 `adoptBoundedSimulationState(rootChunk, readChunk, options)`：入口先复制并冻结 exact schema 2/3 root chunk，随后只从同一 owned root 依次 bounded decode、verified retention stream、带 pins 的二次 decode 与 verified physical stream；外部不能注入 shell、projection 或中间状态。adoption hydrate grid 后强制从已验证 provenance 重算物理拓扑，不接受持久化 cache 作为回退，也不补字段或重跑观察投影。返回值仍是 `continuationReady: false` 的冻结 receipt，类型上不能冒充或泄露普通 `SimulationState`。累计 observer、其余直接全历史查询、retention/projection 的 CAS 持久化和 Worker 路由仍未完成。

### 显式 bounded 长程演进

上述 `continuationReady: false` 是各个独立 foundation / materializer 的类型边界，防止调用方把单个 sidecar 当成完整续跑权限；它不再表示 `SqliteRunStore` 的封闭组合路径不可用。当前 `bootstrapBoundedEvolutionContinuation` 可从既有完整根一次性建立 continuation，`openBoundedEvolutionContinuation` 只按 manifest 恢复连续热尾与精确冷 pins，随后由 `stage/publishBoundedNonProjectionMonth` 推进普通月、由 `stage/publishBoundedObserverBoundaryMonth` 推进 12 的倍数月。普通月与年度月都由 store 私有 token 绑定同一 root/revision generation；状态、checkpoint、continuation bundle、五类 sidecar 与 run CAS 在一次事务中发布，回滚不会消费 staging receipt。该路径当前用于 `scripts/run-bounded-modern-evolution.mjs` 的长程实验；普通 HTTP 长程 Worker 与公共 full `load/save` 仍保持原路径，二者不能混称。

年度边界先持久化只含新事实的私有 root A，再从 A 构建 observer-owned compact shell 并生成同一事实历史的 final root B；derived、civilization、physical、retention 与 checkpoint sidecar 都从原 source root 到各自 exact target 重算 successor，A-target sidecar 不会偷渡到 B。derived future closure 除当前结构与活跃耕作来源外，还保留尚未并入任何当前连通结构的有限 `constructionRecords`；若后续放置让旧构件首次成为住宅证据，successor 会从 exact previous root 流式封存该 ID 的最后写入或确切缺席，而不是因旧来源离开热窗失败。milestones endpoint 和无法等价累计的 terminal report 仍失败关闭。

retention sidecar 当前写入 `eland-history-retention-projection-json-brotli-v2`：规范内容最多 32 MiB，Brotli 后存储内容最多 8 MiB，并继续严格读取 legacy JSON v1。新生殖意图把绑定时 agreement 已有的 attempt ID 精确前缀保存为基线；续跑只要求基线之后由该 intent 生命周期产生的尝试，不能把同一 consent window 内前一意图的失败尝试冒充新意图证据。bounded publish 达到 256 个新格式 checkpoint 后批量裁剪至最新 128 个并回收不可达 run-state chunks，避免每年执行全库 GC。

实时会话 Worker 与长程演化 Worker 都需要持有当前权威状态。实时 Worker 改为第一次真实请求时才启动，old-space 默认 1536 MB、硬上限 2048 MB；异常退出后不在后台自动重启，由下一次请求按需重建。长程 Worker 在同一后端进程内全局串行，最多一个 active Worker，old-space 默认且硬上限为 2048 MB；两类上限分别可用 `ELAND_WORKER_OLD_SPACE_MB` 与 `ELAND_RUN_WORKER_OLD_SPACE_MB` 向下覆盖。上限不会预分配整块内存，也不包含 SQLite、原生 Buffer 等进程外堆占用。分段恢复会让跨 segment 重复出现的事件 ID 与生殖审计字符串共享同一份内存，`lastStep` 也只倒查末月事实，不再为完整历史建立一次性重连 Map。运行时事件索引不再为每条事实额外保存可由 `atMonth + orderInMonth` 重建的 ordinal Map；高频生殖决策中的家庭准备度来源也使用“完整来源数量 + 最多 32 个代表样本”的有界审计格式，SQLite 中的客观事件史和被引用事实仍完整保留。

手动存档与实时会话使用三类内容寻址 codec：

- `eland-session-manifest-v2` 指向 shell 和有序时间线块；
- `eland-session-shell-v2` 保存一次 V8 serialize + Brotli 的会话 shell；
- `eland-session-timeline-chunk-v1` 原样保存已经压缩的月度 checkpoint / delta，避免嵌套压缩。

自 2026-08-24 起，有限化身也直接复用这套 `live_sessions` 根、会话 shell 和内容块，没有新增化身表或独立 JSON 文件。`ElandSessionRecoverySnapshot` 的 `activeEmbodiment` 保存最后已提交月之上的待操作刻度、冻结月初决策、命令收据和暂存 hash；`completedEmbodiments` 以最多 64 条的有界 ring 保留第 15 刻与 release 完成收据，使相同 `commandId / releaseId + fingerprint` 在进程重启后仍不会重复提交。`live_sessions.elapsed_months` 和 timeline head 始终只表示最后完整月，不把半月状态写成可 seek 的 frame。

begin、每个成功 tick 和 release 都在 HTTP 成功响应前通过 `persistIfCurrent` 替换同一会话根。活动快照只保存完整命令之间的 `awaiting-command` 边界；恢复时从 committed state 重建月份，注入冻结决策，重放已完成命令并校验收据与规范暂存 hash。release 保留玩家已完成刻度，由本地规则完成剩余刻度与月末流程后才转入 completed receipt。当前冻结的 NPC 月初决策来自本地 `RulePlanner`，化身恢复不重发模型请求；观察模式的自然自由文本对话也不是该暂存命令日志的一部分。

会话块的 hash 同时包含 codec 和内容，防止相同字节在不同语义下错误复用。编码、压缩和 hash 计算在事务外完成；写入时以短 `BEGIN IMMEDIATE` 事务提交缺失块和引用行，失败则回滚。命中既有 hash 时仍比较 codec、长度和字节，不能只相信 hash。

实时恢复只校验并读取根 manifest 与 shell，把有序时间线保存为轻量 hash 引用，不在启动时把全部 checkpoint / delta BLOB 常驻内存。`frame`、人物历史和 `seek` 回放时才同步解析最近年度 checkpoint 与其后最多 11 个 delta；单个块在读取时校验 codec、长度和 SHA-256，会话只缓存一个最近重建状态，回到当前 head 后立即释放该缓存。新快照携带 active head 完整性标记；缺少标记的旧 schema 17 快照会用 `latestState` 一次性修复可能不完整的旧 head delta。成功持久化后，新产生的内存 Buffer 会原位替换成 hash 引用；后续保存直接复用旧引用，只为新增块计算 hash 和写库。实时分支每到 12 的倍数月份自动持久化，因此正常推进时未释放的新增时间线块保持在一个年度窗口内。

恢复路径把 shell 中的 `latestState` 直接移交给模拟控制器，会话与控制器在空闲时共享同一份已提交状态，不再各保留一份完整 clone。同步本地月份在该受控状态上原地推进；异步模型月份只对隔离工作副本写入新天象和月内变化，成功后才原子替换已提交状态。公开的 `getState` 与普通 `restore` 仍保持复制边界。

`raw_size` 不是跨 codec 统一的“解压前”或“解压后”业务数据大小。旧 `v8-br-v1` 用它保存 V8 序列化后、Brotli 压缩前的字节数，并在解压后校验；新的增量 run codec 与三类会话 codec 用它保存数据库 BLOB 的实际字节数，并与 `data.byteLength` 一起校验。解释该列必须先读取同一行的 `codec`，不能直接用它估算原始 `SimulationState` 大小。

## 自动回收

内容块按引用可达性自动回收：

- artifact upsert 在同一事务内更新引用，并删除已不再被 `runs`、`run_checkpoints` 或 `artifacts` 引用的旧 `v8-br-v1` 块；
- 新格式 run checkpoint 采用有界批量窗口：最多增长到 256 个，再一次裁剪到最新 128 个；只有发生这次批量裁剪时才从 `runs`、`run_checkpoints` 与 `artifacts` 根计算新 run codec 的可达图并回收孤儿块，避免 1000 年运行从第 129 年起每年全库扫描；legacy checkpoint 不参与该裁剪；
- 会话存储初始化以及 manual save、live session upsert / delete 后，从 `manual_saves` 与 `live_sessions` 的根 manifest 计算可达集，只回收 `eland-session-manifest-v2`、`eland-session-shell-v2`、`eland-session-timeline-chunk-v1` 三类不可达块；
- 同一块仍被其他 run、存档或会话引用时必须保留；两类回收器不会跨 codec 家族误删对方的数据。

删除块后形成的 freelist 页面由 SQLite 后续写入复用，数据库文件不会因此立即缩小。正常运行不要求 `VACUUM`；若未来确需离线压缩，应作为有备份、停服的独立维护操作处理。

## 备份与恢复

运行中的 WAL 数据库不能只复制主文件，否则可能漏掉尚在 `-wal` 中的提交。在线备份必须使用 SQLite backup API；离线备份应先正常停止后端，确认所有连接关闭，再复制数据库。备份文件应另存到不被服务直接打开的位置，并在登记时记录时间、文件大小和应用版本。

恢复步骤：

1. 停止后端，先把当前数据库及同名 `-wal`、`-shm` 一并移动到临时恢复目录，不直接删除。
2. 将已验证的数据库备份放到 `<THREEBODY_DATA_DIR>/eland.sqlite3`；不要把归档 JSON 目录接回运行时。
3. 启动前检查 `PRAGMA user_version`、`PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`；版本受支持、完整性为 `ok` 且外键结果为空后再启动服务。
4. 读取 runs、玩家档案和实时会话摘要做最小抽查；确认后再按保留策略处理临时恢复目录。

## 2026-08-20 切换审计

一次性迁移完成后的审计快照如下。数量会随正常使用增长，不是固定产品上限。

| 项目 | 迁移结果 |
| --- | ---: |
| runs | 780 |
| run checkpoints | 780 |
| artifacts | 1542（evolution path 779、evolution report 761、narrative enhancements 2） |
| manual saves | 4 |
| live sessions | 6 |
| civilization high-water | 3 |
| 数据库大小 | 855,842,816 bytes |
| `integrity_check` | `ok` |
| 外键违规 | 0 |
| `orphanChunks`（不可达内容块） | 0 |

迁移审计清单和报告保留在本机 `three-body/data/archive/pre-sqlite-cutover-20260820/`，并由 gitignore 排除；占用 7.1 GB 的旧文件存储已在确认 SQLite 切换完成后删除。该目录不是第二事实源，运行时不会扫描或读取；不得以它为由恢复文件存储代码。历史实验报告中的 `three-body/data/runs/`、`state.json` 等路径仍表示当时真实产物，不代表当前协议。
