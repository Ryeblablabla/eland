# 信息时代长程 v1 冻结清单

- 前缀：`info-age-v1-hibernation-recovery-20260820`
- 冻结时间：2026-08-20 13:21:52 +08:00
- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`
- Node.js：`v24.16.0`
- `three-body/` tracked worktree patch SHA-256：`f542f5b9fd58af9c9a1e0d8fef95b623f6cd431496b8942294f059bef85db370`
- `runtime/main.mjs`：`d184da241786fee1bb0c1512d53cfdd534a32d9637819f01eb9cf1e482ca7980`
- `runtime/eland-worker.mjs`：`f0f9617bde56ffaccd6eb377023222cb5fa129db3576f3d13b09dca93a1a2d55`
- `tools/run_matrix.mjs`：`2fc925b912d58a5d2922052b4bef6db497d7006b9178689fce3573ffe49da8e6`
- `tools/compare_matrices.mjs`：`92a80fa81fd40a54ae9b38338097c98b91e7c2f103a4ecf600a8c7828a983f11`

矩阵坐标固定为 3 个种子 `185,20260815,20260816`，5 个时长 `10,30,50,100,1000` 年，`repeats=1`、`civilizationNo=1`、`chaosIntensity=0`、`climateBias=balanced`。每个坐标独立起跑；1000 年坐标在全员死亡或 12,000 月边界结束。

本候选只改变两阶段脱水休眠、来源化恢复、受抚养者恢复照护与同一 episode 的 intent / project 连续性。矩阵开始后只使用本目录对应的冻结 runtime，不再构建。
