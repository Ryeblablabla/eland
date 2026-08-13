# ThreeBody

三体文明演化原型。前端仍由 Vite 提供；演化后端可以完全脱离前端运行，并把每个运行的完整状态及事件历史持久化到磁盘。

## 自主演化能力

长期能力目标以 [`../docs/human-society-capability-map-1000.md`](../docs/human-society-capability-map-1000.md) 的 **1000 项能力地图**为准。当前月度物质世界的运行时观察器可判定采集、住所、种植收获、道路、交换约定、交换交付、观察自然与技术传播。支撑更多能力自然出现的底层设计见 [`../docs/emergent-capability-substrate-v1.md`](../docs/emergent-capability-substrate-v1.md)。

这些节点不是人物的任务清单。人物只根据身体、状态、关系、私有知识、私有背包和局部环境可供性选择源自动作；里程碑在事后从世界事实、物质来源和跨月实践中派生。“正式覆盖”表示当前代码已有可裁决规则与闭合证据链，不表示每个文明都会经历该事件。

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
- `evolution.json`：长程演化状态、检查点、人口/阶段变化和带证据 ID 的关键转折。
- `report.json`：由真实事件确定性生成的人口、动作、里程碑、证据 ID 与模型用量统计，不调用模型总结。

可配置环境变量：

```bash
THREEBODY_PORT=3220
THREEBODY_HOST=127.0.0.1
THREEBODY_DATA_DIR=/absolute/path/to/runs
KIMI_API_KEY=...
# 可选；默认值见 .env.example
KIMI_API_URL=https://api.kimi.com/coding/v1/chat/completions
KIMI_MODEL=kimi-for-coding
```

也可用 `THREEBODY_ENV_FILE` 指向包含 `KIMI_API_KEY` 的 env 文件。产品中的演化只允许 Kimi 关键决策；没有密钥、调用失败或返回非法决策时，该月不会提交，也不会降级为本地人物决策。

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
      "chaosIntensity": 0,
      "endpoint": { "kind": "months", "value": 1200 }
    }
  }'
```

`id` 可省略，由服务生成。

### 后台真实演化

启动长程演化任务。响应为 `202 Accepted`；服务逐月推进，只在预算选中的月度关键决策点调用 Kimi。世界物理、身体消耗和既有长期行动仍由确定性规则推进，但不会替人物生成新的本地决策。

```bash
curl -X POST http://127.0.0.1:3220/api/runs/agriculture-01/evolve \
  -H 'content-type: application/json' \
  -d '{ "months": 120 }'
```

任务每 12 个月保存一次完整状态与演化路径；文明提前结束时立即保存。进程或 API 中断时，`evolution.json` 会标记 `failed` 并保留最近检查点。

```bash
# 查询进度和演化路径
curl http://127.0.0.1:3220/api/runs/agriculture-01/evolution

# 完成后读取确定性事实报告
curl http://127.0.0.1:3220/api/runs/agriculture-01/report
```

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
- `POST /api/decide`：Kimi 月度关键决策接口。

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

## 宇宙渲染（three.js）

宇宙场景默认由 three.js（WebGL）渲染：恒星球芯 + 加法混合辉光、UnrealBloom 泛光（高阈值防过曝）、顶点色渐隐轨迹线、深空近黑底色与若隐若现的星云。相机为可交互 3D 视角：拖拽旋转、滚轮缩放（不平移），松手 4 秒后恢复自动取景（约 22° 俯视与缓慢漂移）。物理仍由 `src/lib/threebody.ts` 的 2D RK4 引擎驱动，`ThreeBodyCanvas` 的 props 契约与原 Canvas 2D 版完全一致，`skyMode: 'frozen'` 时只推进物理、跳过渲染。

## 回放与演化

前端单步和连续播放都通过 Kimi 完成月度关键决策。回放只读取已经持久化的事实和快照，不会产生新演化，也不会调用模型。
