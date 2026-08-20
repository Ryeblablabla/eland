# 信息时代长程 v1b 冻结清单

- 前缀：`info-age-v1b-hibernation-entry-consistency-20260820`
- 冻结时间：2026-08-20 14:44:48 +08:00
- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`
- Node.js：`v24.16.0`
- `three-body/` tracked worktree patch SHA-256：`f4ad1aef8163bfbc6bf27fcf44a8745da7f3c6a240cc1c923154355d99f78a29`
- `runtime/main.mjs`：`aa3d4ef437fdfc8a3ec2387e0f55cea121add40f427895c394bdc1693ec7f4ae`
- `runtime/eland-worker.mjs`：`7c5d6cd00206aaa7c6a8b1ba9af60bb73954ec5b423edf245eb23b2986cafeec`
- `tools/run_matrix.mjs`：`9555178dbdba78db13a4883b546215750cb0def5a9a1064df8b1dc498c16fcee`
- `tools/compare_matrices.mjs`：`92a80fa81fd40a54ae9b38338097c98b91e7c2f103a4ecf600a8c7828a983f11`
- `tools/audit-hibernation-recovery-chain.mjs`：`0b1063eeea88942ed079740c4a46de68c3cc3bee6f7927f660e97463470340c3`
- `tools/audit-information-age-chain.mjs`：`aaf807d24b95429bdef543cf6874d13fe4818a235e18db2c795ede2e2a86d0b5`
- `tools/sqlite-run-reader.mjs`：`40eade963531ac2acfd9755f8656753bfd56faae90b421274ad0c5e5338fec3f`

矩阵坐标固定为 3 个种子 `185,20260815,20260816`，5 个独立时长 `10,30,50,100,1000` 年，`repeats=1`、`civilizationNo=1`、`chaosIntensity=0`、`climateBias=balanced`。1000 年坐标在全员死亡或 12,000 月边界结束。

本候选只修正已感知严重冷热下的休眠准入一致性、同一进入动作的 planner/reflex 去重，以及休眠期间必要社会回应的 append-only 期限冻结；运行同时包含此前已接受的两阶段恢复、来源化照护、增量路径观察器和分段 SQLite 持久化。矩阵开始后只使用本目录冻结 runtime，不再构建。

最终历史没有保存未选候选集合，因此 `eligibleObservedSevereHazardWithoutDehydrateOption` 必须报告为 `unsupported`，不得将不可观测分母写成 0。
