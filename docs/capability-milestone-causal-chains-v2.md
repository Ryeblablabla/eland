# Eland 能力里程碑因果链目录 v2

> 定义版本：`capability-causal-v2`。本目录依据《Eland 人类社会活动一千项能力地图》和当前 `capability-milestones.ts` 整理。它描述观察器现在能怎样分类证据，不描述任何一次模拟已经自然发生了什么。

## 1. 边界与读法

这是一份**观察器分类目录**，不是人物科技树、文明升级路线、任务清单或解锁顺序。人物不读取地图编号、里程碑定义、效价或阶段，也不应为了提高观察指标而行动。下文的箭头只帮助审计因果证据；它们不是强制前置关系。编号大的坐标可以先出现，任何坐标也可以不出现、反复出现、衰退、消失或重建。

本目录只陈述两种实现状态：

- `strict`：代码已有结构化探针。只有可回放事件构成完整 episode、满足阶段门槛、且所有 `evidenceEventIds` 都能在世界历史中解析时，观察器才可产出 milestone。`strict` 的含义是“当前可严格观察”，**不是“当前世界已经达成”**。
- `guarded`：当前结构化事实不足以证明地图标签的完整语义；探针固定返回空数组，不产生 `achieved`。代码为这类条目暂填 `ambivalent · emergence · guarded`，这只是保守默认值，不是对该社会活动的价值或真实阶段作结论。

效价与阶段是两组彼此独立的观察维度：

| 维度 | 值 | 本目录中的含义 |
| --- | --- | --- |
| 效价 | `constructive` | 该条当前探针记录建设、照护、合作、修复或能力形成的一面；不保证每个实例都无害。 |
| 效价 | `harmful` | 该条当前探针要求损伤、剥夺、失信、散失或崩解事实；不能折算成中性“成就点”。 |
| 效价 | `ambivalent` | 生老死、迁徙、拒绝、授权等后果取决于处境、同意、分配与解释，观察器不预先美化或贬低。 |
| 阶段 | `emergence` | 有来源的首次形成或状态出现。 |
| 阶段 | `practice` | 有可执行实践证据；除非另有门槛，不自动等于长期重复。 |
| 阶段 | `stable` | 达到跨 episode、月份、人物或证据事件的稳定门槛。 |
| 阶段 | `harm` | 已出现可归因损害。 |
| 阶段 | `decline` | 关系、判断或组织能力正在退出、失效或减弱。 |
| 阶段 | `collapse` | 人、项目、共同体或知识连续性发生终止或崩解。 |
| 阶段 | `recovery` | 在先前损害、失败或退出之后出现有来源恢复。 |
| 阶段 | `response` | 面对既有危险、疾病、盗窃企图等压力采取可归因应对。 |

除 `stable` 外，当前默认门槛为 1 个 episode、1 个不同月份、0 个最低行动者、1 个证据事件；默认 `stable` 门槛为 2 个 episode、2 个不同月份、1 个行动者、2 个证据事件。以下稳定项有显式覆盖：

| 定义 | 最少 episode | 最少月份 | 最少行动者 | 最少证据事件 |
| --- | ---: | ---: | ---: | ---: |
| `capability:7:stable:repeated-care:v2`、`capability:148:stable:fire-practice:v2`、`capability:222:stable:trial-learning:v2` | 1 | 2 | 1 | 2 |
| `capability:3:stable:dependent-care:v2` | 2 | 2 | 1 | 2 |
| `capability:22:stable:joint-project:v2`、`capability:161:stable:companion:v2`、`capability:244:stable:shared-record:v2` | 1 | 2 | 2 | 2 |
| `capability:405:stable:joint-project:v2` | 2 | 3 | 2 | 3 |
| `capability:524:stable:decision-rule:v2` | 1 | 1 | 2 | 2 |
| `world:era-prediction-practice:stable:prediction-practice:v2` | 1 | 2 | 1 | 2 |
| `world:era-cycle:stable:era-cycle:v2` | 1 | 2 | 0 | 2 |

表中的“当前定义 ID”是运行时精确 ID；“地图坐标”保留原地图标签。星号 `*` 表示 guarded 条目使用代码默认效价/阶段，不能作语义推断。

## 2. 十四个因果家族

### 家族 1：生命循环、亲族、伴侣与同意

可能的证据路径：出生或生殖约定（`emergence`）→ 有来源的亲子/伴侣关系 → 持续照护（`stable`）；危险可引出保护（`response`），衰老或关系拒绝可形成 `decline`，死亡形成 `collapse`。死亡后还可由知情人物真实挖墓、入葬、覆土并以实体材料留下墓记，形成独立的建设性实践。以上都是可分叉、可中断的观察路径，不是人生脚本。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `1 诞生` | `capability:1:emergence:birth:v2` | `ambivalent · emergence` | `strict · birth`：出生结算保存新生儿与父母，人物状态中的 `geneticParents` 必须一致。 |
| `2 繁衍后代` | `capability:2:emergence:conception:v2` | `ambivalent · emergence` | `strict · conception`：普通路径先有双方有效生殖协议，魅魔路径保存 `succubus-unilateral` 单方授权；随后均要求完成的 `reproduce` 且 `conceived=true`。 |
| `3 养育幼儿` | `capability:3:stable:dependent-care:v2` | `constructive · stable` | `strict · dependent-care`：未独立儿童与照护者有亲子/照护关系，并有携带、物资转移或脱水协助；再过稳定门槛。 |
| `4 结成家庭与亲族` | `capability:4:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：出生亲缘事实还不足以证明家庭组织已经形成。 |
| `8 衰老` | `capability:8:decline:aging:v2` | `ambivalent · decline` | `strict · aging`：人物进入衰老压力年龄，月度结算写入有来源 `aging` 条件。 |
| `9 死亡` | `capability:9:collapse:death:v2` | `ambivalent · collapse` | `strict · death`：身体或寿命结算写入人物、原因和来源明确的死亡事实。 |
| `10 埋葬并纪念死者` | `capability:10:practice:burial-memorial:v2` | `constructive · practice` | `strict · burial-memorial`：同一遗体先由近身动作挖墓、放置并用该次挖掘产生的同材质覆土完成安葬；随后真实消耗 `WoodTablet` 并使用合格工具留下墓记。死亡、安葬和墓记事件必须互相引用，单有遗体、土坑或表现层墓碑均不成立。 |
| `161 表达爱慕与建立伴侣关系` | `capability:161:stable:companion:v2` | `constructive · stable` | `strict · companion`：面向具体人物的伴侣提议被接受，并保存稳定共同生活地点；双方在同一生活区域累计满跨月门槛，不要求体素坐标重合。 |
| `162 拒绝或结束亲密关系` | `capability:162:decline:relationship-rejection:v2` | `ambivalent · decline` | `strict · relationship-rejection`：具体 `companion` 或 `reproduce` 提议被目标明确拒绝，未形成有效关系约定。 |
| `165 确认或争议亲子身份` | `capability:165:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：出生事实与 `geneticParents` 一致只能证明生物亲缘，不能证明人物或共同体完成了身份确认，更不能覆盖争议支路。 |
| `168 分配父母与照护责任` | `capability:168:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：照护动作不足以证明责任已经协商和分配。 |
| `169 保护儿童免受伤害` | `capability:169:response:dependent-protection:v2` | `constructive · response` | `strict · dependent-protection`：乱纪元危险中，完成动作明确记录受助或被携带儿童，并核验依赖年龄与照护关系。 |
| `171 防止或制止家庭暴力` | `capability:171:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般保护或一般暴力事实不能证明“家庭暴力”关系和制止结果。 |
| `604 确认亲密关系中的同意` | `capability:604:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：生殖/伴侣约定尚不能覆盖该坐标全部亲密同意语义。 |

### 家族 2：身体异常、疾病、照护与脆弱性

可能的证据路径：身体异常或疾病（`emergence`，可为 `harmful`）→ 针对具体患者的处置（`response`/`practice`）→ 跨月持续照护（`stable`）；临终照护是对既有死亡风险的 `response`，不是把死亡本身计作建设性结果。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `5 生病` | `capability:5:emergence:illness:v2` | `harmful · emergence` | `strict · illness`：身体结算写入患者与月份明确、尚未退出的 `illness` 条件。 |
| `6 医治伤病` | `capability:6:response:care:v2` | `constructive · response` | `strict · care`：目标先有伤病来源，照护动作消耗材料并保存 `caredPersonId` 或身体阶段变化。 |
| `7 照料弱者` | `capability:7:stable:repeated-care:v2` | `constructive · stable` | `strict · repeated-care`：同一受照护者有至少两次真实照护，且稳定门槛要求跨月证据。 |
| `101 识别疼痛与身体异常` | `capability:101:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：身体条件出现不等于人物已识别异常。 |
| `103 处理伤口并止血` | `capability:103:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：通用照护尚不能证明伤口处理与止血的精确后果。 |
| `106 使用草药与经验性药物` | `capability:106:practice:herbal-care:v2` | `constructive · practice` | `strict · herbal-care`：真实生产并持有的草药被消耗于具体伤病，且身体状态发生变化。 |
| `108 照护慢性病患者` | `capability:108:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：尚无慢性病持续期与相应照护链的完整结构化证明。 |
| `113 比较疗法并淘汰无效做法` | `capability:113:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一次治疗或一般试验不能证明疗法比较和淘汰。 |
| `119 提供临终照护` | `capability:119:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：当前没有照护前可感知的终末风险、恶化预后或临终照护意图；未来死亡不能反向把普通照护改写成临终照护。 |
| `132 为病弱者准备特殊饮食` | `capability:132:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：食物转移尚不能证明“为病弱状态定制”的饮食。 |
| `881 识别无法依靠自身维生者` | `capability:881:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：依赖状态或援助行为不能替代人物作出识别的证据。 |

### 家族 3：食物、水、农作、配给与生态约束

可能的证据路径：饥渴或季节压力 → 识别、采集、捕猎、耕作（`practice`）→ 加工、喂养、储藏与交换知识；失败支路可进入饥荒 `harm`。狩猎是 `ambivalent`，因为结果同时涉及生存收益、动物损害与生态后果。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `11 采集食物` | `capability:11:practice:gather-food:v2` | `constructive · practice` | `strict · gather-food`：可食地面掉落物经完成的转移动作进入具体人物库存。 |
| `12 捕猎动物` | `capability:12:practice:hunt:v2` | `ambivalent · practice` | `strict · hunt`：`hunt` 指向真实动物，完成后保存 `killed=true` 与动物产物。 |
| `18 烹饪食物` | `capability:18:practice:cooking:v2` | `constructive · practice` | `strict · cooking`：生食与真实火体素参与 `expose`，完成后产出 `CookedFood`。 |
| `32 栽培作物` | `capability:32:practice:cultivation:v2` | `constructive · practice` | `strict · cultivation`：种子与肥沃地表结合生成作物，自然生长后再由真实 `separate` 收获。 |
| `34 储藏剩余粮食` | `capability:34:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般食物入容器不能证明它是“剩余粮食”及其跨期储藏目的。 |
| `35 管理水源` | `capability:35:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：取水、饮水或协助找水不足以证明持续水源管理。 |
| `36 遭遇饥荒` | `capability:36:harm:famine:v2` | `harmful · harm` | `strict · famine`：身体事实记录 `nutrition < 10` 的严重营养伤害，且至少两名人物在同一起点至后续 2 个月的短窗内受害。 |
| `121 辨认可食与有毒之物` | `capability:121:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：取得并摄入食物的后果仍不足以覆盖“可食/有毒辨认”的完整对照。 |
| `122 寻找并净化饮水` | `capability:122:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：当前可观察找水/饮水，但不能严格证明净化。 |
| `126 研磨、切割与混合食材` | `capability:126:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：通用材料操作未形成针对食材和三类加工语义的完整证据。 |
| `131 喂养婴幼儿` | `capability:131:practice:infant-feeding:v2` | `constructive · practice` | `strict · infant-feeding`：完成的食物转移指向未独立儿童，行动者为父母或动作保存明确照护来源。 |
| `134 交换食谱与烹饪技术` | `capability:134:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般技术教学不能证明内容是食谱或烹饪技术。 |
| `341 选择和保存种子` | `capability:341:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：种植和一般储藏不足以证明选种与留种。 |
| `824 限制狩猎、采集与捕捞` | `capability:824:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：捕猎事实不能证明形成或执行了资源限制。 |

### 家族 4：材料、工具、火、容器与工艺

可能的证据路径：材料来源 → 物质操作 → 工具/火/衣物/绳/容器产出（`practice`）→ 跨月维护或使用（`stable`）；质量、秘密以及可持续配额/权限等更高语义仍需独立事实。普通木材与植物分离只证明采集，不能自动升级成“管理森林采伐”。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `16 制造工具` | `capability:16:practice:tool-craft:v2` | `constructive · practice` | `strict · tool-craft`：真实输入材料参与 `combine`，完成事实明确产出工具类材料。 |
| `17 掌控火种` | `capability:17:practice:fire-making:v2` | `constructive · practice` | `strict · fire-making`：真实工具和燃料参与 `exert`，完成后生成火体素。 |
| `19 制作衣物` | `capability:19:practice:clothing:v2` | `constructive · practice` | `strict · clothing`：纤维或兽皮参与 `combine`，完成后产出衣物或兽皮衣。 |
| `148 维护炉灶与火源` | `capability:148:stable:fire-practice:v2` | `constructive · stable` | `strict · fire-practice`：火在至少两个不同月份被制造或使用，且相关动作共享火材料输入/输出。当前不单独证明“炉灶”。 |
| `321 选择适合用途的材料` | `capability:321:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：成功制作不能反推人物曾比较并选择材料。 |
| `322 切割、打磨与钻孔` | `capability:322:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：森林材料的 `separate` 不能证明切割、打磨与钻孔这些精确加工动作。 |
| `324 编织、缝合与制绳` | `capability:324:practice:rope-craft:v2` | `constructive · practice` | `strict · rope-craft（窄证据）`：纤维等真实输入经 `combine` 产出 `Rope`；不自动证明编织和缝合分支。 |
| `325 制作陶器与容器` | `capability:325:practice:container-practice:v2` | `constructive · practice` | `strict · container-practice（窄证据）`：先制作带 `containerId` 的实体容器，随后对同一容器完成存取；不自动证明材质为陶。 |
| `335 保守或分享工艺秘密` | `capability:335:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般技术传播不能证明秘密、保密或有意分享。 |
| `337 检查产品质量` | `capability:337:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般 `attend` 或成功产出不能证明质量标准与检查结论。 |
| `354 管理森林采伐` | `capability:354:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：需要林区资源状态、限采/轮采/保护规则和再生或库存后果；两次普通采集不足以证明“管理”。 |

### 家族 5：住所、设施、定居与日常恢复

可能的证据路径：环境压力与选址 → 完整功能住所（`emergence`）→ 使用、共享、维护与定居；损坏支路可进入中断，再由重建进入 `recovery`。当前只有功能住所本身具 strict 闭环，其余不能从建筑体素或停留行为中强推。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `20 建造住所` | `capability:20:emergence:shelter:v2` | `constructive · emergence` | `strict · shelter`：多次有来源建造形成标记完成、具内部空间、容量与防护的结构。 |
| `33 定居村落` | `capability:33:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：完整住所或持续停留还不足以证明“村落”及其定居连续性。 |
| `141 选择安全的居住地点` | `capability:141:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：住所建成不能反推行动者比较过风险并完成安全选址。 |
| `143 取暖、降温与通风` | `capability:143:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：火源或住所防护不能分别证明取暖、降温和通风功能。 |
| `147 修补住所` | `capability:147:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：建造动作尚未可靠区分新建与对既有住所的修补。 |
| `150 与邻居共享设施` | `capability:150:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：多人使用相近格子或容器不能证明邻里关系与共享规则。 |
| `160 在住所毁坏后重建日常生活` | `capability:160:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：缺少“原住所毁坏 → 生活中断 → 重建后恢复”的同一因果链。 |

### 家族 6：迁徙、灾害、道路、路线与物流恢复

可能的证据路径：危险或资源缺口 → 移动/逃亡 → 路面和路线实践 → 有边界物流 episode → 仓储与供应链；阻断可进入 `harm`/`collapse`，恢复流通可进入 `recovery`。移动量本身不等于迁徙，物流动作也不等于路线规划。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `14 迁徙远方` | `capability:14:practice:migration:v2` | `ambivalent · practice` | `strict · migration`：同一人物在同一 intent/project 下、相邻移动间隔不超过 2 月，至少 3 次移动跨 2 个月、覆盖 12 格且净位移达到 10；跨门槛后还需隔月至少一次在目的地两格内活动。 |
| `15 应对自然灾害` | `capability:15:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：代码虽能看到天气/乱纪元与若干随后行动，但当前目录未把它注册为该广义地图坐标的 strict 证明。 |
| `42 开辟道路` | `capability:42:practice:road:v2` | `constructive · practice` | `strict · road`：真实完成动作产生 `PackedSoil` 材料变化，且至少四个水平相邻格连成同一可回放通行带。 |
| `384 规划路线与行程` | `capability:384:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：项目 search/drop 物流 episode 不能证明人物制定了路线与行程。 |
| `390 装卸、仓储与分拣货物` | `capability:390:practice:storage:v2` | `constructive · practice` | `strict · storage（窄证据）`：实体容器有位置和来源，物资完成存入或取出；不单独证明“分拣”。 |
| `392 协调跨地域供应链` | `capability:392:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：单项目物流不足以证明跨地域、多节点和协调连续性。 |
| `393 应对道路阻断与运输延误` | `capability:393:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：物流耗尽/失效不能自动归因为道路阻断或运输延误，也未证明应对成功。 |
| `400 在运输系统崩溃后恢复流通` | `capability:400:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：缺少同一运输系统的先前崩溃与后续恢复闭环。 |
| `705 因战争、迫害或灾害逃亡` | `capability:705:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：长距离移动不能证明战争、迫害或灾害是其有来源原因。 |
| `736 规划步行、自行车与公共交通` | `capability:736:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：当前移动系统未形成三类交通方式及规划语义的结构化证据。 |
| `841 识别自然与人为危险` | `capability:841:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：危险事件发生或人物躲避不等于人物已识别并区分危险来源。 |

### 家族 7：语言、记录、记忆、档案与信息保护

可能的证据路径：表达 → 手势或文字载体（`emergence`/`practice`）→ 个人记忆与多人共享记录（`stable`）→ 代际传递；销毁、遗忘或载体断裂可进入 `decline`/`collapse`，教学和保存项目可构成未来 `recovery`。记录存在不等于内容真实。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `21 创造语言` | `capability:21:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：结构化沟通证明一次表达，不证明语言系统被创造。 |
| `24 讲述并传承往事` | `capability:24:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：记忆或沟通尚不能证明内容是往事且完成传承。 |
| `51 创造文字` | `capability:51:emergence:writing:v2` | `constructive · emergence` | `strict · writing（操作性口径）`：知识写入带 `recordPayloadId` 的实体载体，且另一人物取得并读懂同一 payload。 |
| `201 用手势传达意图` | `capability:201:practice:gesture-communication:v2` | `constructive · practice` | `strict · gesture-communication`：`communicate` 明确使用手势渠道，并有至少一名不同人物处于实际 audience。 |
| `239 让知识在代际传递中改变` | `capability:239:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：跨代共同持有知识仍不足以证明内容发生了变化。 |
| `240 在学校或知识体系崩解后恢复教学` | `capability:240:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：缺少学校/知识体系先崩解、教学后恢复的同一历史链。 |
| `241 记住个人经历` | `capability:241:practice:memory:v2` | `ambivalent · practice` | `strict · memory`：人物记忆保存可解析 `sourceEventIds`，来源是亲历、对话、承诺或失败事实。 |
| `244 形成集体记忆` | `capability:244:stable:shared-record:v2` | `constructive · stable` | `strict · shared-record（操作性口径）`：同一实体记录 payload 被至少两名不同人物写入或读懂，并过双人、跨月门槛。 |
| `248 保存信件、器物与影像` | `capability:248:practice:physical-record:v2` | `constructive · practice` | `strict · physical-record`：记录有真实 completed 创作来源，至少 12 个月后同一 payload 载体仍在人物库存、地面或容器中；刚写完不能自证“保存”。 |
| `252 隐瞒、销毁或篡改记录` | `capability:252:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：记录缺失或内容变化不能证明隐瞒、销毁或篡改的行动与责任者。 |
| `420 在组织解体后保存关键技能` | `capability:420:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：知识保存项目不能自动证明组织先解体，亦不能证明被保存技能“关键”。 |
| `805 加密通信与保存信息` | `capability:805:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：记录或通信载体不等于加密。 |
| `949 档案和专业知识散失` | `capability:949:collapse:technique-loss:v2` | `harmful · collapse` | `strict · technique-loss（专业知识支路）`：历史上存在可靠技术，每一名历史可靠持有者都有可解析死亡事实；episode 证据由技术获得来源与全部持有者死亡事实组成。只有最后持有者死亡后，且当前无存活可靠持有者、无同知识实体记录载体，才判定散失。当前不单独证明一般档案散失。 |

### 家族 8：观察、试验、学习、算法与技术恢复

可能的证据路径：面向真实对象的观察（`practice`）→ 物质试验 → 主动核验 → 跨月试错学习（`stable`）→ 教学、记录或程序化；技术失传后再获得应是 `recovery`，但地图 799 目前仍 guarded，不能因存在同名内部 detector 就宣称已可观测。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `23 教育下一代` | `capability:23:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般教学尚不能同时证明受教者代际身份、教育目的与知识获得。 |
| `58 观察自然现象` | `capability:58:practice:natural-observation:v2` | `constructive · practice` | `strict · natural-observation`：完成的 `attend` 指向真实动物、体素或自然掉落物，并保存观察者与对象。 |
| `59 用实验检验猜想` | `capability:59:practice:tested-hypothesis:v2` | `constructive · practice` | `strict · tested-hypothesis`：可靠技术知识同时引用真实物质试验和 `understood/verified` 主动核验。 |
| `222 通过试错掌握技能` | `capability:222:stable:trial-learning:v2` | `constructive · stable` | `strict · trial-learning`：可靠技术知识引用至少两次真实物质试验，且稳定门槛要求证据跨月。 |
| `799 恢复失传技术` | `capability:799:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：当前虽有未注册到该坐标的 `technique-recovery` 检测代码，但目录定义仍使用 `guarded`，因此不会产出该地图 milestone。 |
| `802 设计算法处理重复任务` | `capability:802:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：重复动作或本地规划规则不能证明世界内人物设计了算法。 |

### 家族 9：协同行动、劳动分工与项目闭环

可能的证据路径：局部需要和触发事实 → 持久项目 → 多人贡献与物流 → 功能完成（`stable`）→ 角色或分工；失败支路可进入项目 `collapse`，同一项目后来完成才可记 `recovery`。参与人数或动作量本身不等于协同成功。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `22 协同行动` | `capability:22:stable:joint-project:v2` | `constructive · stable` | `strict · joint-project`：同一项目由至少两名贡献者行动并以真实 `completionEventIds` 闭合功能目标；要求双人、跨月证据。 |
| `38 实行专业分工` | `capability:38:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一次多人项目或任务差异不足以证明持续专业角色。 |
| `401 分派临时任务` | `capability:401:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：项目任务存在不等于某人向他人作出可接受、可追溯的分派。 |
| `405 协调团队工作流程` | `capability:405:stable:joint-project:v2` | `constructive · stable` | `strict · joint-project（重复项目口径）`：与坐标 22 使用同类多人完成项目 episode，但要求至少 2 个 episode、跨 3 个月、2 名行动者和 3 个证据事件，明确高于坐标 22；仍不单独证明流程设计文本。 |

### 家族 10：交换、财产、契约、信誉与信用恢复

可能的证据路径：持有和边界 → 赠与/要约 → 接受形成约定（`emergence`）→ 双向履约交换（`practice`）→ 重复信誉；超期未履约可形成 world-specific `harm`，但只有另有信任变化事实时才可能对应地图 903。随后重新履约或建立可信承诺才可能进入 `recovery`。赠与与交换必须分开，拒绝、取消和一般过期不算违约。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `13 分享资源` | `capability:13:practice:gift:v2` | `constructive · practice` | `strict · gift（赠与支路）`：物资来自赠与者私人背包，完成转移给另一人，且不引用交换、许可或授权。 |
| `37 划定土地与财产` | `capability:37:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：私人库存、容器或权限不能证明土地/财产边界被社会性划定。 |
| `45 交换货物` | `capability:45:practice:exchange:v2` | `constructive · practice` | `strict · exchange`：双方接受含物资和数量的交换条款，双方真实转移并使同一约定 `fulfilled`。 |
| `48 订立契约` | `capability:48:emergence:agreement:v2` | `ambivalent · emergence` | `strict · agreement`：结构化 `offer/request` 指定双方与期限，所需回应者明确接受并建立有效/已履行约定。 |
| `421 议价并形成交换比率` | `capability:421:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：完成一次交换不能证明发生议价或形成可复用比率。 |
| `425 形成品牌与商业信誉` | `capability:425:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：重复交换或一般信任不足以证明品牌身份与商业信誉。 |
| `461 区分个人、家庭与共同财产` | `capability:461:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：背包、容器、共同体许可尚不能证明三种财产类别都被区分。 |
| `462 赠与财物` | `capability:462:practice:gift:v2` | `constructive · practice` | `strict · gift`：与坐标 13 共用私人财物无对价转移的可回放证据。 |
| `466 囤积稀缺物资` | `capability:466:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：库存量不能证明物资稀缺、囤积意图、受益者或受损者。 |
| `808 进行电子支付与线上交易` | `capability:808:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：普通交换事实不能证明电子媒介或线上网络。 |
| `903 因违约失去信任` | `capability:903:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：显式违约事实只能证明逾期未履行；当前缺少“因此失去信任”的后续状态或行为证据。违约本身改列 world-specific。 |
| `956 重建交换和可信承诺` | `capability:956:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：新交换或新约定不足以证明它发生在旧体系崩溃之后并恢复了可信度。 |

### 家族 11：共同体、归属、互助、接纳、分裂与重建

可能的证据路径：归属需要 → 候选人和现有成员同意 → 有来源成员资格（`emergence`）→ 重复互助与规则 → 主动退出（`decline`）→ 共同体休眠/解散（`collapse`）→ 后续重新加入与活跃（`recovery`）。一次社交、广播或同地停留不是共同体。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `29 结成友谊与联盟` | `capability:29:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：伴侣、共同体或协作事实不能替代友谊/联盟的具体关系语义。 |
| `184 寻求归属与被接纳` | `capability:184:emergence:membership-belonging:v2` | `constructive · emergence` | `strict · membership-belonging`：候选人先主动请求加入指定共同体；现有成员随后提议、所需审批者接受，并生成仍 active 的 membership。 |
| `472 救济无力维生者` | `capability:472:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：赠与或协助不能证明受助者无力维生及行为属于救济。 |
| `486 成立互助会` | `capability:486:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：重复援助或一般共同体不足以证明互助会这一组织形态。 |
| `488 欢迎新成员进入社区` | `capability:488:emergence:membership-admission:v2` | `constructive · emergence` | `strict · membership-admission`：active collective 的现有成员主动提议指定候选人，候选人与审批成员接受并形成 active membership；有候选人主动请求的同一 episode 只归入 184，不双计。 |
| `499 社区分裂与成员出走` | `capability:499:collapse:collective-collapse:v2` | `harmful · collapse` | `strict · collective-collapse（主动退出支路）`：共同体曾有至少两名真实成员，主动退出链使其转为 dormant/dissolved；单纯死亡不按此探针计。 |
| `500 在迁移或灾害后重建社区网络` | `capability:500:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一般成员重新加入不证明前因是迁移/灾害，也不证明社区网络整体重建。 |

### 家族 12：规则、授权、治理、惩罚与宽免

可能的证据路径：共同问题 → 全体接受决策规则 → 限时授权（`practice`）→ 真实贡献和分配 → 多人规则稳定（`stable`）；处罚与宽免是另行需要合法范围、对象、强制和后果的支路，不能由一般拘束冒充。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `61 选举领袖` | `capability:61:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：限时授权或任命不能证明发生了选举。 |
| `503 制定组织章程` | `capability:503:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：一条决策规则不足以证明形成完整组织章程。 |
| `504 选出或任命负责人` | `capability:504:practice:mandate:v2` | `ambivalent · practice` | `strict · mandate（任命/授权支路）`：全体同意规则先成为决策规则，成员再按规则接受限时授权；不把它表述为选举。 |
| `524 通过协商形成共识` | `capability:524:stable:decision-rule:v2` | `constructive · stable` | `strict · decision-rule（操作性共识）`：具体范围的 unanimous 规则由全体现有成员接受，形成 active `DecisionRule`；要求至少两名行动者和两个证据事件。 |
| `530 记录并执行集体决定` | `capability:530:practice:exercised-mandate:v2` | `constructive · practice` | `strict · exercised-mandate`：限时授权有来源，成员真实贡献且协调者真实分配同一种物资。 |
| `551 实施罚款、限制或监禁` | `capability:551:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：绳索拘束或物资扣留不能证明合法处罚、罚款或监禁制度。 |
| `553 赦免或减轻处罚` | `capability:553:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：解除拘束不能证明此前是处罚，也不能证明赦免或减刑决定。 |

### 家族 13：盗窃企图、欺骗、暴力风险与事实查明

可能的证据路径：威胁或未经授权企图 → 抵抗使其失败（`response`）；若取物得手或人际施力造成伤害，则进入 world-specific `harm`，若伤害可追溯导致死亡则进入 `collapse`。发现暴力事实与暴力本身是两个不同坐标，不能互相冒用。

| 地图坐标（原标签） | 当前定义 ID | 效价 · 阶段/分支 | 当前支持与证据口径 |
| --- | --- | --- | --- |
| `149 防范盗窃与侵入` | `capability:149:response:theft-attempt:v2` | `constructive · response` | `strict · theft-attempt（防住盗窃企图支路）`：人物间未经授权转移被阻止，保存 `attempted=true` 与 `resistedBy`，且物资未转手。当前不证明一般“侵入”防范。 |
| `641 防范盗窃与抢劫` | `capability:641:response:theft-attempt:v2` | `constructive · response` | `strict · theft-attempt（防住盗窃企图支路）`：与坐标 149 共用被阻止的未授权人物间转移；当前不证明抢劫的暴力要素。 |
| `642 识别欺骗与诈骗` | `capability:642:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：提议被拒、约定违约或交换不利不能证明人物识别了欺骗/诈骗。 |
| `931 查明暴力发生的事实` | `capability:931:emergence:guarded:v2` | `ambivalent* · emergence*` | `guarded`：暴力事件存在不等于有人完成调查、核验并查明事实。 |

### 家族 14：world-specific 复杂性、损害、崩解与恢复（无地图 ID）

这些定义记录当前世界模型确实能严格证明、但 120 个已登记地图坐标中没有精确同义标签的事实。它们没有 `capabilityId`，不得借用“看起来接近”的地图编号。特别是：**偷盗得手、杀人/致死暴力、一般人际暴力、绳索拘束、违约发生、一般共同体恢复、项目失败与恢复、野生动物袭击都保留为 world-specific complexity。**

| world-specific 标签 | 当前定义 ID | 效价 · 阶段/分支 | 当前 strict 证据口径 |
| --- | --- | --- | --- |
| `人物提出恒乱纪元预言` | `world:era-prediction:emergence:prediction:v2` | `ambivalent · emergence` | `prediction`：向真实 audience 作出带时间窗的纪元预言，状态保存预测者、目标纪元和来源。 |
| `恒乱纪元预言应验` | `world:correct-era-prediction:response:correct-prediction:v2` | `constructive · response` | `correct-prediction`：预言先于纪元变化提出，结算保存 `correct=true` 与误差月份。 |
| `恒乱纪元预言未应验` | `world:incorrect-era-prediction:decline:incorrect-prediction:v2` | `ambivalent · decline` | `incorrect-prediction`：预言先于截止月提出，结算保存 `correct=false` 与误差月份。 |
| `人物跨次检验恒乱纪元预言` | `world:era-prediction-practice:stable:prediction-practice:v2` | `constructive · stable` | `prediction-practice`：同一预测者至少两次预言已经结算，每次都有独立来源和正确/错误后果；再过跨月门槛。 |
| `天气或气候变化发生` | `world:weather-change:emergence:weather:v2` | `ambivalent · emergence` | `weather`：环境结算产生结构化天气/气候事实，保存种类、强度或纪元序号。 |
| `恒纪元与乱纪元交替发生` | `world:era-cycle:stable:era-cycle:v2` | `ambivalent · stable` | `era-cycle`：至少两次可解析纪元转换，历史中真实出现恒、乱两类纪元；不需要人物行动者。 |
| `未授权取物实际得手` | `world:theft-success:harm:theft-success:v2` | `harmful · harm` | `theft-success`：人物间未经授权转移已完成，保存来源、去向、物资与正数量。它不是地图 149/641 的“防范”。 |
| `人际暴力造成伤害` | `world:interpersonal-violence:harm:violence:v2` | `harmful · harm` | `violence`：完成的 `exert` 指向另一人物，保存受害者、正伤害与伤口来源。 |
| `人际暴力导致死亡` | `world:lethal-interpersonal-violence:collapse:lethal-violence:v2` | `harmful · collapse` | `lethal-violence`：死亡事实的来源 ID 可回溯至同一受害者的伤害动作；只判因果致死，不推断主观故意。不能冒用地图 931“查明暴力事实”。 |
| `人物被绳索持续拘束` | `world:restraint:harm:restraint:v2` | `harmful · harm` | `restraint`：真实绳材料被消耗，完成事实和 `restrained` 条件保存同一对象与来源。不能冒用地图 551 的制度性处罚。 |
| `人物的持续拘束被解除` | `world:release-restraint:recovery:release-restraint:v2` | `constructive · recovery` | `release-restraint`：目标先有有来源拘束条件，后续 `separate` 保存被释放者与来源条件 ID。不能冒用地图 553“赦免”。 |
| `已接受的约定逾期未履行` | `world:agreement-breach:harm:breach:v2` | `harmful · harm` | `breach`：约定先由所需回应者接受并进入 active，逾期未履行后显式产生 `agreement:breached`；证据只保留提议、接受和违约结果，不冒用地图 903“失去信任”。 |
| `共同体成员主动退出` | `world:collective-withdrawal:decline:collective-withdrawal:v2` | `ambivalent · decline` | `collective-withdrawal`：人物先有 active membership，再由本人沟通退出并使成员状态转为 withdrawn。 |
| `共同体在成员退出后恢复活跃` | `world:collective-recovery:recovery:collective-recovery:v2` | `constructive · recovery` | `collective-recovery`：共同体先有退出/休眠来源，后有新成员接受加入并恢复 active。它不冒用地图 500 的“迁移或灾害后重建社区网络”。 |
| `项目因有来源的供给失败而阻塞` | `world:project-breakdown:collapse:project-breakdown:v2` | `harmful · collapse` | `project-breakdown`：项目为 blocked，或物流 episode 为 exhausted/invalidated，且必须有失败证据；episode 只保留 `triggerFactIds`、`failureEventIds` 及失败物流的 source/action 事件，不引用项目整个 action history。 |
| `项目在有来源失败后恢复并完成` | `world:project-recovery:recovery:project-recovery:v2` | `constructive · recovery` | `project-recovery`：同一项目先有 `failureEventIds` 或 exhausted/invalidated 物流，随后完成并有 `completionEventIds`；episode 只保留失败事件/失败物流的 source/action 事件与 completion 事件，不引用整个 action history，也不冒用地图 400 或 956。 |
| `野生动物袭击人物发生` | `world:animal-attack:harm:animal-attack:v2` | `harmful · harm` | `animal-attack`：环境事实明确为 `attack-human`，带真实受害者、正伤害和伤口来源。它不冒用地图 841“识别危险”。 |

## 3. 相近标签不等于同义坐标

为防止观察器把“发生了一件事”误写成“形成了一项更复杂能力”，当前目录明确保留以下边界：

| 已有严格事实 | 不得冒用的地图坐标 | 原因 |
| --- | --- | --- |
| 未授权取物得手 | `149 防范盗窃与侵入`、`641 防范盗窃与抢劫` | 得手是损害；两项地图坐标描述防范/应对。 |
| 人际暴力或致死暴力 | `931 查明暴力发生的事实` | 暴力发生不等于调查、核验和查明。致死因果也不等于已证明主观故意。 |
| 绳索拘束/解除 | `551 实施罚款、限制或监禁`、`553 赦免或减轻处罚` | 物理状态不证明法律授权、处罚性质或赦免决定。 |
| 已接受的约定逾期未履行 | `903 因违约失去信任` | 违约事实不等于信任已经下降；后者还需要可回放的信任状态或后续行为证据。 |
| 一般共同体退出后恢复 | `500 在迁移或灾害后重建社区网络` | 缺少迁移/灾害前因和网络重建尺度。 |
| 一般项目阻塞/恢复 | `393 应对道路阻断与运输延误`、`400 在运输系统崩溃后恢复流通`、`956 重建交换和可信承诺` | 项目事实未必属于道路、运输或交换制度。 |
| 野生动物袭击 | `841 识别自然与人为危险` | 遭受危险不等于人物识别、区分并记住危险。 |
| 技术重新出现的内部检测可能性 | `799 恢复失传技术` | 当前定义仍是 guarded；未注册 detector 不能当作已启用 milestone。 |

同理，一条 strict 探针只覆盖表中写明的支路。`324` 只严格见制绳，`325` 只严格见实体容器制作后使用，`390` 只见容器存取。它们可用于现阶段窄口径审计，但不能扩写成标签中所有并列动作均已发生。`119`、`322`、`354` 与 `384` 保持 guarded，不再由未来死亡、普通采集或项目物流证据代替。

## 4. 覆盖统计与使用约束

| 范围 | 定义数 | `strict` | `guarded` |
| --- | ---: | ---: | ---: |
| 当前 `MAP_CATALOG` 地图坐标 | 121 | 52 | 69 |
| `WORLD_SPECIFIC_SPECS` | 17 | 17 | 0 |
| 合计 | 138 | 69 | 69 |

52 个 strict 地图定义按效价分为：`constructive 38`、`harmful 4`、`ambivalent 10`；按阶段分为：`emergence 8`、`practice 25`、`stable 9`、`harm 1`、`decline 2`、`collapse 3`、`recovery 0`、`response 4`。17 个 world-specific 定义按效价分为：`constructive 5`、`harmful 7`、`ambivalent 5`；按阶段分为：`emergence 2`、`practice 0`、`stable 2`、`harm 5`、`decline 2`、`collapse 2`、`recovery 3`、`response 1`。

这 121 项只是当前代码从一千项地图中登记的子集，不代表其余 879 项被否定。任何清单外行为都应先作为世界事实保存；观察器可以在后续版本新增精确坐标或保留为 world-specific。无论 strict 还是 guarded，都必须从真实行动者、对象、地点、月份、资源、规则、后果和事件 ID 回放，不能匹配一句叙述文本，也不能用“看起来像”补齐缺失环节。

最后，本目录没有读取或引用任何具体 run 的权威状态、事实报告或叙事增强结果，因此**没有声称上述任一里程碑已经在自然模拟历史中发生**。判断“已发生”必须另行对具体运行调用观察器，并展示满足门槛的证据事件链。
