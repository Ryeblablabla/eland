# 信息时代长期演进 v3 机械动力候选冻结清单

- 前缀：`info-age-v3-mechanical-power-20260820`
- 冻结时间：2026-08-20 18:24:53 +08:00
- Git HEAD：`7a50b51341b6aaddf0d039b257925da3057a84da`
- Node.js：`v24.16.0`
- 配置：seeds `185,20260815,20260816`；years `10,30,50,100,1000`；`repeats=1`；`civilizationNo=1`；`chaosIntensity=0`；`climateBias=balanced`

## 冻结运行时

- `runtime/main.mjs`：`df45f98cc39eaaff04080d07b054dcbee808bc4f8b62534b69d28817be84303a`
- `runtime/main.mjs.map`：`db2a500d9c8a4cfef7398ae56f873752aa8634340bf4ed4a490b22fc359e5d67`
- `runtime/eland-worker.mjs`：`a2655d9e1218edeedd5cad6cefc84a9bf614733f1f3797ea7980ae52e769046b`
- `runtime/eland-worker.mjs.map`：`00969b66a4e737347acaf40bf54a1ba6726a2041a690a2772feacd8c4956056a`

冻结包来自一次 `npm run backend:build`；矩阵只使用本目录运行时与数据库，不复用或重启 3220 的用户开发服务。

## 关键源文件坐标

- `domain/mechanical-power.ts`：`8f5beb9d451246469ee08419373582d194f7a700713116d4d74ae32a8b6ff8fe`
- `application/mechanical-power-options.ts`：`8d6146658549ed176678f45fe871de4073107c2d63cdd135f86a120503d87a12`
- `domain/action-executor.ts`：`c8d03b50193669e880194f3290d3d4ea7b9d88e9bcee74cfd897c129c9dfc0a5`
- `application/project-options.ts`：`544c90b528b883319a4fa77097e2dbfa88f87b36381ce3e3d2ba143a4f8ba782`
- `world/generator.ts`：`19895a3900fcd5abba07ff65aba22e89575b6ec9c9c5493a3e288c689af574a4`
- `scripts/audit-mechanical-power-chain.mjs`：`61253e573b1d7b27a9416f6437b3b947759853ee79777c8811f8b7e5272a524a`

## 预登记因果与门槛

候选必须留下可回放的完整链：本人手工磨坊劳作压力 → 本人观察当前可见的真实水流 → 固定可见工地试建 → 真实材料制造与来源核验 → 新 Mill 负载、传动轴、水轮安装 → 首次试运转出现不消耗输入的对中故障 → 新轴与工具维修 → 同一网络在有效水流下再次运行并把 Seed 转为 Food。

- 私有知识、时代标签、文明指数、全局水图或隐藏配方不得成为计划依据。
- 未知配方只走普通局部有限假说；可靠的中间材料配方可展开为真实合法动作。
- 旧 Mill、错位置、错来源、失流、死亡遗落或缺失事件谱不得完成项目。
- 机械观察器分母为零时报告 `unsupported`，不得写成 100%。
- 该版本只建立连续机械动力的前置层，不宣称电力、通信、计算或信息时代已达成。
