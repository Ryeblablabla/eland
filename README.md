# ThreeBody / ELAND

规则优先的三体文明演化原型。前端由 Vite 和 three.js 提供沉浸式宇宙与人间场景；演化后端可以完全脱离前端运行，并把每个文明的完整状态及事件历史持久化到磁盘。

## 灵感与体验目标

项目的核心灵感来自《三体》中的三体游戏：文明在不可预测的恒纪元与乱纪元之间求生、发展、毁灭并被下一代文明接续，最后由真实历史留下类似“第 141 号文明毁灭于烈焰”的简洁结语。

这类结语不是预写剧情，也不是人物追逐的任务。文明编号、能力、繁荣、停滞和毁灭原因都应由世界规则与人物行动实际产生；叙事层只在事实发生后提炼和表达它们。

## 当前实现与文档

可执行代码和测试代表当前已经实现的行为。设计文档与实验报告用于解释目标、协议和当时结论，但部分内容可能落后于代码；阅读时应核对对应实现和版本。发现冲突时，以代码描述当前事实，显式记录文档偏差，并在确认新行为符合当前方向后更新文档，而不是为了旧文字回退实现。

人物与模型的当前权威边界见 [`../docs/rule-first-agent-architecture-v1.md`](../docs/rule-first-agent-architecture-v1.md)：后端始终使用本地规划器，每月执行 15 个规划刻度；当前已经实现的 Kimi 入口是异步、非权威的对话/记忆/历史表达旁车，其他战略与创造性入口仍是后续架构。文明规则的修改必须遵循 [`../docs/evolution-iteration-loop-v1.md`](../docs/evolution-iteration-loop-v1.md) 的双闭环与多运行实验协议，不能根据单次演化直接得出 A/B 结论。首轮 3 个种子、10/20/30 年的完整结果见 [`../docs/evolution-project-loop-experiment-2026-08-15.md`](../docs/evolution-project-loop-experiment-2026-08-15.md)。

## 领域架构

具有业务含义的代码尽量采用 DDD。当前依赖方向保持为：

```text
UI / HTTP / optional model infrastructure
              ↓
adapter / application use cases
              ↓
domain model and policies
              ↓
world primitives
```

`domain/` 承载权威实体、状态与规则；`application/` 编排用例、项目、规划和合法行动；`projection/`、报告与 UI 只读取和解释已经发生的事实。React、Three.js、HTTP 和模型供应商不进入领域层，纯渲染与小型工具也不为形式而强行套用 DDD。更完整的当前模块地图见 [`src/game/eland/README.md`](src/game/eland/README.md)。

## 演进世界与装饰层

人间体素世界中的行为、建筑、生产、自然变化和社会关系全部由演进产生。为了让这些事实更有表现力，前端在权威世界之上增加了只读的“装饰层”：`src/game/voxelKits.ts` 根据 `SocietyState` 把人物动作、建筑阶段、道路、物资、植物、动物、火焰和纪元状态转换为微缩体素素材，再由 `SocietyScene3D` 合批渲染。

装饰层可以增加确定性的外观细节与动画，但不能创造领域中不存在的行动、建筑、物品或自然事实，也不能写回模拟状态或影响人物决策。

[`../voxel-asset-lab/`](../voxel-asset-lab/) 是实验素材和渲染示意网站，采用与生产装饰层同构的微体素尺度，并区分“已接入”和“视觉原型”。所有计划加入游戏的人物、行为、建筑、物件、动物、植物和自然效果，都应能先在这里补充、浏览或验证，再接入生产装饰层。

```bash
cd ../voxel-asset-lab
npm run dev
# http://127.0.0.1:7100
```

## 自主演化能力

长期能力目标以 [`../docs/human-society-capability-map-1000.md`](../docs/human-society-capability-map-1000.md) 的 **1000 项能力地图**为准。当前运行时由 `projection/capability-milestones.ts` 提供 v2 因果目录：120 个与地图原标签一致的坐标（53 strict、67 guarded），另有 17 个不占地图编号的三体/世界复杂事件。目录同时包含形成、实践、稳定、伤害、应对、衰退、崩溃和恢复，例如生产与传承、项目阻塞与恢复、技术失传、偷盗未遂/得手、人际暴力致死、拘束与释放、违约、成员退出和共同体解体。完整边界见 [`../docs/capability-milestones-causal-observer-v2.md`](../docs/capability-milestones-causal-observer-v2.md)。

这些节点不是人物的任务清单。人物只根据身体、状态、关系、私有知识、私有背包和局部环境可供性选择源自动作；里程碑在事后从世界事实、物质来源和跨月实践中派生。“正式覆盖”表示当前代码已有可裁决规则与闭合证据链，不表示每个文明都会经历该事件。

能力地图编号、名称和覆盖状态只能出现在事后观察器与文档中，不进入人物提示、需要强度或候选行动评分。人物看到的是身体状态、材料性质、同地人物和自己的有来源经验；例如观察器可以依据 `authorized=false + attempted=true + resistedBy` 判定一次偷盗未遂，但人物只经历一次具体取物与抵抗。当前没有 `bleeding`，所以第 103 项“止血”明确保留为守卫项，不会因为普通伤口治疗而误报；世界中也不存在名为“完成里程碑”的命令。

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

也可用 `THREEBODY_ENV_FILE` 指向包含 `KIMI_API_KEY` 的 env 文件。密钥是可选项：没有密钥、调用失败或返回非法建议时，后端仍由本地规划器完整提交月份。模型任务不会成为人物行动或世界时钟的前置条件。

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

启动长程演化任务。响应为 `202 Accepted`；服务逐月推进，每月完整执行 15 个本地规划刻度。世界物理、身体消耗、意图选择、动作修复和长期行动均由确定性规则完成。`/evolve` 当前不会自动调用模型；需要更自然的对话、记忆或历史表达时，可在事实提交后另行触发非权威增强旁车。

```bash
curl -X POST http://127.0.0.1:3220/api/runs/agriculture-01/evolve \
  -H 'content-type: application/json' \
  -d '{ "months": 120 }'
```

任务每 12 个月保存一次完整状态与演化路径；文明提前结束时立即保存。进程或 API 中断时，`evolution.json` 会标记 `failed` 并保留最近检查点。快速演化不会等待模型；完成后可另行提交非权威叙事增强任务。

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
- `POST /api/decide`：保留的 Kimi 决策兼容接口；当前前端与后端快速演化均不调用它。

## 前端

前端只保留两个全屏 3D 场景：三体宇宙与人间体素世界。页面打开后自动开始本地规则演化，当前只保留人物姓名签与左下角演化历史等少量情境信息。

交互优先通过场景本身完成，而不是依赖点击、按钮和菜单。三体宇宙与人间体素世界通过连续缩放进入和退出；其他交互也优先采用缩放、拖拽、聚焦、悬停、镜头运动、空间接近和环境反馈。常驻 UI、面板、导航与说明文字应尽量减少，只有无法通过自然交互清楚完成的操作才增加克制的显式控件，同时保留必要的键盘、触控与无障碍替代路径。

单独启动：

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm run backend:build
```

## 宇宙渲染（three.js）

宇宙场景默认由 three.js（WebGL）渲染：恒星球芯 + 加法混合辉光、UnrealBloom 泛光（高阈值防过曝）、顶点色渐隐轨迹线、深空近黑底色与若隐若现的星云。相机为可交互 3D 视角：拖拽旋转、滚轮缩放（不平移），松手 4 秒后恢复自动取景（约 22° 俯视与缓慢漂移）。向内滚动会自动聚焦行星并进入全屏 3D 人间；在人间持续向外缩小会返回宇宙。物理仍由 `src/lib/threebody.ts` 的 2D RK4 引擎驱动。

## 回放与演化

当前前端打开即自动走本地规则主链，每月执行 15 个规划刻度，不等待模型请求。Kimi 决策兼容模块与异步增强旁车仍保留，但不位于游戏时钟与月份提交链上。回放能力仍存在于领域与 API 层，但不再作为前端子页暴露。

文明演化程度使用 [文明指数 v1](../docs/civilization-index-v1.md)，不再使用平均健康伪装成的“文明完整度”。恒/乱纪元、月度天气、可验证预言、脱水休眠与动物生态见 [纪元、预言与生态 v1](../docs/three-body-era-ecology-v1.md)。多年份、多种子、必要时多次重复的验证方法见 [文明演化双闭环与实验协议 v1](../docs/evolution-iteration-loop-v1.md)。
