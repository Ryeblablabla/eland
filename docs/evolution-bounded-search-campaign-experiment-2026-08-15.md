# v16 有锚点且可耗尽的项目搜索实验

状态：机制接受；整包继续修订。

## v15 最早断点

v15 正确记录了接近目标的进展，但项目可以在一个 search episode 结束后立刻以移动后视野为中心再开一个，形成“移动地平线”。极端历史包括：

- Tesla 的知识保存项目：77 个 search episode、422 个接近动作、0 个物质贡献，只覆盖 7 个唯一目标，重复回访 70 次；
- Usagi 的住所项目：51 个 search episode，只覆盖 8 个唯一目标；
- Washington 的知识保存项目：43 个 episode、42 个唯一目标，说明即便不回访，移动视野仍可让搜索区域无限向外漂移。

单个 episode 的 4～16 action budget 因而不足以保证项目搜索有界。

## 单一因果假设

搜索应是由当前局部缺料事实开启的一次 `ProjectSearchCampaign`，而不是人物每移动一步就重新定义世界：

- campaign 保存 `id`、owner、材料集合、basis key、openedAt、anchor、固定 `cellIds`、source fact、已尝试 target key、状态和结束月份；
- anchor 为 campaign 开启时人物位置，候选区域为当时真实可见且可达的站立空间；之后人物移动不能扩张该区域；
- 同一 campaign 的每个 standing target 最多建立一个 search episode，建立时即记 attempted；失败也不能在没有新事实时原地重试；
- 当固定区域没有未尝试目标时 campaign 进入 exhausted，编译器返回无搜索步骤；
- 只有 material requirement 或 plan knowledge 发生新的离散边沿，才能 supersede 旧 campaign 并开启新 campaign；压力只改变紧迫度，不代表资源重新出现；纯过月、文明指数、里程碑和人物走到新地点均不能重开；
- 当前可见且有来源的真实 drop 仍优先建立 drop episode，不受已耗尽搜索区域阻止。

campaign 限制“去哪里找”，不凭空生成资源、不保证成功，也不把搜索耗尽直接等同于文明失败。

## 预登记矩阵

- 基线：`candidate-project-progress-evidence-v15-observer-v7`；
- 候选：`candidate-bounded-search-campaign-v16`；
- 种子：`185, 20260815, 20260816`；
- 三种子 × 10 年快速诊断，三种子 × 30 年最终配对；
- 规则模式、相同配置，保留零发生与不利结果。

主要指标：campaign 数、覆盖项目数、attempted target、search episode、同 campaign 重复目标、区域外目标、无新 basis 重开、exhausted/superseded、搜索动作与物质贡献转化；同时检查项目完成/阻塞、移动反转、v12～v15 护栏和模型独立性。

接受护栏：

- 定向测试证明固定区域不随移动扩张，同 campaign 目标不重复，耗尽后纯过月不能重开；新 basis 可以重开；
- campaign 与 episode 的 owner/project/material/target/source 关联可解析，重复和区域外目标为 0；
- 至少一个 v15 的重复搜索条件在候选变成有限 attempted 集并耗尽；
- 可见真实 drop 仍可被取得；不以禁止搜索伪造完成率改善；
- v15 进展 evidence 错配/非接近为 0，v14 压力、v12/v13 关系和中断护栏为 0；模型调用与 token 为 0。

不要求项目完成或人口上升。若 campaign 耗尽后项目更早阻塞，这是对资源缺失的诚实表达；需检查世界确实没有当前可见来源，而不是编译器漏掉 affordance。

## 结果与决定

实现了 `ProjectSearchCampaign`：搜索在开启时固定锚点与可见格子，保存材料/计划 basis、已尝试 standing target、来源和终止状态；普通移动、紧迫度和过月不能扩张或重开同一 campaign。定向测试同时覆盖 proposal 落库、目标唯一、固定区域、耗尽、纯移动/过月不重开、计划知识新边沿可重开。

候选产物：

- 10 年快速矩阵：`candidate-bounded-search-campaign-v16-quickb.json`；
- 30 年最终矩阵：`candidate-bounded-search-campaign-v16.json`；
- v15/v16 统一观察器：`candidate-project-progress-evidence-v15-observer-v8.json`、`candidate-bounded-search-campaign-v16-observer-v8.json`；
- 配对比较：`candidate-bounded-search-campaign-v16-vs-v15.json`。

三种子 × 30 年中：

- 产生 26/20/28 个 campaign，覆盖 26/19/26 个项目；其中 11/9/8 个真实耗尽；
- search episode 与 campaign 关联覆盖率均为 100%；重复 target、重复 basis、区域外 target、未登记 target、project/owner/actor/material 错配和不可解析来源全部为 0；
- 每个 campaign 最大尝试 72/66/79 个 target，说明搜索确实有限，但初始视野可以很大；
- v15 的项目内重复回访被消除，但 search episode 反而从 176/131/176 增至 486/421/414，移动占比从 69.85%/67.70%/71.43% 增至 79.53%/78.80%/81.06%；
- 项目完成从 22/30/28 变为 26/34/27，阻塞从 8/3/8 增至 19/10/17；这不是可接受的流畅性改善，且不能用人口 5/8/8→9/11/14 抵消。

代表历史显示断点已经移动到项目之间：seed 185 中 Socrates 连续发起 9 个 `knowledge-preservation` 项目，8 个阻塞、1 个完成，总计搜索 226 个不同 target；Leonardo 的 5 个同类项目又搜索 147 个。另两个种子也分别出现 Armstrong 5 个同类项目搜索 173 个、Heidi 5 个同类项目搜索 139 个。单个项目记得自己搜过哪里，但新项目把旧失败当作从未发生。

决定：接受“有锚点、目标不重复、可耗尽”的 campaign 作为因果基础设施；拒绝将 v16 整包视为流畅性改善。v17 修复最早断点：同一人物、相同材料与相同计划 basis 的后续 campaign 必须继承旧 campaign 在重叠区域的搜索经验；新地点、真实新物资或新计划仍可提供合法的新机会，月份、项目新 ID 和压力本身不能清空经验。
