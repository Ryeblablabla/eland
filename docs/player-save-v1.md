# 玩家存档 v1

状态：当前本地版已实现。本协议先保证“从最近一个已提交月份继续玩”，不将实验运行目录直接暴露给玩家。

## 产品行为

- 观测菜单中的“文明档案”可创建具名存档、查看本地存档并读取。
- 每次保存创建一个不可变存档；当前版本不覆盖、重命名或删除存档。
- 打开页面时先尝试恢复同一标签页的实时会话；只在后端确认该会话不存在时才建立新文明。
- 离开页面只写检查点，不再删除实时会话。内存会话超时时先落盘，再从内存逐出。
- 新文明编号由后端全局序列统一发放。首次进入、主动建立新世界和文明毁灭后的继任文明都会领取下一个编号；刷新、实时恢复、读档和时间分支不会领取新编号。
- 读取旧文明只恢复它原有的历史编号，不会降低全局编号高水位；此后再建立文明仍从历史已发放的最大编号继续。

## 一致性边界

存档对齐到最近一个已提交的月份。一个可读取存档必须同时满足：

```text
SimulationState.civilization.number = GameFrame.civilizationId
SimulationState.branchId = activeBranchId = GameFrame.branchId
SimulationState.clock.elapsedMonths = GameFrame.elapsedMonths = active branch head
GameFrame.universeTime = SkySample.toTime = CosmosSnapshot.t
```

`CosmosSnapshot` 保存三体系统的 16 维位置/速度、质量、宇宙时刻、文明计数、灾变状态和宇宙专用随机状态。轨迹线等纯装饰数据不入档。行星重生使用可序列化随机状态，因此读档后的下一次文明更替不会因 `Math.random()` 分叉。

前端读档时用存档历史替换当前历史，不追加另一个文明的事件。每条界面历史同时携带文明号和分支 ID。

## 本地存储

`three-body/data/eland.sqlite3` 是唯一存储；`THREEBODY_DATA_DIR` 只改变数据库父目录。完整物理协议与备份恢复见[SQLite 持久化](./sqlite-persistence-v1.md)。玩家相关状态由三组表承担：

- `manual_saves` 保存不可变档案的元数据和快照引用；
- `live_sessions` 保存热重启恢复所需的活动分支、最近帧与最近持久化时间；表内没有独立 `expires_at`，恢复扫描用 `saved_at + ELAND_SESSION_RECOVERY_TTL_MS` 判断是否仍可恢复；
- `campaign_state` 保存全局文明编号高水位，只增不减。

三者都引用共享 `chunks` 表。会话使用 `eland-session-manifest-v2`、`eland-session-shell-v2` 与 `eland-session-timeline-chunk-v1`：manifest 指向一次 Brotli 压缩的 V8 shell 和已经压缩的月度 checkpoint / delta 块；相同内容按 hash 去重，写入和索引更新在短事务中完成。手动存档不受实时会话 TTL 清理影响。长程实验位于同库的 `runs`、`run_checkpoints` 与 `artifacts`，不会进入玩家档案列表，也不消耗玩家文明编号。

HTTP 入口为：

- `GET /api/eland/saves?runId=<id>`
- `POST /api/eland/save`
- `POST /api/eland/load`
- `POST /api/eland/checkpoint`

## 当前限制

- 会话 manifest / shell / timeline chunk 是当前引擎的内部恢复格式，不是跨版本、跨设备的交换协议。当前权威状态只接受 schema 17。
- 存档包含当前会话内的分支时间线，但界面暂不提供在非活动分支之间切换。
- 未提交到月度主链的短暂宇宙漂移不入档；读档回到最近一个已提交月边界。
- 存档覆盖/删除、跨文明 campaign 归档和长期 schema 迁移属于后续协议。实验矩阵 JSON 仅用于离线交换，不是玩家存档格式。
