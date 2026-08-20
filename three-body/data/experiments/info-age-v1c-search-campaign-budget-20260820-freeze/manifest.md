# 信息时代长程 v1c 冻结清单

- 前缀：`info-age-v1c-search-campaign-budget-20260820`
- 冻结时间：2026-08-20 15:57:48 +08:00
- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`
- Node.js：`v24.16.0`
- 基线 source map：v1b `runtime/main.mjs.map` `7a8d0cb8781eb6c86984adf4f9dff64eaaac838d22042bfb2f3de64490e745ae`
- 基线 worker source map：v1b `runtime/eland-worker.mjs.map` `5d61b06716d34f7232e2ef25eab94db6d6b17f98ffa73f1e73851d61ab409c50`
- 唯一行为补丁：`source/v1c-search-campaign-budget.patch` `a64e70ee8063094085eff46e1efdbe4a6b75f937d2c4d6b62d17332c5a59ec12`
- 补丁后 `project-options.ts`：`22f0503e05e76350053cdaa23f0f8a8cd1b692303af7073df325284db6b4d45d`
- 定向测试源：`three-body/scripts/test-project-logistics.mjs` `53331281aa4565509e853916a8fb2d49a9986f86c04e5da6c9da007ed7c99571`
- `runtime/main.mjs`：`0a228a716ecdf49e2e3da5c3b9e6581c4907a26b8e6e446044404f2191becd2f`
- `runtime/eland-worker.mjs`：`ecc13021f9f9fc1ffddf697ac1819f27725ebf2f1c6f6703a03c05341fb4e71b`
- `tools/run_matrix.mjs`：`8460a12e35b5d9157f749c45c869dcccb00b0b0c5a2bc291dca4106f8555f007`
- `tools/compare_matrices.mjs`：`92a80fa81fd40a54ae9b38338097c98b91e7c2f103a4ecf600a8c7828a983f11`
- `tools/audit-hibernation-recovery-chain.mjs`：`5d3379234b0f5da7090e110c462ea4de3706182cc83690b7a01e13a91ab8310a`
- `tools/audit-information-age-chain.mjs`：`aaf807d24b95429bdef543cf6874d13fe4818a235e18db2c795ede2e2a86d0b5`
- `tools/reproject-evolution-observer-metrics.mjs`：`f408556e49d5d3d0a545d553361c52c86c17613a2aa353986e07c0c5cac578f5`
- `tools/sqlite-run-reader.mjs`：`40eade963531ac2acfd9755f8656753bfd56faae90b421274ad0c5e5338fec3f`

为隔离尚未冻结的 v2 存粮修改，本候选从 v1b 冻结 runtime 的 source map 机械还原后，仅叠加上述一份项目搜索补丁，再独立执行 `backend:build`。它与 v1b 的唯一领域差异是：同一 `ProjectSearchCampaign` 的所有 search episode 共享 16 个已提交 intent move 的累计上限；真实 drop / source 分支和非 search 行动不计入该预算。

先运行种子 `185,20260815,20260816` 的 10 年配对诊断。只有移动 / 人月强度、search move share 与 campaign 目标数回落且项目、人口、休眠硬项无回归时，才使用同一冻结 runtime 扩展到 30 / 50 / 100 / 1000 年。所有运行继续使用 `civilizationNo=1`、`chaosIntensity=0`、`climateBias=balanced`、`repeats=1`。

## 冻结运行结果

- 10 年先行矩阵：`../info-age-v1c-search-campaign-budget-10y-preflight-20260820.json`，SHA-256 `6b96955cd491954ca591c4d9ef8689d269186a7787a10599006c8c2791617971`；
- 完整 15-run 矩阵：`../info-age-v1c-search-campaign-budget-20260820.json`，SHA-256 `f97858b516055abc7ec11d3dabce41ed9c6f4c22ccba5b26155e88ec2382a237`；
- v1b 配对比较：`../compare-info-age-v1c-v1b-20260820.txt`，SHA-256 `7771a189c200571b757bf82a0da4e1268f6b3d9c76c5b16c01dbb01e4b6d8b06`；
- 休眠旁车：`../audit-hibernation-v1c-search-campaign-budget-v5-20260820.json`，SHA-256 `ba031e2e61a45294ec9e797cd3b294decc5c76b5bb30ac2f9689f89a308fc59e`；
- 信息时代旁车：`../audit-info-age-v1c-search-campaign-budget-20260820.json`，SHA-256 `a52e15dee2a516dc382e40901e9db8744859be7db1ca507584e149beb49397ed`；
- marker-aware 重投影：`../reproject-info-age-v1c-marker-aware-20260820.json`，SHA-256 `b933103698c1b0d7abd6590e74459277364c702d8d7422e50d117d8954f020b8`；
- 搜索 campaign 审计脚本：`../../../scripts/audit-project-search-campaign-budget.mjs`，SHA-256 `9db63a61571272142d6f736bb85665b5baa7bd200948abbaaa22fffc248b14b1`；
- 搜索 campaign 审计产物：`../audit-project-search-campaign-budget-v1c-20260820.json`，SHA-256 `73c5d63490c988247b99f8551b88830e0df9d5729a11a80969a00e2276d25c2b`。

10 年门槛通过后，使用同一冻结 runtime 完成 `3 seeds × 10 / 30 / 50 / 100 / 1000 years`。15 / 15 个运行均结束；1000 年三个运行都因真实全员死亡提前结束。完整旁车重建出 832 个 search campaign、1,658 个 search episode；单 campaign 最大有效搜索移动为 16，超过 16、出现第 17 步、预算关闭后继续搜索与 unresolved action 引用均为 0。456 个自然 campaign 跨多个 episode 恰好到达 16 步，覆盖 14 / 15 个运行。

终止月由 v1b 的 `1319 / 1505 / 1518` 变为 `1538 / 1708 / 1265`：两个种子延后，一个种子提前，中位数 `1505→1538`，满足预登记数值门槛。最终决定分层记录为：**单一 `ProjectSearchCampaign` 的累计 16 步预算机制 `ACCEPT`；整体候选 `REVISE`。** seed `20260815` 的同一 copper-charge 因果 basis 在旧 campaign 搜索 6 步并 supersede 后，以新 campaign 重开并再搜索 16 步，同 basis 累计 22 步，证明失败记忆与预算尚未跨 campaign 生命周期绑定。

本冻结实验不支持“达到信息时代”的结论：15 个信息时代旁车全部为 `unsupported`，完整 record-use chain 为 0，三个终局仍全部灭绝。按用户要求，本轮在 v1c 收口后停止，不再启动 v1d 或后续机制。
