# ELAND Agent CLI v1

状态：当前可执行的开发调试接口。CLI 是现有 HTTP API 的适配器和实验编排器，不拥有领域规则，也不直接写 SQLite。

## 领域与边界

| 命令域 | 对应能力 | 默认性质 |
| --- | --- | --- |
| `doctor` | 服务、数据目录和 SQLite 位置 | 只读 |
| `run` | 持久化运行、状态迁移、后台演化与事实报告 | 读写 |
| `inspect` | 人物、项目、事件和文明摘要投影 | 只读 |
| `session` | 实时会话、时间线、存档、结算与终章 | 读写 |
| `agent` | 人物历史和主动对话 | 读写 |
| `experiment` | 多种子、多时长的可恢复运行矩阵 | 读写 |
| `narrative` | 非权威叙事增强旁车 | 读写旁车，不改模拟事实 |
| `model` | 模型设置、端点测试和底层决策请求 | 读写模型设施 |

`run` 与 `session` 不能互换：前者服务后台快速演化和长程实验，后者服务带权威修订、分支、逐月天象输入和人物交互的实时游戏。CLI 只组装请求、等待任务和形成只读调试投影；模拟合法性、并发冲突、状态提交和持久化仍由服务端裁决。

## 入口

后端默认监听 `http://127.0.0.1:3220`。从 `three-body/` 执行：

```bash
npm run --silent eland -- doctor
npm run --silent eland -- run list
```

可用 `--base-url <url>` 或 `ELAND_BASE_URL` 指向其他后端。命令成功时向 stdout 输出 JSON，失败时向 stderr 输出结构化 JSON 并返回非零退出码。TTY 默认格式化 JSON；重定向或 Agent 调用时默认输出紧凑 JSON。

常用全局选项：

```text
--base-url <url>
--request-timeout-ms <ms>
--output <file>
--pretty
```

输入 JSON 的选项接受普通路径、`@path` 或 `-`（stdin）。完整命令清单使用：

```bash
npm run --silent eland -- --help
```

CLI 源码位于 `three-body/scripts/eland.mjs`，npm 入口为 `eland`。使用 `npm run` 调用时保留 `--silent`，否则 npm 自身的前导文本会污染用于 Agent 解析的 stdout。

## 持久化运行与演化

创建并推进一个确定性运行：

```bash
npm run --silent eland -- run create \
  --id debug-seed-17 \
  --label debug-seed-17 \
  --seed 17 \
  --months 120

npm run --silent eland -- run evolve debug-seed-17 --to-month 120 --wait
npm run --silent eland -- run report debug-seed-17
```

`--months` 是相对推进的兼容模式。`--to-month` 使用绝对终点和完整 expected identity；CLI 默认从当前运行与已有演化路径构造 identity，也可以用 `--expected <file>` 提供冻结的预期身份。

`run show` 只输出摘要，避免意外把完整体素状态写入上下文。`run state` 与 `run export` 输出完整权威 `SimulationState`。导入通过 `run import --file <json>` 完成。需要显式替换既有运行状态时使用 `run replace-state <id> --file <json>`；它走现有 HTTP 校验与串行保存链，不直接写 SQLite。CLI 不提供删除运行的命令。

`run replace-state` 会选择历史 replace 模式并生成新的 lineage，适用于明确的状态迁移或调试恢复，不属于普通查看步骤。只需要调查问题时应使用 `run show`、`run state` 或 `inspect`。

## 领域检查

领域检查是对权威状态的只读投影：

```bash
npm run --silent eland -- inspect summary debug-seed-17
npm run --silent eland -- inspect person debug-seed-17 person-1
npm run --silent eland -- inspect project debug-seed-17 project-1
npm run --silent eland -- inspect events debug-seed-17 --kind action --since-month 100
```

`inspect person` 同时返回人物、当前意图、拥有的项目和最近相关事件。`inspect project` 只使用项目保存的事实 ID 关联事件。检查结果不会写回领域状态，也不能作为人物可感知事实。

## 实时会话与人物

只读调试：

```bash
npm run --silent eland -- session state local-play
npm run --silent eland -- session history local-play
npm run --silent eland -- session frame local-play --month 24
npm run --silent eland -- agent history local-play person-1 --limit 40
```

会话生命周期、checkpoint、手动存档、seek 和人物对话也有对应命令。`session step` 的天象、宇宙快照和完整权威身份通过 `--body <json>` 传入，CLI 不自行生成第二套世界输入。

`session settle` 与 `session requiem` 会先读取最新权威帧，再把文明、分支和月份作为 expected identity 提交；若读取后会话继续推进，服务端仍会以 409 拒绝陈旧操作。

`session begin`、`step`、`load`、`seek`、`settle`、`requiem` 与 `end` 都可能改变当前实时会话或分支。Agent 在诊断任务中不应仅因为命令可用就执行这些写操作。

## 实验矩阵

矩阵命令默认以单并发依次完成每个运行，避免开发机同时启动过多长程 Worker：

```bash
npm run --silent eland -- experiment run \
  --prefix candidate-shelter-v2-20260822 \
  --seeds 17,185,20260815 \
  --years 10,20,30 \
  --output data/experiments/candidate-shelter-v2-20260822-matrix.json
```

每个 run ID 由 `<prefix>-s<seed>-y<years>` 确定。重复执行默认恢复同身份运行，后端会用绝对 `requestedEndMonth` 和完整 expected identity 拒绝错误复用。`--concurrency` 可显式提高到 2–8；`--no-wait` 只派发任务。矩阵 JSON 是离线交换与复核产物，不是运行时事实源。

普通规则实验仍应遵循《文明演化双闭环与实验协议》：先写可证伪假设，基线与候选使用相同种子、时长和配置，保留灭绝、停滞和失败样本。CLI 只降低运行与取证成本，不改变实验接受标准。

查看已派发矩阵：

```bash
npm run --silent eland -- experiment status --prefix candidate-shelter-v2-20260822
```

## 叙事增强与模型设施

叙事增强只写非权威旁车：

```bash
npm run --silent eland -- narrative generate debug-seed-17 --kinds history --max-tasks 4
npm run --silent eland -- narrative status debug-seed-17
```

模型设置、端点测试和底层 decide 接口也可以通过 `model` 命令访问。复杂请求统一使用 JSON 文件，避免在 CLI 中复制模型协议：

```bash
npm run --silent eland -- model settings
npm run --silent eland -- model endpoint-test --body endpoint.json
npm run --silent eland -- model decide --body decision-request.json
```

CLI 不会打印本地保存的 API Key；端点测试与保存仍由服务端执行既有校验。

## 退出码

| code | 含义 |
| ---: | --- |
| 0 | 成功 |
| 1 | CLI 内部异常 |
| 2 | 参数或请求错误 |
| 3 | 资源不存在 |
| 4 | 权威身份或并发冲突 |
| 5 | 后端不可用或服务端错误 |
| 6 | 等待超时 |
| 10 | 演化或矩阵运行失败 |

CLI 的最小定向验证为 `npm run test:cli`。它使用临时 HTTP fixture，不访问或改写正式 SQLite。

文档或 CLI 参数发生变化时，至少同步检查本文件、`AGENTS.md`、`three-body/src/game/eland/README.md` 与 `npm run --silent eland -- --help`。CLI 是工程文档，不属于人物可感知的世界规则，因此不进入 `knowledge-base/rules-page.js` 的规则树。
