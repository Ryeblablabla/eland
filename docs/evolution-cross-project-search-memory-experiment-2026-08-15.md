# v17 跨项目搜索经验实验

状态：机制接受。

## v16 最早断点

v16 让单个 `ProjectSearchCampaign` 有锚点、目标唯一且可耗尽，但 campaign 的记忆边界仍等于项目 ID。项目阻塞后，相同人物可以马上以新项目 ID 重置同一片区域：

- seed 185：Socrates 的 9 个知识保存项目搜索 226 个 target，Leonardo 的 5 个同类项目搜索 147 个；
- seed 20260815：Armstrong 的 5 个知识保存项目搜索 173 个；
- seed 20260816：Heidi 的 5 个知识保存项目搜索 139 个。

因此项目内重复为 0，却仍出现三种子 414～486 个 search episode 和 78.80%～81.06% 的移动占比。失败没有形成可供下一次计划使用的本人经验。

## 单一因果假设

人物应把已亲自搜索过的地点当作经验，而不是把项目 ID 当作记忆边界：

- 新 campaign 仍以当前人物位置和当前可见区域为锚；
- 对同一 actor、相同材料集合、相同 `planKnowledgeId`，从该人物旧 campaign 继承与当前区域重叠的已尝试 target；
- 继承项与本次新尝试分开保存，并记录来源 campaign；旧 campaign 不被修改；
- 项目 ID、月份、紧迫度、人物在同一区域内移动不能清空继承经验；
- 新位置暴露的未搜索 target 仍可尝试；真实可见 drop 仍优先；获得新计划知识会形成新 basis，不继承旧计划下的排除；
- 这不是全知资源地图：人物只能继承自己实际参与的 campaign，不能继承陌生人的搜索，也不能推断未见区域没有资源。

## 预登记矩阵

- 基线：`candidate-bounded-search-campaign-v16-observer-v8`；
- 候选：`candidate-cross-project-search-memory-v17`；
- 种子：`185, 20260815, 20260816`；
- 三种子 × 10 年快速诊断，三种子 × 30 年最终配对；
- 本地规则模式，模型调用和 token 应为 0。

主要指标：继承 campaign 数、继承 target 数、跨项目同 actor/material/plan 的重复 target、继承来源错配、同项目重复、search episode、移动占比、物质贡献、项目完成/阻塞与新区域首次搜索。

接受护栏：

- 定向测试证明重叠区域被继承、纯项目 ID/月/压力变化不能重搜，非重叠新区域与新计划仍可搜索；
- 跨项目重复 target、同项目重复、错误 actor/material/plan、无来源继承全部为 0；
- 至少一个 v16 重复建项历史在没有新区域/计划时不再重新搜索；
- 不阻止当前真实 drop、生产步骤或新区域搜索；
- v12～v16 的关系、中断、压力、进展和 campaign 护栏保持为 0。

不以项目完成、人口或文明指数上涨作为接受条件。若搜索明显下降后项目更早诚实阻塞，下一轮应诊断缺少的资源、配方或替代方案，而不是恢复失忆式漫游。

## 结果与决定

候选新增 `inheritedCampaignIds` 与 `inheritedTargetKeys`。新 campaign 只继承同 actor、同材料集合、同计划 basis 且与当前固定区域重叠的实际 target；新计划、他人经验和未重叠区域保持独立。定向测试覆盖跨项目继承、月份/压力不清空、新计划不继承和他人不继承。

候选产物：

- 10 年快速矩阵：`candidate-cross-project-search-memory-v17-quick.json`；
- 30 年最终矩阵：`candidate-cross-project-search-memory-v17.json`；
- v16/v17 统一观察器：`candidate-bounded-search-campaign-v16-observer-v9.json`、`candidate-cross-project-search-memory-v17-observer-v9.json`；
- 配对比较：`candidate-cross-project-search-memory-v17-vs-v16.json`。

三种子 × 30 年中：

- v16 的跨项目重复 target 为 184/130/35，候选全部降为 0；同 campaign 重复仍为 0；
- 8/3/8 个 campaign 从 15/3/11 个旧 campaign 继承 196/82/168 个 target；
- inherited target 重复、区域外继承、来源缺失、同项目来源、actor/material/plan 错配和全部 v16 campaign 护栏均为 0；
- search episode 从 486/421/414 降为 243/190/383；项目物流 action event 从 2985/3298/2977 降为 1625/1820/2792；
- 移动占比从 79.53%/78.80%/81.06% 降为 77.61%/73.17%/80.35%，三个配对种子均下降，但仍偏高；
- 项目完成 26/34/27→24/34/28，阻塞 19/10/17→14/8/16。人口和文明指数方向不一致，不参与机制验收。

代表历史中 seed 185 的 Socrates 同类知识保存项目从 v16 的 9 个、226 次搜索变为 7 个、119 次新搜索，并继承 123 个旧 target；这不是硬冷却，人物移动到真正未搜索区域后仍会继续搜索。

决定：接受跨项目个人搜索经验。下一断点不是搜索次数参数，而是项目步骤丢失数量与分支语义：熟食项目会在已有大量纤维后继续搬运，或反复制造已足够的石器。v18 只修复当前步骤的定量物料需求；跨项目 drop claim 另做独立版本。
