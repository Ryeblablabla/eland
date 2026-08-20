# 信息时代长期演进 v2 当前基线冻结清单

- 前缀：`info-age-v2-food-reserve-current-20260820`
- 冻结时间：2026-08-20 17:19:28 +08:00
- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`
- Node.js：`v24.16.0`
- 配置：seeds `185,20260815,20260816`；years `10,30,50,100,1000`；`repeats=1`；`civilizationNo=1`；`chaosIntensity=0`；`climateBias=balanced`

## 冻结运行时

- `runtime/main.mjs`：`258d66acd5d3458985542880aa0b5be5e9247fc1f448f8089813fe20155e5d45`
- `runtime/main.mjs.map`：`6f5758e23137678a826340612f3db5c36b4e249ecfd8b8d0094096184571229b`
- `runtime/eland-worker.mjs`：`226b93e3601d055355dc8ad1038386742b291cf2d49d3c77e62538f9fc9c0ac1`
- `runtime/eland-worker.mjs.map`：`7eb414b9efa09a620a8f66c07151b17c2cf030ce7030f811810d14fc19b7234c`

冻结前核对 sourcemap 中的 `container-options.ts`、`stored-food-access.ts` 与 `project-options.ts`，三者均与当前工作树逐字 SHA-256 匹配。该基线包含 v1c 的 project search campaign 累计预算、v2 的真实存粮取用与照护 relay，以及当前分段 SQLite / 长程恢复协议；尚不包含任何机械动力、能量网络或信息时代新事实。

## 关键源文件坐标

- `application/container-options.ts`：`db09413db5f2a8ced07195b5cd53825857843ff42a602a2c7c4fbaacc28b6697`
- `domain/stored-food-access.ts`：`16d9b1a160bc88c44a7901eb3a06109802ead6aba7a09ab4710797794f257b89`
- `domain/survival-reflex.ts`：`15b1018bbe37d44e83b44e7627c385a80e9dd55b434d118a5dd152da0b7479e3`
- `domain/dependent-care.ts`：`1663f479f653497be232beaf78b0af8da011c75b5172c054703fda08553ba92d`
- `application/project-options.ts`：`bdc83009a2f522db33330ca679c8bfdeeb2b262d1c3748b236231b1127922d0b`
- `server/main.ts`：`68b838a4d7d2fc891c9946046155f6c1cb7a9fca99fcd71e32c5d34f0402fe86`
- `server/sqlite-run-store.ts`：`e5155af740c99d2b64cca5891930722b5a3d5bbc1064e02ef5d4e716d6354b96`

## 下一候选的预登记边界

目标能力不是修改时代标签，而是让世界首次留下可回放的机械动力闭环：本人重复使用手工磨坊形成劳动压力；本人在当前视野中观察真实水流；由该来源形成固定项目；项目以实体转换器、连接器和 Mill 负载组成网络；严格 operate 产生物质输出；首次负载暴露可审计故障；真实材料和工具 repair 后再次 operate。

旧 schema 和本基线没有这条版本化事实链，观察器必须报告 `unsupported`，不得把缺失写成 0 或失败。候选只在定向链成立后运行 3 seeds × 10 年先行门槛；若自然触发与结构守卫通过，再使用同一冻结配置扩展 30 / 50 / 100 / terminal-1000 年矩阵。
