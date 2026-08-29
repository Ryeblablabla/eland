# 多项目候选动机 v1（预登记）

状态：定向机制验收通过；候选长程尚未完成，不能据此宣称现代文明已出现。

## 可证伪假设

`main@ebaf5e0` 的 100 年权威案例已经形成本人磨坊劳动、水流观察与有效机械工位，但没有启动水力加工项目。静态因果审计发现，项目层最多保留两个已证明可执行的候选，而人物 need agenda 只给压力最高的候选建立精确 `projectId` need；其余候选即使合法，也因 appraisal 要求 `projectId` 精确匹配而得到零动机。

最早确定断点是 `need -> option appraisal`。若每个已证明可执行的项目候选都从自己的压力与来源事实形成独立、项目作用域内的 need，那么它们应进入同一套人格、经验、期限、风险和有界前向推演竞争；较低压力候选仍可自然落选，不保证机械项目或任何时代结果。

## 最低通用机制

- 只处理本次合法 options 已包含的项目候选，不凭空创建项目、配方或行动。
- 每个不同项目使用自身 `projectId`、当前有效 pressure、need 与来源事实生成 scoped need；既有的近期同类完成缓解判定保持原样，本轮不混入修正。
- scoped need 的 kind 必须与同一项目 option 的 alignment 一致；`knowledge-preservation` 项目使用 `inquiry`，不能因重复映射漂移而得到零 activation。
- 不放宽项目提案生成端最多两个新项目候选的容量，保留稳定排序与现有单候选行为。
- 不改变压力权重、项目期限、行动合法性或 BDI 排名公式。
- planner 不读取时代、文明指数、里程碑、隐藏配方或全局地图。

## 最小验收

1. 同一人物面对压力 100 与 88 的两个不同、可执行项目时，两者都形成精确 scoped need，来源不串线，较低压力项 appraisal activation 大于零。
2. 单项目候选与无项目候选保持原行为；重复指向同一项目的 option 不产生重复 need。
3. 定向夹具与 backend build 通过后，才建立新的 source-stable revision。
4. 最终机制结论使用至少 3 个相同种子的 `10/30/50/100 年 + terminal` 基线/候选配对；短夹具只证明因果，不宣称文明已进入现代。
5. 现代/信息阶段只由权威机械、电力、测量、记录和制度事实观察，不成为人物奖励；保留停滞、灭绝与相反种子。

## 长程边界

- 基线 revision：`ebaf5e06164288db6f612aabbd7d49244566fd56`。
- 基线案例：`nextgen-v12-capability-s20260815`，100 年停留 ancient；仅作断点案例，不单独支持 A/B 结论。
- 候选必须从 genesis 使用全新 run prefix 和数据目录，不续跑旧 v11/v12 状态。
- 每次只运行一个终局进程，并持续监控 RSS；性能不足时只优化不改变规则结果的通用路径。

## 定向结果

- `node scripts/test-project-candidate-needs.mjs`：通过；覆盖双候选、去重、单候选、无项目候选和 durable-record 的 inquiry 映射。
- `npm run --silent test:agent-cognition`：通过。
- `npm run --silent backend:build`：通过。
- 独立只读复核：ACCEPT，无 P0/P1。
- 黄灯：真实新 proposal 同时携带顶层 `projectId` 与 `projectProposal`，既有 recent-resolution 分类因此可能把它视为 existing；本轮没有改变或宣称验证这项旁支。
