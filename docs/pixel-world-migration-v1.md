# three-body 像素世界硬切换方案 v1

状态：设计冻结，下一步按阶段实现  
依据：[像素世界模型](./pixel-world-model-v1.md) · [月度时间模型](./monthly-time-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [历史与回放](./pixel-world-history-v1.md)

## 1. 决策

不保留六地点兼容区域，直接删除地点图。

第一次代码切换完成后，运行时不得再出现：

- `LocationState`、`LocationId`、`RouteState`、`INITIAL_ROUTES`。
- `homes`、`field`、`workshop`、`square`、`kitchen`、`river` 六个语义空间 ID。
- `AgentState.locationId`、`MatterHolder.kind = "space"`。
- 地点 neighbors、地点百分比坐标、地点锚点和地点间直线路径。
- `LegacyRegionView` 或任何从 cellId 反推旧地点的适配层。

schemaVersion 10 存档不迁移、不续演。像素世界以 schemaVersion 11 新文明重新开局。

## 2. 已核验的实际状态

| 范围 | 当前实现 | 硬切换后的处理 |
| --- | --- | --- |
| 权威空间 | 6 个 LocationState | 删除，改为 84×52 权威网格 |
| 人物位置 | AgentState.locationId | 替换为 position.cellId |
| 空间物质 | holder = space + LocationId | 替换为 holder = cell + cellId |
| 移动 | MoveAction.to + 地点图 BFS | 删除，改为 AgentPlan + 月度 A* 推进 |
| 道路 | RouteState 边 traffic | 删除，改为格子 traffic |
| 地面劳动 | 修改整个地点 terrain | 删除，改为修改目标格 |
| 结构 | 地点上的 construction 物质 | 删除，改为跨格构件 |
| UI 地形 | 前端根据 seed 生成 | 移到模拟端，前端只渲染 |
| UI 放置 | 围绕地点 anchor 摆放 | 改为权威 cellId |
| 时间 | 一年一个 tick、人物固定做一次关键行动 | 一月一步、概率决策、计划跨月推进 |
| 历史 | 地点级事件与逐年完整快照 | 新文明开始记录月度格子事件与补丁 |

可保留的非空间基础：

- GameFrame 的 runId、文明年、宇宙时间和天象契约。
- 按 runId 隔离的服务端会话。
- 人物档案、身体、马斯洛需求、关系、局部记忆和来源链。
- 物质成分、能力和客观身体效果的规则。
- “名字和意图不能直接产生客观效果”的原则。

空间字段进入上述对象时必须改写，不能包一层旧接口继续使用。

## 3. 硬切换原则

1. cellId 是唯一空间权威，没有第二套位置。
2. 新代码不得读取或生成六个旧 ID。
3. 不追求第一版立即恢复所有里程碑；允许暂时缩小功能面，但保留下来的行为必须是真实格子行为。
4. 不用占位地点维持旧测试通过；旧地点测试删除或改写。
5. 每个提交阶段都应能构建和运行，但不要求与 schemaVersion 10 功能等价。
6. 先贯通“月度决策 → 跨月行走 → 木材 → 建造 → 休息”，再迁回其他社会能力。

## 4. 阶段一：删除地点图，建立可运行的网格内核

目标：完成空间模型断代。阶段结束时，游戏可以从新文明开局，人物在自然网格中移动、取水、取食和取得木材；不存在地点兼容代码。

### 4.1 权威世界

- 新建 `world/grid.ts` 和 `world/generator.ts`。
- 定义 `PixelWorldV1`、`CellLayers`、cellId 索引与邻接。
- 模拟端用 seed 生成 84×52 初始地形、水系、植被、肥力与资源。
- SimulationState 升到 schemaVersion 11。
- 替换当前 JSON stringify / parse 克隆；TypedArray 用 slice，稀疏对象做结构化复制。
- API 为密集层定义明确 JSON 编码，客户端解码为 TypedArray。
- 时间权威改为 elapsedMonths；删除年度 tick 和独立 civilizationYear 状态。
- 年龄、妊娠、疾病、预测期限与记忆时长统一改用月数。
- `stepYear`、年度 frame/seek 参数和年度播放循环改为 `stepMonth`、atMonth 与月度播放缓冲。
- 月度史册使用规则模板；现有总结模型只在每完成 12 个月时调用一次。

### 4.2 直接删除旧空间

- 删除 `LOCATIONS` 常量及其六个 ID。
- 删除 `LocationState`、`LocationId`、`RouteState` 和路线生成函数。
- 删除 `AgentState.locationId` 与 `body.homeLocationId`。
- 人物只保存 `position.cellId`；“家”以后从记忆、结构关系和反复返回派生。
- 删除 `MatterHolder.kind = "space"`；自然物质必须落在具体 cell。
- 删除 `location()`、`matterAt(locationId)`、`nextLocation()` 等地点帮助函数。
- 删除 `Action.where: LocationId` 和 `EnvironmentFact.where: LocationId`，统一记录 cellId 或受影响 cells。
- 删除旧 `SocietyState.locations`、`routes` 和索引式 `agent.loc`。

### 4.3 同步建立最小空间行动

地点图删除后，不能用瞬移占位。阶段一同时引入：

- `position.cellId`。
- 基础局部视野。
- 引擎生成的饮水、采食、采木与探索 affordance。
- 受限 PlanDecision 与 AgentPlan。
- 每人每月的确定性关键决策概率。
- 确定性 A* 和月度移动/工作预算。
- active plan 在没有新决策时仍逐月推进。
- 同格采集、饮水、进食、放下物质。
- 月度 PlanProgressFact、实际 path segment 和逐格 traffic。

暂未迁移的行动不进入决策候选，也不保留地点版实现。

### 4.4 开局人物与资源

- 人物初始位置从可站立格中按 seed 确定，不能按人格映射到预设功能地点。
- 水由 waterDepth 和可饮用性决定。
- 木材来自树木或倒木格；采集会改变 vegetation/surfaceCover。
- 食物来自真实植物、动物或人物携带物。
- 石、黏土、纤维按地质与生态条件生成。
- 初始工具若继续保留，必须在具体人物持有或具体格子上，并有明确开局来源。
- 不预置热食、工坊、田地、市场、住宅等社会成果。

### 4.5 前端同时切换

- `SocietyMap` 只消费 `SocietyWorldView`。
- `pixelworld.ts` 只保留 tile、sprite 和动画绘制，不再生成世界。
- 删除 locations anchor、selectedLoc、地点标记和地点资源簇。
- 人物、物质和可交互动物严格按 cellId 绘制。
- 路径严格按 traffic 格绘制。
- 天气粒子、波纹和阴影可以保留，但不产生可交互事实。
- Game 页面显示“第 N 年 · M 月”，历史滑杆和回放索引使用 elapsedMonths。
- 自动播放缓存连续的 MonthFrame；快进也必须依序播放或应用每个月的 path/progress patch，不能只跳到批次末月。

### 4.6 阶段一完成条件

- 全项目搜索不到六个旧空间 ID；人物档案文本或历史说明中的普通中文不在此限制内。
- 全项目搜索不到 `LocationState`、`locationId`、`RouteState`。
- 前端删除 `genWorld(seed, locations)` 后仍能显示完整世界。
- 人物可以沿真实格子路径找到并取得水、食物和木材。
- 地形、人物、资源和 path 在服务端与画面逐格一致。
- 同种子和同一行动序列生成相同状态。
- 没有新模型调用的月份，长期计划仍能产生可见进度。
- 任意连续 12 月的模型上下文和 token 不超过旧年度预算。
- schemaVersion 10 输入得到明确的不支持错误，不被自动修补。

## 5. 阶段二：跨格结构与真实住所

目标：贯通首个完整社会性纵向切片。

### 5.1 建造模型

- 定义 `StructureState` 和 `StructureComponent`。
- 新建造不再使用 `MatterState.construction`。
- 删除 assemble 的 siteId、purpose 和四个抽象 arrangement 数值。
- 改为在目标 cell 放置 foundation、support、floor、wall、roof、opening 等构件。
- 引擎检查占格、材料、承重、连通、围合、开口和可达内部格。
- 结构效果由拓扑、材料和损坏状态重算。

旧结构不迁移。阶段二只处理 schemaVersion 11 中真实发生的新建造。

### 5.2 使用与观察

- 人物必须走进结构内部格才能休息。
- 防护和恢复只读取当前结构客观效果。
- 每次使用写入 useEventId 与 rest trace。
- 住所里程碑要求有效结构、真实进入和至少两个不同年份的休息。
- 居住区域由结构、休息和返回痕迹观察得出，不是预置地点。

### 5.3 阶段二完成条件

- 树木格 → 木材 → 跨月搬运 → 多格构件 → 客观防护 → 跨月休息完整可追溯。
- 名为“房子”的开放平台不是住所。
- 没有名字但拓扑有效的围护结构可以提供防护。
- 拆除关键构件会降低或取消结构效果。
- UI 按真实构件逐格显示建设过程。

## 6. 阶段三：迁回社会能力，形成涌现区域

目标：把仍有价值的旧能力逐项改写为网格规则。不是恢复地点模型。

### 6.1 迁回顺序

1. 照护、分享、交换和关系互动的同格约束。
2. 火、烹饪、容器与储藏。
3. 挖掘、水流、灌溉、作物生长和收获。
4. 动物移动、捕猎、照料与驯化。
5. 记录、度量、地图、历法和仪器。
6. 埋葬、纪念、文化活动和社会观察器。

每迁回一类行为，都必须删除其旧语义地点假设，不允许出现“先找 river/field/square”的规则。

### 6.2 旧假设的替代依据

| 被删除的旧假设 | 新依据 |
| --- | --- |
| river 提供水、木、石、芦苇 | waterDepth、地质、植被和 MatterStack |
| field 可以耕作 | 土质、肥力、水分、种子、作物和工具 |
| square 会形成市场 | 交换痕迹、不同参与者与跨月持续 |
| homes 有动物或适合居住 | 动物实体、地形、结构和实际使用 |
| workshop 适合制造 | 工具、材料、平整空间和重复加工 |
| kitchen 有热食 | 火、燃料、容器、食物和烹饪事件 |

### 6.3 涌现区域

- natural：林地、水域、石脊、湿地。
- cultivation：连续耕作、灌溉、作物与收获。
- residential：有效住所、休息、返回和多人跨月使用。
- exchange：不同人物重复交换。
- care：不同照护者、对象和改善结果长期汇聚。
- memorial：遗体处理、标记和纪念活动。

区域只是带证据的观察结果。点击区域可以显示来源，但标签不写回底层格子，也不成为行动特权。

### 6.4 阶段三完成条件

- 当前需要保留的里程碑均使用格子事实和事件来源。
- 没有规则依据区域标签赋予物理或社会效果。
- 同一类社会区域可以在任何满足条件的格子群涌现。
- LLM 只接收局部可见、记忆目标和引擎可供性。

## 7. 历史实现穿插点

- 阶段一从 month 0 写入 schemaVersion 11 网格检查点、DecisionFact、PlanProgressFact 和 WorldDelta。
- 阶段二加入 component/structure patch。
- 阶段三加入 EmergentRegion observation delta。
- 全链稳定后，把 ElandSession 的完整月快照改成每 240 月检查点加月度补丁。
- `seek` 最终创建新分支，不再删除原未来。

不存在 schemaVersion 10 → 11 的空间迁移步骤。

## 8. 第一条纵向切片

    自然树木格
    → 某月人物局部发现并作出关键决策
    → 计划沿真实路径跨月移动
    → 取得木材
    → 每月路径留下 traffic
    → 建造计划逐月放置多格构件
    → 结构获得客观防护
    → 人物进入并在不同月份休息
    → 观察器识别居住区域
    → 前端逐格展示

阶段一完成前五步，阶段二完成后五步。阶段三再恢复其他社会活动。

## 9. 建议代码落点

    src/game/eland/world/grid.ts
      网格类型、索引、邻接、密集层操作

    src/game/eland/world/generator.ts
      确定性初始世界生成

    src/game/eland/world/perception.ts
      视野、记忆目标、可供性

    src/game/eland/world/pathfinding.ts
      成本与确定性 A*

    src/game/eland/world/structures.ts
      构件放置、拓扑与效果

    src/game/eland/world/regions.ts
      道路和涌现区域观察器

    src/game/eland/world/history.ts
      checkpoint、delta、恢复

    src/game/societyContract.ts
      API 只读世界视图

    src/components/SocietyMap.tsx
      权威世界的无规则渲染器

## 10. 不采用的做法

- 把六地点扩成更多地点。
- 保留隐藏的 locationId、锚点或区域适配器。
- 把旧存档的地点事实猜测成逐格事实。
- 让前端决定资源、动物或结构的实际位置。
- 给结构增加 footprint 图片，但规则中仍只占一个抽象点。
- 让名字、purpose 或 LLM 输出决定客观效果。
- 让 LLM 输出逐格路径或结构评分。
- 为了回放每月永久复制完整网格。

## 11. 风险与接受的代价

硬切换会暂时失去一部分已经实现的社会里程碑和长程模拟稳定性。这个代价是明确接受的：旧规则建立在错误的空间底座上，维持其运行会迫使新网格继续服从六地点。

应保留的是非空间因果规则和证据标准，不是旧空间接口。能力恢复以阶段三清单为准。

## 12. 适量验证

遵循项目约束，不铺设大规模 CI：

- 一个生成确定性测试。
- 一个月度决策预算与无决策继续执行测试。
- 一个寻路与中途停留测试。
- 一个“无旧空间 ID”静态检查。
- 一个木材到住所再到休息的纵向模拟测试。
- 一次 build。
- 一次本地人间地图目视核验。

不扩展无关测试、部署或安全基础设施。
