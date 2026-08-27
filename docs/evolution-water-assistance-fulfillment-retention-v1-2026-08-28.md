# 取水协助履约证据续接 v1（预登记）

状态：定向实现与验收已完成；尚无候选长程结论。

## 可证伪假设

冻结源码 seed 20260815 在第 860 月保持古代文明，提交第 861 月时以
`water assistance ... 缺少可验证的履约事实` fail-closed。取水协议会把多次到水边与饮水动作写进 `fulfillmentEventIds`，但最终履约时再次通过通用 `worldEventById` 扫描正文；较早一方的动作推出 hot window 后，协议状态仍记得其 ID，执行层却无法按该活跃协议的精确 lease 解析正文。

若活跃取水协议只维护并续接“最后一个真实 helper 到水证据 + 最后一个真实 requester 饮水证据”两条 typed anchor，并在最终履约前按当前权威顺序和协议参与者重新验证，则相隔很久的两方动作仍能自然完成协议，而不会为整段尝试历史保留正文或放宽任一物理条件。

## 最低通用机制

- 每类 anchor 只能由现有 `isHelperWaterAssistanceEvidence` / `isRequesterWaterAssistanceEvidence` 已验证的 completed ActionFact 更新；不得从 ID 文本、时间或 `fulfilledByPersonIds` 猜测。
- 每个活跃取水协议最多保留两个正文 anchor；其余 `fulfillmentEventIds` 继续作为完整 index/audit 身份，不增加 cold body。
- “最后”按权威事件 canonical order 选择。新 suffix 更新、cold open 与 warm successor 必须得到同一选择。
- 最终履约仍要求双方存活、同地或现有到达位置条件、双方各有真实证据；缺任一、错 actor、错 material、错协议或错 ordinal 都 fail-closed。
- 每个 target 的社会学习仍只形成一次成功 episode，来源最多两个真实 anchor；不合成伪事件，也不增加 observation 次数。
- 不抬 continuation coldPins 上限，不改时代、文明指数或 planner 权重；第 860 月目录只作诊断，禁止续跑。

## 最小验收

1. helper 与 requester 的动作相隔超过 hot window，full 与 bounded 均完成同一协议并写相同社会学习来源。
2. 每类发生超过 24 次时只 pin 最后一个真实 helper 与 requester anchor，早期正文不因 broad agreement lease 被保留。
3. 新 suffix 产生较晚证据后 selector 稳定替换；共享正文由其他真实 lease 引用时不被错误释放。
4. 缺 helper/requester、错 actor、非饮水材料、错误 root/ordinal、legacy 漂移均拒绝。
5. 真实 SQLite cold open 与 warm successor 重建相同 anchors；定向 fixture、backend build 与 diff-check 通过后才允许集成。

## 定向实现结果

- `Agreement` 继续保存完整 `fulfillmentEventIds`，未增加另一套持久化收据；retention 将其保存为 `index-only` membership，并按共享严格 predicate 各选择最后一条 helper/requester 正文。
- 协议结算只通过协议身份绑定的 typed lease 解析冷事实；当前 tick 的事实显式传入，仍按 overlay、hot、exact lease 的顺序取证。
- 旧 live-agreement audit sidecar 只在 exact root、verified ordinal、当前协议 membership 与真实 ActionFact predicate 全部一致时迁移；安装时剥离 fulfillment 的旧 agreement lease，仅保留 proposal/response core 与其他真实共享 lease，下一 successor 写回规范 typed group。
- `node scripts/test-water-assistance-retention.mjs`、`npm run --silent backend:build` 与 scoped diff-check 已通过。该结果只证明 retention/open-warm 因果闭包，不是长程文明演化结论。
