# 信息时代长程基线冻结清单

- 前缀：`info-age-v0-current-20260820`
- 冻结时间：2026-08-20 11:58:06 +08:00
- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`
- Node.js：`v24.16.0`
- tracked worktree patch SHA-256（排除玩家向根 README）：`398fa0b5b12db96b17e776e89becad6d968c81f6f0b128f31f3c58f7cca4466a`
- 相关源码、脚本、文档内容清单 SHA-256：`b2a2f59203bd6eca5e1a3b6008d79aee069652fe28a9ff8a70dbaeb9f3c41721`
- `runtime/main.mjs`：`5f01abf2bede1c2470575d3cf79579c3f1476d23097274077e0aa2f50b1ef807`
- `runtime/eland-worker.mjs`：`1d45baa29bd76645ab2aed8fef4867fc8dd47cf59e97800cae03cbee98bce23c`
- `tools/run_matrix.mjs`：`2fc925b912d58a5d2922052b4bef6db497d7006b9178689fce3573ffe49da8e6`
- `tools/compare_matrices.mjs`：`92a80fa81fd40a54ae9b38338097c98b91e7c2f103a4ecf600a8c7828a983f11`

矩阵坐标固定为 3 个种子 `185,20260815,20260816`，5 个时长 `10,30,50,100,1000` 年，`repeats=1`、`civilizationNo=1`、`chaosIntensity=0`、`climateBias=balanced`。矩阵包含 15 个独立运行；1000 年坐标在全员死亡或 12,000 月边界结束。

权威运行状态保存在 `data/eland.sqlite3`。最终摘要写入相邻的 `info-age-v0-current-20260820.json`；本目录保存实际执行 bundle 与实验工具，避免后续源码构建污染基线解释。
