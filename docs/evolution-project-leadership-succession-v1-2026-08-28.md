# 有来源的项目负责人接任 v1（预登记）

状态：实现前预登记；尚无候选长程结论。

## 可证伪假设

两颗长期历史已经形成 10 个机械网络，却没有一个安装项目完成。代表项目曾由 7 名真实贡献者完成全部构件安装，并因水流暂时阻塞等待 180 个月；founder 死亡后，`synchronizeProject` 仍把 founder 当作永久唯一执行者，立即将未完成项目结为 blocked。最早断点在 `真实贡献 → 项目持续协调`，不是机械配方、时代指标或观察器。

若固定工地项目在当前负责人死亡后先形成有界 vacancy，并允许一名存活的真实贡献者在本人知晓死亡、亲自到场检查且自愿选择后成为 current lead，那么跨代工程应能保留原实体成果，同时让接任者只依靠本人的知识、物品与新观察继续；无人接任时仍应在期限后真实失败。

## 最低通用机制

- `ownerId` 永久表示 founder，不重写旧历史；current lead 由追加式、来源绑定的 leadership transition 推导。
- 只有固定 `site`、已有真实 progress evidence 的共同项目可进入接任；人物私有知识/测量/远程工作项目不自动继承。
- 负责人死亡后先写 vacancy；候选必须是存活 contributor，能解析自己的真实贡献与负责人死亡来源，并在可见、可达工地执行 typed inspect/attend 动作。第一条权威接任事件胜出。
- 接任不复制 founder 的知识、库存、计划知识、开放请求、预约、搜索或假说 campaign；旧 episode 关闭，接任者以本人压力、感知和知识重新编译。
- 对机械工程，旧构件和事件 ID 保持有效；每段制造—核验—安装必须由该事件发生时的负责人完成。接任者必须本人观察水流，并自行完成后续试运转、故障诊断、备件制造/核验、维修和真实负载操作。
- planner 不读取时代、文明指数、现代 gate 或隐藏配方。

## 最小验收

1. 客观已满足的项目仍在 founder 同月死亡时先完成；未满足项目进入 vacancy，不立即 blocked。
2. 伪 contributor、缺 progress fact、不知死亡、远程不可见/不可达工地均不能接任；无人选择时期限后按原语义 blocked。
3. 接任后 `ownerId` 不变、transition 来源完整，旧私有 campaign/request 不继承，接任者缺本人知识时不能行动。
4. 全部构件已安装、因真实水流阻塞等待的机械项目可由贡献者接任；水恢复后以 founder 构件链和 successor 本人后续链完成真实操作。
5. 旧快照无 leadership 字段仍严格回退 `ownerId`；bounded restore 能解析 vacancy/transition 的 death、contribution 和接任来源。
6. 定向机制通过后，候选才进入同种子 `10/30/50/100 年 + terminal` 配对；现代 gate 只观察真实完成事实。
