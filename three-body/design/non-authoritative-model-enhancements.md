# 非权威叙事增强

状态：玩家即时文明纪事已默认接入 `narrative` 模型路由；持久化历史、记忆和对话增强仍使用非阻塞旁车。权威边界以 [`../../docs/rule-first-agent-architecture-v1.md`](../../docs/rule-first-agent-architecture-v1.md) 为准。

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

## 玩家即时叙事

`/api/eland/step` 先在规则层筛选真正值得进入文明历史的事件，例如出生、怀孕、死亡、纪元转换、严重伤病、关键技术、项目完成和履约或违约。普通赶路、搬运、吃饭、日常对话和未取得结果的尝试只进入人物个人记录，不会传给模型。

当月没有重大事件时，文明历史不生成条目，也不调用模型；有重大事件时才通过 `narrative` 路由发起一次请求，将规则事实概括成一条纪事。来源事件、语义字段和权威状态仍由规则链提供。通过校验的概括会与帧一起保存，因此时间线回看不会重新调用模型。

纪元转换在文明历史中具有最高展示优先级，明确写成“恒纪元结束，乱纪元开始”或“乱纪元结束，恒纪元开始”。这类条目由规则投影直接写入历史，完全不传给模型；同月的其他重大事件仍可单独概括，二者都会保留。

端点未配置、缺少密钥、请求失败、超时、JSON 或文本不完整、内部字段泄漏、月份误写成年份、增加无来源场景时，该帧保留已筛选出的规则文本。即时请求默认最多等待 10 秒，可用 `MODEL_LIVE_NARRATIVE_TIMEOUT_MS` 调整。

## API

扫描已提交状态、最多新增 6 项并在后台调用 `narrative` 路由选中的模型端点：

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

- 端点所需的 `apiKeyEnv` 没有值：任务记为可重试的 `missing-key`，世界状态不变；`auth=none` 的局域网端点不需要密钥。
- 超时、供应商错误或非法 JSON：任务记为可重试的 `failed`，世界状态不变。
- 历史增强若把 `atMonth` 改写成年份，或加入来源中不存在的族谱、册页、碑文、档案等客观载体，按 `invalid-response` 拒绝；“投影非权威”不等于可以放弃事实忠实度。
- 调用前后来源事件消失或 run 切换分支：任务记为 `stale`，模型结果不采用。
- 服务进程在任务运行中退出：下次触发会把遗留的 `running` 恢复为 `queued`。
- 叙事请求默认超时为 30 秒，可用 `MODEL_NARRATIVE_TIMEOUT_MS` 调整；旧 `KIMI_NARRATIVE_TIMEOUT_MS` 仍兼容。超时只结束该旁车任务。

端点、协议与用途路由见[通用模型端点与协议路由](./model-endpoint-routing.md)。

权威运行文件 `state.json`、`meta.json`、`evolution.json` 和 `report.json` 均不读取增强结果。回放和继续演化也不会重新调用或消费这些文本。
