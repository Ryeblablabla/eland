# SQLite 持久化

状态：当前实现。自 2026-08-20 起，`three-body/data/eland.sqlite3` 是 ELAND 后端唯一持久化事实源；`THREEBODY_DATA_DIR` 只改变数据库父目录，文件名固定为 `eland.sqlite3`。

## 边界

长程运行、检查点、报告与叙事旁车、玩家手动存档、实时会话、文明编号高水位都写入同一数据库。运行时不扫描旧 JSON 运行目录、不读取独立存档或会话文件，也没有文件或混合存储回退。HTTP JSON 是传输协议，`three-body/data/experiments/` 中的矩阵 JSON 是离线交换与分析产物；两者都不是持久化事实源。JSON 请求体默认上限 50 MiB；确需通过 `/api/runs/import` 迁移大型完整状态时，可把 `ELAND_MAX_HTTP_BODY_MIB` 显式设为 1..512 MiB，限额变化不改变导入后的 SQLite 权威性或事务边界。

SQLite 当前完整运行 schema 使用 `user_version=3`、WAL、`foreign_keys=ON`、`synchronous=NORMAL`、5 秒 busy timeout 和 STRICT 表。两个 store 共用版本号：`SqliteElandStore` 只拥有 v2 基础表且不会先宣称 v3；`SqliteRunStore` 在 `BEGIN IMMEDIATE` 内完整创建 v3 run、checkpoint 与 artifact schema 后才升版本，已是 v3 时 ElandStore 不会降级。

## 表与引用

| 表 | 内容 |
| --- | --- |
| `chunks` | SHA-256 内容寻址的 codec、codec 定义的校验长度 `raw_size` 和 BLOB；供其他表共享 |
| `runs` | 每个长程运行的当前状态 hash、摘要和 revision |
| `run_checkpoints` | 按 run、revision 和月份保存的状态 hash |
| `artifacts` | `evolution-path`、`evolution-report`、`narrative-enhancements` |
| `manual_saves` | 不可变玩家档案元数据及会话根 hash |
| `live_sessions` | 可恢复实时会话、租约、最近活动时间及会话根 hash |
| `campaign_state` | `civilization-high-water-mark`，只增不减 |

run 删除时其 checkpoint 与 artifact 由外键级联删除；内容块不携带领域含义，只有引用它的行决定用途。

HTTP、长程演进与非权威叙事增强分别依赖 `RunAccessStore`、`EvolutionExecutionStore` 与 `NarrativeEnhancementStore` 端口；只有 `server/main.ts` 组装具体 SQLite store 与 Worker launcher。`SqliteRunStore` 拥有 run 根、checkpoint、CAS 事务与 rollback seam；三类输出 artifact 的 prepared statements、codec 委托和孤块回收由同数据库上的 `SqliteRunOutputArtifactStore` 组件承接，主 store 的既有公开方法保持为薄委托。

## 编码与事务

长程状态使用增量历史 codec，artifact 继续使用 `v8-br-v1`。一个当前状态由以下内容块组成：

- `eland-run-state-root-v1` 保存 shell hash、历史 head、lineage、事件数与末事件摘要；当前写入根元数据为 schema v3，schema v2 仍可读。末事件摘要使用递归键排序的规范 JSON 和独立 domain 计算，不能依赖 V8 私有序列化字节；
- `eland-run-state-shell-manifest-v1` 与 `eland-run-state-shell-part-v1` 分段保存不含 `world.past` 的当前状态；旧 `eland-run-state-shell-v1` 仍用于兼容读取；
- `eland-run-history-node-v1` 只连接上一个 head 与本批新增事件段；
- `eland-run-state-events-v1` 每段最多保存 2048 条不可变事件。

正常年度检查点只编码新增事件和新的 shell/root，不再把完整 `world.past` 重复压缩。append 会校验旧事件数量、lineage 与边界事件摘要；截断或改写历史必须显式选择 replace，并生成新的随机 lineage。写入在事务外编码，提交时再用 run 的 `revision + state_hash` 做 CAS；陈旧并发写会失败，不能把两个旧 head 静默串成一条历史。旧根 schema v1 的事件段仍逐块校验 codec、长度、SHA-256、lineage 和累计事件数，但不再用跨进程不稳定的旧 V8 末事件摘要拒绝读取；下一次保存走 replace，升级到稳定摘要与分段 shell 的当前 schema v3。schema v2 与更早的 `v8-br-v1` run 也仍可读取，第一次保存时升级为新根，不修改其既有 checkpoint 证据。

run codec 还提供与 shell 无关的历史 cursor、schema 2/3 逐 segment 流式校验以及 `cursor + suffix` 编码。在同一 shell、旧 root 和新后缀下，它们与原完整数组 append 产生相同的 segment、node、root 字节和 hash；流式访问者必须先暂存或幂等处理，只在整条 Promise 成功后才能提交外部副作用。长程 Worker 恢复时仍完整水合状态与历史，内存不会与总历史解耦。

codec 还有 exact-successor stream：它同步拥有 previous/next schema 2/3 root，再从 next history head 沿内容寻址 parent 链精确走到 previous head 与绝对 eventCount，只按权威正序交付新增 segment；相同 lineage/count/tail 但不同 head、跨过 previous 边界、引用替换、不同 root 的零事件改壳都会失败。每段事件在 visitor 前递归冻结，suffix node 和 segment-reference 分别有 4096/16384 的相邻 checkpoint 硬上限，超过即拒绝而非截断。该原语只证明“next 相对传入 previous 的历史继承”，不证明 previous 本身来自权威数据库；它只能放在持有 CAS/brand previous root 的封闭 wrapper 内，visitor 也只能写私有 staging，完整 resolve 后才能 swap。

领域状态保留观察器中立的 `world.historyCursor`，记录已提交历史的绝对 `eventCount`、兼容字段 `hotStartIndex` 与末事件 ID。新世界和受信任的完整旧状态恢复可以初始化该 cursor；正常读取、月提交、注入事实与文明结算都必须先验证 cursor，再通过统一追加边界提交，不能把规划期临时 overlay 误认证成正式历史。该字段不进入人物决策、文明指数、时代门槛或化身执行 hash。当前 full-state 路径要求 `hotStartIndex = 0`。

实验性的 bounded continuation、热尾、冷事实 pin、retention sidecar 和双路径月份发布已经移除。新数据库不创建也不读写 `run_continuations`；从旧版本沿用的数据库可能仍保留该未使用表，但它不再承载当前运行权威，也不影响 full-state 根、checkpoint 与 artifact。

实时会话 Worker 与长程演化 Worker 都需要持有当前权威状态。实时 Worker 改为第一次真实请求时才启动，old-space 默认 1536 MB、硬上限 2048 MB；异常退出后不在后台自动重启，由下一次请求按需重建。长程 Worker 在同一后端进程内全局串行，最多一个 active Worker，old-space 默认且硬上限为 2048 MB；两类上限分别可用 `ELAND_WORKER_OLD_SPACE_MB` 与 `ELAND_RUN_WORKER_OLD_SPACE_MB` 向下覆盖。上限不会预分配整块内存，也不包含 SQLite、原生 Buffer 等进程外堆占用。分段恢复会让跨 segment 重复出现的事件 ID 与生殖审计字符串共享同一份内存，`lastStep` 也只倒查末月事实，不再为完整历史建立一次性重连 Map。运行时事件索引不再为每条事实额外保存可由 `atMonth + orderInMonth` 重建的 ordinal Map；高频生殖决策中的家庭准备度来源也使用“完整来源数量 + 最多 32 个代表样本”的有界审计格式，SQLite 中的客观事件史和被引用事实仍完整保留。

同一后端内的实验 `--concurrency` 只会排队等待这个全局长程 Worker，不构成多核并行；长请求还可能先于后台 Worker 完成而超时。需要并发多种子实验时，应为每个分片启动独立后端进程，使用不同端口与不同 `THREEBODY_DATA_DIR`。每个分片仍只有自己的 `eland.sqlite3` 事实源和 WAL，不共享或自动合并 run authority；结果通过运行导出与实验报告汇总。大型历史库会显著增加写入与检查点维护成本，实验分片也可避免让一次性矩阵继续放大主库。

普通 HTTP 长程 Worker 的失败发布也以最后一次已提交状态为准。Worker 在内存中推进到下一 checkpoint 之前可能已经改变 controller；若随后抛错，`persistLongEvolutionFailure` 必须重新从 `RunAccessStore` 载入当前 CAS head，再用该状态发布 `failed` evolution path，不能把未提交的部分月份保存成 run root、检查点或失败报告。恢复只从最后已提交月份继续；定向回归由 `scripts/test-long-evolution-failure-atomicity.mjs` 覆盖。

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
