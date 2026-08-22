# SQLite 持久化

状态：当前实现。自 2026-08-20 起，`three-body/data/eland.sqlite3` 是 ELAND 后端唯一持久化事实源；`THREEBODY_DATA_DIR` 只改变数据库父目录，文件名固定为 `eland.sqlite3`。

## 边界

长程运行、检查点、报告与叙事旁车、玩家手动存档、实时会话、文明编号高水位都写入同一数据库。运行时不扫描旧 JSON 运行目录、不读取独立存档或会话文件，也没有文件或混合存储回退。HTTP JSON 是传输协议，`three-body/data/experiments/` 中的矩阵 JSON 是离线交换与分析产物；两者都不是持久化事实源。

SQLite 使用 `user_version=2`、WAL、`foreign_keys=ON`、`synchronous=NORMAL`、5 秒 busy timeout 和 STRICT 表。

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

## 编码与事务

长程状态使用增量历史 codec，artifact 继续使用 `v8-br-v1`。一个当前状态由四类内容块组成：

- `eland-run-state-root-v1` 保存 shell hash、历史 head、lineage、事件数与末事件摘要；当前根元数据为 schema v2，末事件摘要使用递归键排序的规范 JSON 和独立 domain 计算，不能依赖 V8 私有序列化字节；
- `eland-run-state-shell-v1` 保存不含 `world.past` 的当前状态；
- `eland-run-history-node-v1` 只连接上一个 head 与本批新增事件段；
- `eland-run-state-events-v1` 每段最多保存 2048 条不可变事件。

正常年度检查点只编码新增事件和新的 shell/root，不再把完整 `world.past` 重复压缩。append 会校验旧事件数量、lineage 与边界事件摘要；截断或改写历史必须显式选择 replace，并生成新的随机 lineage。写入在事务外编码，提交时再用 run 的 `revision + state_hash` 做 CAS；陈旧并发写会失败，不能把两个旧 head 静默串成一条历史。旧根 schema v1 的事件段仍逐块校验 codec、长度、SHA-256、lineage 和累计事件数，但不再用跨进程不稳定的旧 V8 末事件摘要拒绝读取；下一次保存走 replace，升级为 schema v2 稳定摘要。更早的 `v8-br-v1` run 也仍可读取，第一次保存时升级为新根，不修改其既有 checkpoint 证据。

手动存档与实时会话使用三类内容寻址 codec：

- `eland-session-manifest-v2` 指向 shell 和有序时间线块；
- `eland-session-shell-v2` 保存一次 V8 serialize + Brotli 的会话 shell；
- `eland-session-timeline-chunk-v1` 原样保存已经压缩的月度 checkpoint / delta，避免嵌套压缩。

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

迁移前文件位于本机 `three-body/data/archive/pre-sqlite-cutover-20260820/`，并由 gitignore 排除。它只是切换时的本机恢复点，不是第二事实源，运行时不会扫描或读取；不得以它为由恢复文件存储代码。历史实验报告中的 `three-body/data/runs/`、`state.json` 等路径仍表示当时真实产物，不代表当前协议。
