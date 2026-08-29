# 长程文明 horizon 因果证据包 v1

`three-body/scripts/extract-bounded-horizon-evidence.mjs` 在同一条终局文明 lineage 的阶段停点读取证据。它不是短程模拟器，也不改变权威状态：extractor 用 runner 的同一路径以 `wx` 获取互斥 evidence lease，并持有到 shell chunks 与 pack 耐久发布完成；活跃 runner 或另一个 extractor 因而不能同时进入。SQLite 只读打开，提取结束后会用新连接重新核对 current run、checkpoint、continuation、root、bundle、账本与数据库文件封印；任一变化都会拒绝发布 pack。

## 使用方式

从 `three-body/` 运行：

```bash
node scripts/extract-bounded-horizon-evidence.mjs \
  /absolute/data-directory \
  run-id \
  120 \
  /absolute/shared-evidence-directory
```

同一 run 应以 `120 -> 360 -> 600 -> 1200 -> 12000` 月顺序停下、取证并继续。配置中的权威 endpoint 始终保持 12000 月；阶段 month 只是宿主停点，不能启用 `stop-on-modern`，也不能把五个停点当作五条独立文明。所有 baseline/candidate seed 都抵达自然灭绝或 12000 月后，阶段包才能进入最终矩阵结论。

定向验证接受一个已冻结的数据目录：

```bash
node scripts/test-extract-bounded-horizon-evidence.mjs \
  /absolute/frozen-data-directory \
  run-id \
  1200
```

## 包含的证据

- exact run/checkpoint/continuation/root/bundle 的 revision、month、lineage、head、event count 与 tail 联合封印；
- 完整权威事件链的流式计数：事件类别、行动状态与操作、intent 归属、出生、死亡和死因；project 归属不从 payload 猜测，而是先从 exact shell 的每个 `project.actionEventIds` 建立去重 membership，再与完整权威历史中的 action fact 精确连接；
- payload 内出现的 project ID 仅作为 `embeddedProjectReferences` 诊断计数，不称为归属；每类至多 24 条 mechanical、electrical、measurement、record 代表事件分别保留 canonical ordinal、`owningProjectIds`、`embeddedProjectIds` 和有界来源 ID；
- 当前 shell 的人物、项目 lifecycle、意图、协议、记录、制度、设施、机械和电力摘要；
- 时代账本中与 exact authority 对应的时代、现代门槛、witness ordinal、source/runner/config hash；账本没有记录耗时或 RSS 时明确写 `null`，不从别处猜测；
- current root、continuation bundle、shell manifest 和所有被完整访问的 shell part 原始存储字节。
- extractor 自身、动态 codec entry、esbuild metafile 中实际参与 bundle 的完整传递源码清单及逐文件 SHA、精确构建参数，以及实际 esbuild bundle SHA/版本；发布前会再次核对全部 verifier 输入与生成 bundle，定向夹具会按记录参数重建 bundle 并比对 SHA。

共享 `evidence/chunks/<hash>` 只保存当前 shell 与 continuation 所需的 content-addressed 字节。完整 history node/segment 不会在每个 horizon 重复复制；终局 SQLite 仍是共享的完整历史载体。pack 采用 canonical JSON，并以 `eland-bounded-horizon-causal-evidence-v1\0` 域分隔计算 SHA-256。

## 边界

- 工具拒绝取得 runner/evidence 互斥 lease、非 schema-3 root、非 exact month、缺少 exact 账本记录、权威或 verifier 来源变化、同一 project 内重复 action ID、project action 未解析/错类型/在历史中重复解析，或容量越界。finally 只有在 lock 内容 token 仍属于本进程时才释放它。
- 项目 lifecycle 最多 16,384 条，出生和死亡各最多 16,384 条；exact shell 的去重 project/action membership 最多 262,144 条，payload embedded project reference key 最多 16,384 个。超过即失败，不截断核心计数。
- observer 时代、指数和现代门槛只在证据包中下游展示，绝不进入人物 planner。
- 代表事件是诊断样本，不代替完整流式计数，也不单独证明文明能力。
