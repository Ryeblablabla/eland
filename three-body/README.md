# ThreeBody

三体文明演化原型。前端仍由 Vite 提供；演化后端可以完全脱离前端运行，并把每个运行的完整状态及事件历史持久化到磁盘。

## 自主演化能力

长期能力目标以 [`../docs/human-society-capability-map-1000.md`](../docs/human-society-capability-map-1000.md) 的 **1000 项能力地图**为准。当前引擎已为其中 **65 项**接入事实判定：原有 40 个生存、文化、定居、交换与求知节点，10 个生命循环节点，以及 15 个身体健康扩展节点；本轮新增“保障残障者参与生活”和“提供临终照护”。

这些节点不是 Agent 的任务清单。人物只根据身体、五层需求、关系、局部认知和环境可供性选择行动；里程碑在事后从世界事实、物质来源和跨年实践中派生。模拟中间态同样由 `origin` 按普通规则演算生成，并保留完整前史证据。当前正式覆盖率为 **65 / 1000（6.5%）**；“正式覆盖”表示已有可裁决规则与闭合证据链，不表示每个文明都会经历该事件。

能力地图编号、名称和覆盖状态只能出现在事后观察器与文档中，不进入人物提示、需要强度或候选行动评分。人物看到的是身体状态、材料性质、同地人物和自己的有来源经验；例如观察器可以把“纤维作用后出血下降”识别为第 103 项，但人物得到的只是通用的“检查身体”和“把材料用于身体”能力。若人物亲历近距离接触后发病，他只能形成带不确定性的个人关联，并通过普通移动改变接触人数；世界中不存在名为“完成隔离里程碑”的命令。

植物材料的客观身体效应也不会暴露给人物或模型。人物最初只看到“植物”这一可用材料；使用后才能从病情、健康或心理负荷的前后变化形成带来源经验。精神痛苦由损失、灾害、疾病和匮乏累积产生；专业照护角色则由跨年、跨对象的真实改善和照护信任事后识别，不是预置职业。

地点用途也不预置。人物只能依据自己保存的来源事实，发现某地反复汇聚检查与照护，进而用普通建材改善共同遮蔽；观察器在遮蔽完工且继续被多人跨年使用后，才识别为诊疗场所。身体经过记录与材料比较同样只引用人物可访问的事实；较差材料是否被淘汰，由后来真实照护中不再复用来判定。

伤后功能也作为独立身体状态持续存在：部分重度跌伤会留下长期移动余损，刚性木骨只有经人物普通加工并实际适配后才成为身体支撑；伤者必须继续携带、跨年恢复并重新移动，事后观察器才识别为辅助器具与康复。若余损仍在，受限者还需借支撑进入有同伴的地点并实际参与采集、分享、劳动、照护、记录或文化活动，才能进一步识别为残障者参与生活。

寿命终点或老年重病不再总是瞬时死亡：人物会先进入不可逆衰退、退出劳动，仍保留疲惫、不适与陪伴感受；他人的普通给食、照料或陪伴只能改善临终期状态，不能延后已经确定的身体进程。事后死亡事实同时保留衰退来源与实际支持来源，观察器据此识别临终照护。生育偏好、柔性覆盖物和受孕风险已进入底层世界模型，但严格的跨年避孕证据链尚未从原初态回放成立，因此第 115 项仍不计入正式覆盖；第 118 项仍缺依赖与戒断机制，第 120 项仍缺多个患者争用有限医疗资源的真实情境，也暂不计入。

## 独立演化后端

```bash
npm run backend
```

默认监听 `http://127.0.0.1:3220`，运行数据保存在 `data/runs/<run-id>/`：

- `state.json`：完整 `SimulationState`，包含人物、物质、历史事件和文明结局。
- `meta.json`：便于列举运行的轻量摘要和持久化修订号。

可配置环境变量：

```bash
THREEBODY_PORT=3220
THREEBODY_HOST=127.0.0.1
THREEBODY_DATA_DIR=/absolute/path/to/runs
DEEPSEEK_API_KEY=...
```

也可用 `THREEBODY_ENV_FILE` 指向包含 `DEEPSEEK_API_KEY` 的 env 文件。服务默认只使用本地规则推进，不需要模型密钥。

## API

### 创建运行

```bash
curl -X POST http://127.0.0.1:3220/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "id": "agriculture-01",
    "label": "农业观察",
    "seed": 185,
    "config": {
      "civilizationNo": 1,
      "startingPoint": "records",
      "chaosIntensity": 0,
      "endpoint": { "kind": "ticks", "value": 99999 }
    }
  }'
```

`id` 可省略，由服务生成。`startingPoint` 支持 `origin`、`shelter`、`roads`、`records`、`models`。

### 后台快速演化

本地规则模式适合批量演化和调试，不调用 LLM：

```bash
curl -X POST http://127.0.0.1:3220/api/runs/agriculture-01/evolve \
  -H 'content-type: application/json' \
  -d '{ "years": 100, "mode": "rules" }'
```

模型模式每年轮换少量人物通过模型完成年度关键决策，其余人物使用本地规则；每名可行动人物每年只执行一次行动。未指定模型时默认使用 Kimi，也可以显式指定 DeepSeek：

```bash
curl -X POST http://127.0.0.1:3220/api/runs/agriculture-01/evolve \
  -H 'content-type: application/json' \
  -d '{ "years": 3, "mode": "kimi" }'
```

响应默认返回摘要、最后一年事件和结局；调试时传 `"includeState": true` 可同时返回完整状态。每次推进成功后自动持久化，同一个运行的并发写入会串行执行。

### 查询与导出

```bash
# 所有运行摘要
curl http://127.0.0.1:3220/api/runs

# 摘要和完整状态
curl http://127.0.0.1:3220/api/runs/agriculture-01

# 仅导出可再次导入的 SimulationState
curl http://127.0.0.1:3220/api/runs/agriculture-01/state \
  -o agriculture-01.json
```

### 导入状态

从状态、演化报告的 `finalState`，或 `{ "run": { "state": ... } }` 创建新运行：

```bash
node -e '
  const state = require("./agriculture-01.json");
  process.stdout.write(JSON.stringify({ id: "agriculture-copy", state }));
' | curl -X POST http://127.0.0.1:3220/api/runs/import \
  -H 'content-type: application/json' --data-binary @-
```

覆盖已有运行的状态：

```bash
curl -X PUT http://127.0.0.1:3220/api/runs/agriculture-01/state \
  -H 'content-type: application/json' \
  --data-binary @agriculture-01.json
```

导入过程会调用现有状态迁移逻辑，并重新生成派生观察数据。

### 其他接口

- `GET /health`：服务与数据目录状态。
- `POST /api/decide`：模型决策接口，未传 `model` 时默认使用 Kimi；传入 `"model": "deepseek"` 可切换到 DeepSeek。

## 前端

本次没有修改前端的数据流。仍可单独启动：

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm run backend:build
```

## ELAND 播放会话限速

前端通过 `/api/eland/play` 播放时，默认每轮演化至少间隔 5 秒，给宇宙动画、人物地图和史册条目留出展示时间。服务端也会对 `/api/eland/step` 的普通单步请求执行同样的间隔保护。

快速迭代或测试时，调用接口显式传入 `fast: true`，即可跳过播放等待；前端不会传这个参数：

```bash
# 快速单步
curl -X POST http://127.0.0.1:3217/api/eland/step \
  -H 'content-type: application/json' -d '{ "fast": true }'

# 快速自动演化；停止时仍传 on:false
curl -X POST http://127.0.0.1:3217/api/eland/play \
  -H 'content-type: application/json' -d '{ "on": true, "fast": true }'
```
