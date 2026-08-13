# Eland 像素世界模型 v1

状态：核心纵向切片已实现（84×52 权威网格、格上资源、逐格路径与多格住所）
范围：three-body 人间场景的权威空间模型  
关联：[社会演进模型](./social-evolution-model-v0.md) · [月度时间模型](./monthly-time-model-v1.md) · [空间行动契约](./spatial-action-contract-v1.md) · [历史与回放](./pixel-world-history-v1.md) · [硬切换方案](./pixel-world-migration-v1.md)

## 1. 决策

three-body 的人间世界采用 84×52 的二维权威网格。每个格子既是模拟中的空间单位，也是前端像素地图的事实来源。

“林缘缓坡”“河湾沃地”“市场”“住宅区”不再是世界预置的六个节点。前两类可以由自然地貌派生，后两类只能由人物长期行动与结构使用被观察器识别出来。

核心约束：

> 屏幕中的社会性对象必须来自权威网格；前端不能依据名字补造世界事实，人物也不能依据意图声明客观效果。

## 2. 为什么不是 Minecraft 式 3D 方块

本项目需要的是 Minecraft 的因果原则，而不是它的三维表现形式：

- 引擎只提供可组合的地形、物质、构件、运动和相互作用。
- 房子、道路、田地、聚落由组合和使用涌现。
- 名字是人对事实的解释，不是事实本身。

v1 继续使用俯视 2D 像素画。84×52 个格子足够表达当前 5–10 人的局部世界，同时不会把模拟成本推到体素级。一个格子是空间量子，不承诺等于一米；显示仍按每格 16 像素绘制。

## 3. 权威、派生与纯显示

| 层级 | 内容 | 能否改变世界 |
| --- | --- | --- |
| 权威事实 | 格子地形、环境量、物质栈、构件、实体位置、行动痕迹 | 能 |
| 引擎派生 | 可通行性、可供性、结构效果、连续道路、涌现区域 | 不能直接写回，只能由事实重算 |
| 人物解释 | 地点命名、用途理解、领地观念、地图知识 | 只改变人物认知与关系 |
| 纯显示 | tile 纹理、波纹帧、粒子、标签排布、阴影 | 不能 |

同一个事实可以有不同解释。例如一片被反复翻动、灌溉并收获的土地，观察器可以称为“耕作区”，某个人也可以称它为“我的田”；底层只保存格子变化和行动来源。

## 4. 世界边界

v1 固定为：

    width = 84
    height = 52
    cellCount = 4368
    topology = orthogonal-4
    renderTileSize = 16px

对角线可以用于显示，但寻路与邻接先采用四方向，避免穿角和拓扑歧义。未来若世界扩大，应由多个同规格区块组成，不改变格子契约。

格子使用稳定整数编号：

    cellId = y * width + x
    x = cellId % width
    y = floor(cellId / width)

事件、人物记忆和历史补丁只引用 cellId，不引用数组对象或前端坐标。

## 5. 权威数据结构

建议 SimulationState 在 schemaVersion 11 引入：

    interface PixelWorldV1 {
      version: 1
      width: 84
      height: 52
      generator: { version: string; seed: number }
      cells: CellLayers
      matter: MatterStack[]
      structures: StructureState[]
      traces: TraceLayers
    }

密集且定长的数据使用 TypedArray；对象、来源链和数量较少的实体使用稀疏数组。

当前 simulation.ts 的 clone 通过 JSON.stringify / JSON.parse 实现，会破坏 TypedArray 类型。阶段一必须同时把模拟内部克隆改为显式复制密集层（例如 layer.slice()）与结构化复制稀疏对象；不能先加入 TypedArray 再继续沿用 JSON clone。

### 5.1 基础地形层

    interface CellLayers {
      terrainKind: Uint8Array
      elevation: Int16Array
      fertility: Uint8Array
      waterDepth: Uint8Array
      surfaceCover: Uint8Array

      moisture: Uint8Array
      temperature: Int16Array
      vegetation: Uint8Array
      fire: Uint8Array
      ice: Uint8Array
      contamination: Uint8Array
    }

建议枚举：

- terrainKind：soil、rock、sand、clay、waterbed。
- surfaceCover：bare、grass、shrub、tree、crop、ash、snow。
- elevation：相对高度，使用固定整数单位。
- fertility、waterDepth、moisture、vegetation、fire、ice、contamination：0–100。
- temperature：相对温度定点值，避免浮点回放漂移。

基础地形不等于永远不变。挖掘可以改变 elevation 与 waterDepth，清理和耕作可以改变 surfaceCover、fertility 与 vegetation。

### 5.2 格上物质

自然资源和人物放置的可移动物质都落在具体格子：

    type MatterHolder =
      | { kind: "cell"; cellId: number }
      | { kind: "agent"; agentId: AgentId }
      | { kind: "structure"; structureId: string; slot: string }

    interface MatterStack {
      id: string
      kind: string
      name: string
      holder: MatterHolder
      quantity: number
      unitMass: number
      composition: Record<string, number>
      traits: MatterTrait[]
      sourceEventIds: string[]
    }

规则：

- 水源来自 waterDepth 或真实容器中的水，不再来自名为 river 的地点。
- 木材来自树木格、倒木或已搬运物质，不再固定刷新在河岸。
- 谷物来自作物格的生长与收获，不再挂在 field 节点。
- 同类物质只有 holder、成分和来源兼容时才可合并。

### 5.3 人物与动物

    interface SpatialEntity {
      cellId: number
      facing?: "n" | "e" | "s" | "w"
      footprint?: number[]
    }

人物、鹿和其他会影响行动的动物都必须有权威 cellId。飞鸟、萤尘等不参与规则的效果可以继续作为纯显示，但不得在 UI 中表现为可捕猎或可交互实体。

人物的 home 不再是初始地点 ID。它只能是：

- 本人记忆中偏好的格子或区域；
- 与真实住所结构有关的关系；
- 由反复休息和返回行为形成的解释。

### 5.4 构件与结构

结构不是一个格子上的“房子”物品，而是同一 structureId 下跨格排列的构件：

    type ComponentKind =
      | "foundation"
      | "support"
      | "floor"
      | "wall"
      | "roof"
      | "opening"
      | "hearth"
      | "container"
      | "instrument"

    interface StructureComponent {
      id: string
      structureId: string
      kind: ComponentKind
      cellId: number
      materialMatterIds: string[]
      integrity: number
      sourceEventIds: string[]
    }

    interface StructureState {
      id: string
      name?: string
      componentIds: string[]
      occupiedCells: number[]
      effects: StructureEffects
      useEventIds: string[]
    }

name 是建造者或后来使用者的命名，不参与效果计算。

结构效果每次由构件拓扑、材料和损坏状态重算：

    interface StructureEffects {
      structuralStability: number
      weatherProtection: number
      thermalInsulation: number
      enclosure: number
      capacity: number
      accessible: boolean
    }

住所的客观条件至少包括：

- 支撑与屋顶形成稳定连接；
- 屋顶覆盖可站立的内部格；
- 边界围合但保留可通行开口；
- 内部格可由人物实际进入；
- 天气防护达到阈值。

人物的建造计划只能表达意图，不能直接赋予 shelter。里程碑还必须引用人物进入和跨月休息的真实事件。

### 5.5 行动痕迹

格子保存可衰减或累计的事实痕迹：

    interface TraceLayers {
      traffic: Uint16Array
      rest: Uint16Array
      cultivation: Uint16Array
      care: Uint16Array
      trade: Uint16Array
      gathering: Uint16Array
      burial: Uint16Array
    }

每次增加痕迹都必须有对应事件。TypedArray 保存累计强度，事件日志保存谁、何时、为何产生。道路由连续的 traffic 高值格派生；市场、照护区、居住区同理，但需要参与者、时间跨度和用途条件，不能只看一次高值。

## 6. 涌现区域

区域是观察结果，不是模拟底座：

    interface EmergentRegion {
      id: string
      kind: "natural" | "residential" | "cultivation" | "exchange" | "care" | "memorial"
      cells: number[]
      confidence: number
      evidenceEventIds: string[]
      firstObservedTick: number
      lastObservedTick: number
      label?: string
    }

识别顺序：

1. 从相邻格的事实特征找连通分量。
2. 检查跨月持续、不同人物参与和真实使用；不同观察器可以要求不同最低月数。
3. 输出带证据的区域观察。
4. 人物可以知道、误解或重新命名它。

natural 区域可以由地貌直接派生；social 区域必须由历史活动派生。区域消失时不删除历史观察，只降低当前置信度或关闭有效期。

## 7. 世界生成

生成器在模拟端运行，种子只用于产生初始事实：

1. 生成 elevation。
2. 由地势生成水系与积水。
3. 由水分、坡度和土质生成 fertility 与 surfaceCover。
4. 在满足生态条件的格子生成植物、石材和动物。
5. 为人物选择可站立的初始 cellId。

生成结果进入 SimulationState 并随存档保存。前端不得凭 seed 再生成另一份地形，也不得为“地点锚点”清理森林或河流。

generator.version 必须随算法变化。旧存档读取自己的已存网格，不用新算法重建。

## 8. 前端渲染契约

SocietyState 应逐步改为：

    interface SocietyWorldView {
      width: number
      height: number
      revision: number
      cells: RenderCellLayers
      matter: RenderMatter[]
      structures: RenderStructure[]
      entities: RenderEntity[]
      regions: EmergentRegion[]
    }

SimulationState 内部可以使用 TypedArray；HTTP JSON 中的 RenderCellLayers 必须编码为普通数组或带类型与编码信息的传输结构。前端解码后再恢复 TypedArray，不能依赖 JSON 自动保留类型。

前端职责：

- 按 terrainKind、surfaceCover 和环境层选 tile。
- 按权威 cellId 绘制人物、动物、物质与构件。
- 按 trace 或派生道路绘制路径。
- 动画只改变同一事实的表现，不改变位置和数量。

前端禁止：

- 根据地点名字生成农田、小屋、市场或祭坛。
- 把一个地点的物质画到附近随机格，造成错误位置。
- 为视觉效果生成会被理解为真实资源的动物或建筑。
- 将直线连接地点锚点冒充人物走出的道路。

## 9. v1 不做的事

- 不做 3D 体素、地下多层或可旋转相机。
- 不做无限地图；先把 84×52 做成完整权威世界。
- 不让 LLM逐格寻路、直接改格子或决定结构客观效果。
- 不追求每秒实时模拟；一个月是最小权威时间步，帧间动画只负责表现。
- 不保留六地点兼容层：没有 LegacyRegionView、locationId、地点邻接图或地点锚点。
- 不读取或迁移 schemaVersion 10 存档；像素世界从新的 schemaVersion 11 文明开始。

## 10. 验收不变量

- 同一个月、同一种子、同一计划与行动历史得到逐格相同的世界。
- 任意屏幕上的可交互对象能追溯到 SimulationState。
- 任意资源消耗能追溯到具体 holder 和事件。
- 任意道路能追溯到实际通行过的 cellId 序列。
- 任意住所能追溯到构件拓扑、材料和使用事件。
- 改变对象名字不会改变其物理效果或里程碑判断。
- 移除前端程序化装饰后，世界事实仍完整存在。
- SimulationState 中不存在 homes、field、workshop、square、kitchen、river 六个语义空间 ID。
