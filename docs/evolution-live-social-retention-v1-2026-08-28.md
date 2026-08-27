# 活人社交历史的分层保留 v1（预登记）

状态：定向机制验收通过（ACCEPT）；尚无候选长程结论，未启动长程。

## 可证伪假设

当前 `gameplay:live-person-social:<person>:sources` 为每个活人保留其全部社交来源正文。人物数与历史月份同时增长时，相同事实会被多个 owner lease 重复要求，最终使 continuation `coldPins` 达到 16,384 并在提交前 fail-closed；20260816 的冻结源码运行在第 818 月已有 16,314 pins，并于第 819 月触发该边界。

若完整 membership 只保留为 per-owner `index-only` 身份集合，而普通社交消费者改读从当前权威 root 严格解码出的、owner 隔离的最小 typed descriptor；只有确实读取完整动作字段的电气远程协作与测量不确定性继续使用窄 `all` lease，则规划结果应与 full history 逐字一致，同时 broad social lease 的正文 pins 降为 0，且任一不能精确证明的来源继续 fail-closed。

## 最低通用机制

- 每个 living owner 保留完整、不可截断的 source ID membership，但 requirement 为 `index-only`；不按 top-N 丢弃历史。
- descriptor 只能从当前 authoritative history base 的 exact root、verified ordinal 与真实事件正文生成，并按 owner 隔离；不得注册进通用 `worldEventById`。
- descriptor 只包含已审计消费者所需的类型字段：对话参与者/主题/响应与 basis、重复提议、感谢支持、关系资格、condition/death/birth、blocked delivery、canonical 坐标与存在性。
- overlay > hot > owner descriptor，同 ID 首个权威来源胜出；foreign owner 不可查询。
- 电气 remote-work 与 measurement uncertainty 保留独立的 per-person strict `all` 子 lease；其 selector 在 full/bounded 共用，任何超界都拒绝而不截断。
- maternal teaching 只读当前 state；observer milestone 不得反向要求 gameplay body。
- 旧 broad `all` 只允许在真实 SQLite open 时按相同 owner/key/eventIds 精确迁移；新 successor 只能发布规范分层形状。

## 最小验收

1. 将各消费类型的事实推出 hot window，full 与 bounded 的重复提议、感谢、关系、重新提议、条件、blocked delivery、电气与测量选项/依据/决策逐字一致。
2. broad membership 完整保留且正文 pins 为 0；只有两个 strict 子组保留实际所需正文。
3. owner 遗忘、condition 清除、关系来源替换与人物死亡会精确退租；共享事实只在最后 owner/strict lease 释放后删除。
4. foreign owner、错误 root、错误 ordinal、错误事件类型和 legacy 形状漂移全部 fail-closed。
5. 通过真实 SQLite cold open 与 warm successor 重建 registry；不得沿用上一月或另一 history base 的 descriptor。
6. 定向机制验收后才合入新的 runtime SHA，并用全新 prefix 从 genesis 进行 terminal 演算；不得续跑第 818 月 fail-closed 目录。

## 定向结果

单一真实 SQLite 夹具完成了 cold open → successor publication → warm successor 的同一路径验证。364 个权威事件中，活人 broad membership 为 38 个 ID 且不产生正文 pin；电气远程工作与测量不确定性分别只保留 6 与 3 个 strict 正文。旧 broad `all` 能按 exact owner/key/eventIds/ordinal 迁移，新 successor 只发布 `index-only` broad 与两个规范 strict 子组。

代表性社交消费者的 full/bounded 结果逐字一致；owner、history base 与 ordinal 隔离、遗忘/条件清除/关系替换/死亡退租、共享 source 最后 owner 释放均通过。交叉审查发现并修正了机械动力动作误入电气 strict lease 的超集，反证确认仅携带 `mechanicalPowerBasis` 的 install/repair 动作不会获得正文 lease。

验证仅包括 `node scripts/test-live-social-retention-layering.mjs`、`npm run --silent backend:build` 与 `git diff --check`；这些结果只接受分层保留机制，不代表长期文明演化或 terminal 运行已经验收。
