# 非阻塞叙事增强旁车

状态：当前后端最小实现。权威边界以 [`../../docs/rule-first-agent-architecture-v1.md`](../../docs/rule-first-agent-architecture-v1.md) 为准。

## 目标

规则模拟先提交 `state.json`，模型只为已经发生的关键对话、人物记忆和历史片段补充自然表达。模型任务不进入月度事务，也不修改 `SimulationState`。

每个 run 的增强队列和结果保存在：

```text
data/runs/<run-id>/narrative-enhancements.json
```

任务只能引用当前分支中真实存在的 `sourceEventIds`。模型输入保存来源事件摘要；模型完成后，服务端把任务原有的 `sourceEventIds` 复制到结果，不接受模型自行生成的事件 id。结果固定带有：

```json
{
  "authority": "projection-only",
  "title": "……",
  "text": "……",
  "sourceEventIds": ["e-…"]
}
```

这些文本可供历史页、人物回忆页或对话回放展示，但不能作为知识、关系、物质、意图、协议或动作的事实来源。

## API

扫描已提交状态、最多新增 6 项并在后台调用 Kimi：

```bash
curl -X POST http://127.0.0.1:3220/api/runs/<run-id>/enhancements \
  -H 'content-type: application/json' \
  -d '{"kinds":["dialogue","memory","history"],"maxTasks":6}'
```

接口立即返回 `202`。`processing` 只表示旁车 worker 是否仍在运行；它不影响 `/evolve`。

只创建任务、不调用模型：

```bash
curl -X POST http://127.0.0.1:3220/api/runs/<run-id>/enhancements \
  -H 'content-type: application/json' \
  -d '{"dispatch":false,"maxTasks":6}'
```

配置 key 后重试失败任务而不新增任务：

```bash
curl -X POST http://127.0.0.1:3220/api/runs/<run-id>/enhancements \
  -H 'content-type: application/json' \
  -d '{"retryFailed":true,"maxTasks":0}'
```

查询队列和结果：

```bash
curl http://127.0.0.1:3220/api/runs/<run-id>/enhancements
```

## 任务选择

- `dialogue`：只选已完成的 `communicate` 事件；接受或拒绝会同时引用被回应的提议事件。
- `memory`：只选人物状态中已经存在、重要度至少为 68 且仍有有效事件来源的记忆。
- `history`：从出生、死亡、纪元转换、履约/违约、完成项目和已观察里程碑中选取。
- 默认按三类轮转取样，避免单一类型占满一个批次；同一分支中的同一候选使用稳定任务 id，重复触发不会重复计费。

## 失败与恢复

- 无 `KIMI_API_KEY`：任务记为可重试的 `missing-key`，世界状态不变。
- 超时、供应商错误或非法 JSON：任务记为可重试的 `failed`，世界状态不变。
- 历史增强若把 `atMonth` 改写成年份，或加入来源中不存在的族谱、册页、碑文、档案等客观载体，按 `invalid-response` 拒绝；“投影非权威”不等于可以放弃事实忠实度。
- 调用前后来源事件消失或 run 切换分支：任务记为 `stale`，模型结果不采用。
- 服务进程在任务运行中退出：下次触发会把遗留的 `running` 恢复为 `queued`。
- Kimi 默认超时为 30 秒，可用 `KIMI_NARRATIVE_TIMEOUT_MS` 调整；超时只结束该旁车任务。

权威运行文件 `state.json`、`meta.json`、`evolution.json` 和 `report.json` 均不读取增强结果。回放和继续演化也不会重新调用或消费这些文本。
