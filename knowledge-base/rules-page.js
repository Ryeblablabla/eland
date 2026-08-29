import { mountDocumentLibrary } from './docs-page.js';
import { KNOWLEDGE_DOCUMENTS } from './knowledge-docs.js';
import { mountRecipeLibrary, recipeSearchRecord } from './recipes-page.js?v=recipes-v2';
import { mountKnowledgeSearch } from './search-page.js';

const RULES_PAGE_MARKUP = `
  <div class="rules-shell">
    <header class="rules-hero" id="ruleOverview">
      <div class="rules-eyebrow"><span></span> CURRENT GAME LOGIC · 规则权威导览</div>
      <div class="rules-hero-copy">
        <div>
          <h2>一棵从世界压力<br>长出来的文明树</h2>
          <p>ELAND 不预设人物要“升级文明”。世界先产生气候、身体、材料与关系事实；人物只凭局部感知和有来源的记忆形成需要，再把需要推进为项目、合法动作与可回放后果。</p>
        </div>
        <aside class="authority-note" aria-label="规则权威说明">
          <span class="authority-note-label">AUTHORITY</span>
          <strong>代码与事件历史是当前事实</strong>
          <p>本页是源码导览，不是第二套模拟逻辑。规则变化后，应同步这里的说明。</p>
        </aside>
      </div>
      <div class="rule-facts" aria-label="规则关键数字">
        <div><strong>15</strong><span>规划刻度 / 月</span></div>
        <div><strong>5</strong><span>种原子动作</span></div>
        <div><strong>9</strong><span>种物质操作</span></div>
        <div><strong>4</strong><span>目标压力分支</span></div>
        <div><strong>0</strong><span>文明指数反向解锁</span></div>
      </div>
      <div class="causal-spine-wrap" aria-labelledby="causalSpineTitle">
        <div class="section-kicker" id="causalSpineTitle">因果主链 · CAUSAL SPINE</div>
        <ol class="causal-spine">
          <li><span>01</span><strong>世界压力</strong><small>气候 · 饥渴 · 风险</small></li>
          <li><span>02</span><strong>局部感知</strong><small>眼前可见、可达事实</small></li>
          <li><span>03</span><strong>有源记忆</strong><small>经历 · 地点 · 承诺</small></li>
          <li><span>04</span><strong>动态需要</strong><small>避免损失、照护、储备</small></li>
          <li><span>05</span><strong>持续项目</strong><small>目标 · 现场 · 贡献者</small></li>
          <li><span>06</span><strong>计划编译</strong><small>前置条件 · 物流 · 替代</small></li>
          <li><span>07</span><strong>合法动作</strong><small>预演后每 tick 至多一个</small></li>
          <li><span>08</span><strong>客观后果</strong><small>身体 · 物质 · 社会变化</small></li>
          <li><span>09</span><strong>学习传播</strong><small>验证 · 教导 · 记录</small></li>
          <li><span>10</span><strong>制度涌现</strong><small>角色 · 规则 · 稳定协作</small></li>
        </ol>
      </div>
    </header>

    <section class="rules-section" id="architectureAtlas" aria-labelledby="architectureAtlasTitle">
      <div class="section-heading">
        <div><span class="section-no">01</span><div><span class="section-kicker">ARCHITECTURE ATLAS</span><h2 id="architectureAtlasTitle">先看层次，再看规则细节</h2></div></div>
        <p>四张图从游戏整体下钻到世界、人物与文明。箭头只表示真实依赖和事实流；模型与观察器始终在权威主链之外。</p>
      </div>

      <div class="architecture-legend" aria-label="架构图图例">
        <span data-tone="world">世界 / 事实</span>
        <span data-tone="agent">人物 / 决策</span>
        <span data-tone="effect">动作 / 提交</span>
        <span data-tone="social">社会 / 涌现</span>
        <span data-tone="observer">只读 / 可选</span>
      </div>

      <div class="architecture-atlas">
        <article class="architecture-board architecture-board-wide" aria-labelledby="gameArchitectureTitle">
          <header class="architecture-board-head">
            <div><span>01 · GAME ARCHITECTURE</span><h3 id="gameArchitectureTitle">游戏总架构</h3></div>
            <p>命令逐层向下，只有提交后的事实能够沿投影链返回画面。</p>
          </header>
          <div class="architecture-stack game-stack">
            <section class="architecture-layer" data-tone="observer">
              <div class="architecture-layer-label"><span>L5</span><strong>体验与只读呈现</strong><small>玩家看到什么</small></div>
              <div class="architecture-node-grid architecture-node-grid-3">
                <div class="architecture-node"><strong>三体宇宙</strong><small>连续缩放 · 纪元与天体</small></div>
                <div class="architecture-node"><strong>人间体素世界</strong><small>人物 · 建筑 · 生态装饰</small></div>
                <div class="architecture-node"><strong>人物与历史界面</strong><small>对话 · 回放 · 报告</small></div>
              </div>
            </section>
            <div class="architecture-arrow architecture-arrow-dual"><span>玩家命令 ↓</span><span>GameFrame / 报告 ↑</span></div>
            <section class="architecture-layer" data-tone="world">
              <div class="architecture-layer-label"><span>L4</span><strong>交付与会话</strong><small>入口，不裁决世界</small></div>
              <div class="architecture-node-grid architecture-node-grid-3">
                <div class="architecture-node"><strong>React / HTTP</strong><small>交互与 API 适配</small></div>
                <div class="architecture-node"><strong>实时 Session</strong><small>月份推进 · 分支 · seek</small></div>
                <div class="architecture-node"><strong>Timeline</strong><small>checkpoint · delta · 恢复</small></div>
              </div>
            </section>
            <div class="architecture-arrow"><span>用例命令 ↓</span></div>
            <section class="architecture-layer" data-tone="agent">
              <div class="architecture-layer-label"><span>L3</span><strong>应用编排</strong><small>组织规则，不复制规则</small></div>
              <div class="architecture-node-grid architecture-node-grid-4">
                <div class="architecture-node"><strong>月度主循环</strong><small>15 planning ticks</small></div>
                <div class="architecture-node"><strong>本地规划器</strong><small>反射 · BDI · Intent</small></div>
                <div class="architecture-node"><strong>项目编译器</strong><small>HTN · 物流 · 试验</small></div>
                <div class="architecture-node"><strong>动作预演</strong><small>局部修复 · 重验</small></div>
              </div>
            </section>
            <div class="architecture-arrow"><span>合法候选与动作 ↓</span></div>
            <section class="architecture-layer" data-tone="effect">
              <div class="architecture-layer-label"><span>L2</span><strong>模拟内核</strong><small>唯一规则裁决</small></div>
              <div class="architecture-kernel-link">
                <div class="architecture-node"><strong>Domain Model</strong><small>身体 · 物质 · 关系 · 项目 · 协议</small></div>
                <span aria-hidden="true">↔</span>
                <div class="architecture-node"><strong>World Primitives</strong><small>体素网格 · 路径 · 水流 · 空间</small></div>
              </div>
            </section>
            <div class="architecture-arrow"><span>提交客观变化 ↓</span></div>
            <section class="architecture-layer architecture-fact-layer" data-tone="world">
              <div class="architecture-layer-label"><span>L1</span><strong>权威事实与持久化</strong><small>可回放、可恢复</small></div>
              <div class="architecture-node-grid architecture-node-grid-3">
                <div class="architecture-node"><strong>SimulationState</strong><small>当前权威聚合</small></div>
                <div class="architecture-node"><strong>WorldEvent</strong><small>DecisionFact · ActionFact · 环境事实</small></div>
                <div class="architecture-node"><strong>SQLite WAL</strong><small>运行 · 会话 · 时间线 · 内容块</small></div>
              </div>
            </section>
          </div>
          <div class="architecture-rails">
            <aside data-tone="observer"><span>READ MODEL RAIL</span><strong>Projection / Report / GameFrame</strong><p>只读取已提交状态和事件，再返回 UI；不得写回人物、建筑或文明能力。</p></aside>
            <aside data-tone="observer"><span>OPTIONAL MODEL RAIL</span><strong>合法候选内重选 · 台词 · 提名</strong><p>缺席或失败时本地主链照常完成；所有建议仍由本地规则重验。</p></aside>
          </div>
        </article>

        <article class="architecture-board architecture-board-wide" aria-labelledby="worldArchitectureTitle">
          <header class="architecture-board-head">
            <div><span>02 · WORLD ARCHITECTURE</span><h3 id="worldArchitectureTitle">世界架构</h3></div>
            <p><code>SimulationState</code> 是根；物理、生命、社会与历史共享同一条时间线。</p>
          </header>
          <div class="architecture-root" data-tone="world">
            <span>ROOT</span><strong>SimulationState</strong><small>不是多个互相猜测的子世界</small>
          </div>
          <div class="architecture-branch-grid architecture-branch-grid-2">
            <section data-tone="world"><span>W1 · 物理世界</span><strong>空间与物质</strong><p>84 × 52 × 12 体素、掉落物、结构、容器、水流、站立位置和路径。</p></section>
            <section data-tone="world"><span>W2 · 自然世界</span><strong>时间与生态</strong><p>纪元、跨月天气、火、作物、动物、身体过程、出生、死亡与遗体。</p></section>
            <section data-tone="agent"><span>W3 · 人物与社会</span><strong>持续状态</strong><p>人物、库存、知识、记忆、关系、Intent、Project、Agreement、Collective 与 Governance。</p></section>
            <section data-tone="effect"><span>W4 · 历史与控制</span><strong>因果时间线</strong><p>clock、branch、past、lastStep、决策额度、文明条件与真实终局。</p></section>
          </div>
          <div class="architecture-stage-flow" aria-label="月度世界流程">
            <div><span>MONTH START</span><strong>纪元 · 天气 · 生态 · 协议</strong></div>
            <i aria-hidden="true">↓</i>
            <div><span>15 TICKS</span><strong>人物按已提交世界依次行动</strong></div>
            <i aria-hidden="true">↓</i>
            <div><span>MONTH END</span><strong>身体 · 项目 · 社会生命周期</strong></div>
            <i aria-hidden="true">↓</i>
            <div data-tone="observer"><span>DERIVED</span><strong>结构 · 里程碑 · 指数 · 报告</strong></div>
          </div>
          <p class="architecture-guard"><b>边界：</b><code>derived.structures</code> 可从体素事实重建；文明指数、阶段、里程碑、实践和制度观察不能成为人物目标。</p>
        </article>

        <article class="architecture-board architecture-board-wide" id="personArchitecture" aria-labelledby="personArchitectureTitle">
          <header class="architecture-board-head">
            <div><span>03 · PERSON ARCHITECTURE</span><h3 id="personArchitectureTitle">人物架构</h3></div>
            <p>人物不是一个 prompt。Agent 采用因果 BDI：Belief 来自局部事实，Desire 来自动态需要，Intention 是唯一执行焦点。</p>
          </header>
          <div class="bdi-architecture" aria-label="人物 BDI Agent 架构">
            <section class="bdi-node" data-tone="world">
              <span>B · BELIEF</span><strong>本人相信什么</strong>
              <p><b>DecisionContext</b>：局部感知、有来源记忆与知识、关系、承诺、当前项目，以及本人从 ActionFact 学到的结果后验。</p>
              <small>不是全局真相；看不见、没经历、无来源的事实不能进入。</small>
            </section>
            <section class="bdi-node" data-tone="agent">
              <span>D · DESIRE</span><strong>此刻什么值得做</strong>
              <p><b>NeedAgenda</b>：身体、安全、照护、储备、能力、承诺、归属、自主与探究九类动态压力；食物与饮水储备各自计算，健康、营养与水分也精确分维。每个已被规则证明可执行的不同项目候选都从自己的压力与来源形成绑定 projectId 的需要，再进入同一套人格、经验与可行性竞争；知识保存项目与其候选一致使用探究需要，候选不能拿另一资源、身体维度或项目的压力抬高动机。</p>
              <small>ActionOption 经人格、经验、关系、伦理和可行性门控后形成 motivation。</small>
            </section>
            <section class="bdi-node" data-tone="social">
              <span>I · INTENTION</span><strong>现在决定坚持什么</strong>
              <p><b>active Intent</b>：最高候选先跨过 aspiration，再与当前承诺、进度、停滞和切换边际比较。</p>
              <small>每人只有一个执行焦点；急性任务用可返回的子中断处理。</small>
            </section>
            <div class="bdi-plan" data-tone="effect">
              <span>P · PLAN &amp; ACTION</span><strong>Intent → Project / HTN → PrimitiveAction → ActionExecutor</strong>
              <small>本地计划补齐路线、材料、数量、工具与授权；领域层最终裁决并提交事实。</small>
            </div>
            <div class="bdi-feedback" data-tone="world">
              <span aria-hidden="true">↺</span><strong>ActionFact 更新 Belief</strong><small>成功、失败、努力、伤害、关系和项目进度进入下一轮局部认知；模型文本不会替代经验事实。</small>
            </div>
          </div>
          <div class="person-architecture">
            <section class="person-layer" data-tone="world">
              <span>P1 · 权威输入</span><strong>世界事实 + PersonState + 共享承诺状态</strong>
              <p>身体、位置、库存、知识、记忆、关系、人格、出生时确定的永久特质，以及状态中的 Intent / Project / Agreement。</p>
            </section>
            <div class="architecture-arrow"><span>只投影本人可获得的事实 ↓</span></div>
            <section class="person-layer" data-tone="agent">
              <span>P2 · 局部认知视图</span><strong>DecisionContext</strong>
              <p>可见格、人、动物、掉落物，有来源记忆、当前意图和已通过感知边界的能力证据。</p>
            </section>
            <div class="architecture-arrow"><span>生成合法可供性 ↓</span></div>
            <section class="person-layer person-layer-split" data-tone="agent">
              <div><span>P3-A · 硬门禁</span><strong>休眠 · 生存 · 照护 · 年龄 · 回应 · 履约</strong><p>不可推迟的事实先行；正在执行的优先义务不会被新义务无条件打断。</p></div>
              <div><span>P3-B · 自主选择</span><strong>ActionOption → NeedAgenda → Appraisal</strong><p>motivation 跨过本人 aspiration 后，才成为 BDI 挑战者。</p></div>
            </section>
            <div class="architecture-arrow"><span>检查意图持续与切换边际 ↓</span></div>
            <section class="person-layer" data-tone="social">
              <span>P4 · 唯一执行焦点</span><strong>Intent → Project / HTN → 下一原子动作</strong>
              <p>进度、尽责性、项目压力与个人成功后验形成承诺惯性；子中断保存可返回的父意图。</p>
            </section>
            <div class="architecture-arrow"><span>领域预演与重验 ↓</span></div>
            <section class="person-layer" data-tone="effect">
              <span>P5 · 规则提交</span><strong>ActionExecutor → ActionFact / WorldEvent</strong>
              <p>每 tick 至多一个动作；成功、推进、阻塞与失败都留下路径、消耗、产物和来源。</p>
            </section>
            <div class="person-feedback" data-tone="world">
              <span>↺ FEEDBACK</span><strong>事实反哺下一次决定</strong>
              <p>更新本人结果后验、结构化记忆、人格学习、关系、项目和协议进度；不从模型文本学习世界事实。</p>
            </div>
          </div>
          <div class="architecture-rails architecture-rails-compact">
            <aside data-tone="observer"><span>READ-ONLY SOUL</span><strong>PersonSoul / personaFrame</strong><p>由身份与 baseline 人格确定性派生，维持表达一致性；不写入 PersonState。</p></aside>
            <aside data-tone="observer"><span>OUTSIDE THE MIND</span><strong>文明指数 / 模型 / UI</strong><p>可以解释或在合法候选内重选，但不能制造需要、知识、动作或物质后果。</p></aside>
          </div>
        </article>

        <article class="architecture-board architecture-board-wide" aria-labelledby="civilizationArchitectureTitle">
          <header class="architecture-board-head">
            <div><span>04 · EMERGENCE ARCHITECTURE</span><h3 id="civilizationArchitectureTitle">文明涌现架构</h3></div>
            <p>文明不是人物主动追逐的等级；它是多个闭环在历史中反复成功后留下的观察结果。</p>
          </header>
          <div class="emergence-layers">
            <section data-tone="world">
              <div class="emergence-layer-label"><span>E1</span><strong>压力层</strong></div>
              <div class="architecture-node-grid architecture-node-grid-4"><div class="architecture-node">气候与生态</div><div class="architecture-node">身体与照护</div><div class="architecture-node">材料与劳动</div><div class="architecture-node">协调与不确定性</div></div>
            </section>
            <div class="architecture-arrow"><span>局部感知与有源记忆 ↓</span></div>
            <section data-tone="agent">
              <div class="emergence-layer-label"><span>E2</span><strong>人物适应层</strong></div>
              <div class="architecture-node-grid architecture-node-grid-4"><div class="architecture-node">动态 Need</div><div class="architecture-node">持续 Project</div><div class="architecture-node">合法 Action</div><div class="architecture-node">客观 Consequence</div></div>
            </section>
            <div class="architecture-arrow"><span>重复成功并被记住 ↓</span></div>
            <section data-tone="social">
              <div class="emergence-layer-label"><span>E3</span><strong>能力传播层</strong></div>
              <div class="architecture-node-grid architecture-node-grid-4"><div class="architecture-node">个人技术</div><div class="architecture-node">教学与记录</div><div class="architecture-node">共同项目</div><div class="architecture-node">履约与信任</div></div>
            </section>
            <div class="architecture-arrow"><span>改变未来行为 ↓</span></div>
            <section data-tone="effect">
              <div class="emergence-layer-label"><span>E4</span><strong>社会结构层</strong></div>
              <div class="architecture-node-grid architecture-node-grid-4"><div class="architecture-node">Practice</div><div class="architecture-node">Role</div><div class="architecture-node">Norm</div><div class="architecture-node">Institution</div></div>
            </section>
            <div class="emergence-feedback" data-tone="world"><span>↺</span><strong>新能力、设施和制度改变下一轮世界压力</strong><small>观察器只在事后识别阶段，不向人物发放奖励。</small></div>
          </div>
        </article>
      </div>
    </section>

    <section class="rules-section" id="ruleTree" aria-labelledby="ruleTreeTitle">
      <div class="section-heading">
        <div><span class="section-no">02</span><div><span class="section-kicker">RULE TREE</span><h2 id="ruleTreeTitle">当前游戏规则树</h2></div></div>
        <p>根节点是唯一的 <code>SimulationState</code>。每条分支最终都要落到真实状态或只读投影，不能从表现层倒灌事实。</p>
      </div>

      <div class="tree-root">
        <span class="tree-root-mark">ROOT</span>
        <div><strong>SimulationState</strong><small>世界、人物、项目、协议、事件与文明状态的权威聚合</small></div>
      </div>
      <div class="rule-branch-grid">
        <details class="rule-branch" data-tone="world" open>
          <summary><span>世界过程</span><small>即使无人行动也会推进</small></summary>
          <ul>
            <li><strong>时间与纪元</strong><span>恒纪元 / 乱纪元持续区段；天气按月结算但以跨月过程叠加在纪元之上，类型具有不改变长程占比的延续惯性，强度只偶发逐级变化。实时宇宙的 burned 明确携带三日凌空终局语义，普通 fire 即使达到强度 10 也不能冒充。</span></li>
            <li><strong>有限化身时间</strong><span>普通快进与第一人称化身共用 month-execution：进入后暂存下一月，已提交 elapsedMonths 不变；自由观察不耗刻度，每个玩家命令让稳定顺序中的全部人物执行一个完整 tick。走完第 15 刻，或交还自主后由本地规则跑完余下刻度，才进行一次月末结算和原子提交。</span></li>
            <li><strong>空间与物质</strong><span>84 × 52 × 12 体素、通行、可达位置、掉落物和材料响应。</span></li>
            <li><strong>水流与机械动力</strong><span>河道持久化有向 water current 段，段是否可用仍由当前 Water 体素与上游连通性现场派生；干旱可把河水蒸发成 Sand，后续 rain / storm 只会从相邻真实 Water 向生成河道的干涸格逐格补给，普通沙地和孤立干河格不会凭空进水。普通 Water 不能被猜成动力源。完成网络仍须现场复核水流、拓扑、输入与操作者知识；只有成功负载造成磨损。这只是受限机械网络，不代表电力、信号、计算或现代信息能力。</span></li>
            <li><strong>有限真实电网</strong><span>电力不从机械成就标签自动派生。真实的机械发电机、绝缘铜导体与电阻负载必须形成当前仍有效的 source → conductor → load 拓扑；带载运行、磨损/故障、近身诊断、故障后新备件更换和恢复都产生可回放事实。水轮、金属传动轴、天平和标准秤砣各有数组不冲突且符合物理直觉的材料响应；发电机与负载仍分别使用 MechanicalDynamo = DriveShaft + Copper、ResistiveLoad = Copper + FiredBrick。部件都须真实制造、安装和使用；这条链仍不冒充远距信号或计算网络。</span></li>
            <li><strong>身体与人口</strong><span>健康、水分、营养、冷热、伤病、衰老、妊娠、普通分娩后的 9–15 个月产后恢复、出生与死亡；魅魔分娩不创建恢复期。普通死亡生成一人一遗体，并把背包变成标记原主人及死亡来源的地面遗物，不向全世界广播。三日凌空是终局例外：第一个规划刻度内全部汽化，随身库存销毁且不生成遗体或遗物。人口接近 50 时受孕机会递减，超过承载能力后资源消耗继续上升。出生同时确定最多三个遗传 / 先民特质和一个随机异变，保存两类完整抽样；双生妊娠提高中止风险并产生两个独立孩子与出生事实，饕餮令月度营养消耗乘 1.5。默认父系命名，任一亲代携带母脉时随母姓并采用母亲命名传统。模型演进可在提交前提议 givenName，但特质、姓氏、顺序、字符、重名与失败回退由本地规则控制。</span></li>
            <li><strong>文明终局</strong><span>三日凌空在 tick 1 先于人物行动清空全部存活者，并于同月结算毁灭；其他路径只有月末无存活者或运行达到显式 endpoint 时结束。全员脱水休眠不是终局；环境、身体代价、纪元切换与恢复仍继续推进。</span></li>
            <li><strong>生态</strong><span>植物生长、动物迁移 / 捕猎 / 繁殖，以及风暴、干旱、冰雪和火。</span></li>
          </ul>
          <code>domain/monthly-processes.ts · world/grid.ts</code>
        </details>

        <details class="rule-branch" data-tone="agent" open>
          <summary><span>人物事实</span><small>规划器只能读取本人可获得的信息</small></summary>
          <ul>
            <li><strong>创世先民</strong><span>每局按种子从 101 人档案池确定性抽取 5–12 位，也可由配置显式指定最多 12 位；共同抵达事实列明全体先民，后代不会继承这条开局来源。</span></li>
            <li><strong>局部感知</strong><span>可见格、可见人物 / 动物 / 掉落物 / 暴露遗体，以及真实可达性；有标记墓穴可让来访者得知死者，未标记墓穴不泄漏身份。</span></li>
            <li><strong>记忆与知识</strong><span>近期事件、有来源的已知地点、技术置信度、关系和失败经验；本人亲历动作还保存机器可读的 basis、结果、效价与参与者。Action 后验用于预计努力与伤害，Intent goalOutcome Beta 后验决定目标成功预期：未受孕可以是 completed 动作与 attempted-unmet 目标，无真实受孕样本的提前阻塞是 not-evaluated，不写入目标后验。生殖方向被实际选中时，DecisionFact 另冻结 generativity、motivation、aspiration、关系门、准备度五个分量及其来源，供事后审计，不把观察器结果变成人物奖励。灵记把个人记忆容量与留存提高 50%，但不产生知识；先知出生时可靠掌握当前全部 47 项规则配方，仍不获得材料、地图或行动豁免。失败重试优先从 terminal Intent 引用的真实 blocked / failed ActionFact 读取实际动作，再比较动作、目标、数量、人物、项目、记录与关系组成的结构 basis；容量有限的自传记忆只作兼容，不比较临时 option ID 或显示摘要。成年人只有在历史估计进入未来六个月窗口后才会形成纪元预言，不能读取隐藏调度或发布几年后的远期预言。</span></li>
            <li><strong>能力证据</strong><span>observed 只证明看见；accessible portable 只含本人背包和可取得掉落物；placed facility 必须是世界中真实放置、记忆后重新核对仍在场的设施。旁人背包不能冒充本人工具或公共设施。</span></li>
            <li><strong>工具升级与采用</strong><span>生产工具按木 / 骨、石器、石锄、青铜、铁的真实效用等级比较；低级工具只部分缓解劳动压力。本人近期真实生产劳动可提高可达高级地面工具与交换报价的价值；他人背包工具只能经同格自愿交换。既有路径仍允许持有者用更高阶备用工具替代待交换的低阶单件；青铜工具还可在至少保留石制生产工具时交换，其他最高阶单件不会被自动让出。移动后的采集、收获与捕猎会重新选择本人当前实际效用最高的适用工具。</span></li>
            <li><strong>年龄与能力</strong><span>未满 1 岁依赖亲代；1–11 岁可自主跟随、取水、拾取、学习和简单劳动，但普通移动不得逐格漂出当前可见亲代的本地照护半径，严重压力时只可走向当前可见亲代；12–15 岁可生产及协作既有项目；16 岁起才有完整规划能力。</span></li>
            <li><strong>身体、身份与人格</strong><span>身体储备、状态限制、HEXACO 六维、控制 / 地位敏感度、亲缘认识、共同体职责，以及出生时一次确定、最多三个遗传 / 先民项加一个随机异变且终身不变的特质；父母、子女与兄弟姐妹从 geneticParents 稳定投影，不挤占可衰减的事件记忆。经历只能通过带来源证据缓慢改变人格，不能改写特质。baseline 人格和稳定身份还会派生跨轮一致的 Soul v2：稳定 styleMatrix 与危险、自主、亲近、承诺、未知五个情境侧面可参与合法候选内的个人取舍，但不创造候选或事实。</span></li>
            <li><strong>当前意图</strong><span>一个 BDI 执行焦点；进度、尽责性、项目压力与个人成功预期维持承诺惯性，普通竞争候选不会让它每刻度重抽。其他压力不会同时变成并行动作。直接死亡会终结当前及全部暂停意图；休眠恢复发现目标已终局时按真实样本结算 goalOutcome，只有真正恢复为 active 的意图暂不结算。</span></li>
            <li><strong>候选语义</strong><span>每个生产 ActionOption 都携带 action-option-semantics-v1：义务、普通 / 边沿通道、用途、最低年龄、需要、对话、生殖与社会情境均为 typed 字段。optionId 只作身份、排序、选择和回放；规则规划器与服务端模型网关共用校验，不从前缀、正则或拆字符串猜意义。只有旧存档迁移可使用显式 legacy 解析。</span></li>
          </ul>
          <code>domain/person.ts · domain/person-soul.ts · domain/memory.ts · application/action-options.ts</code>
        </details>

        <details class="rule-branch" data-tone="social" open>
          <summary><span>需要与项目</span><small>持续工作以项目为单位</small></summary>
          <ul>
            <li><strong>生存与安全</strong><span>保温、捕猎安全、照护、熟食与住所容量。</span></li>
            <li><strong>死亡照料</strong><span>人物先因看见遗体、有标记墓穴或有来源传话得知具体死亡，再由关系与人格形成丧亲压力。完整安葬依次搬运、择地挖墓、入葬、用同一次挖掘产生的原土覆土；墓记还要真实消耗空白木板并持有合格工具。</span></li>
            <li><strong>生产与储备</strong><span>工具、耕作、储藏、供水、窑炉、冶金与功能建筑；食物与饮水是独立储备缺口，健康 / 营养 / 水分也是独立身体维度，采食不能缓解缺水，取水也不能缓解低营养。取得型候选只有在本人缺少对应可摄入库存时才承接身体压力；项目压力还绑定精确 projectId，不能被普通采食冒领。受抚养人口会提高生产和储备压力。工具项目的第一件偶然样品不会直接完成，项目来源的更优工具仍须由本人持有，并把对应制作技艺复验到可靠阈值。</span></li>
            <li><strong>住所建材边界</strong><span>住所项目只消耗尚未组装的石、木、木板等实体建材；谷仓、窑炉、容器和机械构件等 placeable 成品保持自身功能，不能被当作通用墙体再次消费。</span></li>
            <li><strong>公共谷仓收敛</strong><span>谷仓构件一旦由项目协作者制成，同月其他人会先等待它落地；真实落地后只继续形成首批储备，不再回退制作第二套设施。已知设施配方只能在仍有对应项目时重复制作，不能作为普通试验把成品堆进背包。仍存在的已完成谷仓会抑制项目受益人和贡献者重复立项，但不会泄露远处库存或赋予远程取用能力。</span></li>
            <li><strong>定居耕作</strong><span>本人计入自己的局部食物与身体压力；附近人口只可提高优先级，不再是启动资格。人物还必须感知到可用种源与可耕作地点；项目锚定局部地块，缺种先取种，并只用本项目真实完成播种的六个不同位置与两次真实收获判定完成。尚未播过的可耕格优先于旧格复种；若固定地块只剩本人可见、可达的夯土，人物可让手中通用生产工具进行有界地表尝试。未知时规划器不读取正确工具、规则或产物；同一工具两次真实无响应后换候选，成功后才形成有 ActionFact 来源的整地技术，工具本身不消耗。</span></li>
            <li><strong>知识与探索</strong><span>因真实缺口触发有限试验、验证、教学和耐久记录。</span></li>
            <li><strong>项目持久性</strong><span>触发事实、压力、场地、材料数量、物流、贡献者、进度与失败均可追溯；完成证据先于所有者死亡结算，已做成的项目不会被误记为放弃。旧搜索只有与当前缺口材料完全一致、晚于最近进展，而且没有协作者、休眠、当月产物落地或作物生长等待时，才进入耗尽候选；即使搜索或实体假说耗尽，也须等到有效复核期限，并距最后真实进展或本次精确关闭至少 4 个月才会阻塞。等待时保留精确缺口、预约和同一项目，不重开相同 campaign；期限前出现精确新来源时原项目直接恢复物流 / 生产。终局失败后 owner + desiredFunction 会继承当时的机会依据；只有精确新材料来源、相关可靠技术、新目标环境或新 verified response 能续证重开，ID、月份、压力、移动与同一来源改名不能。后继首步必须实际使用 renewal；从未发生这类终局失败的普通建造保持原行为。只有真正交付最后功能性动作的人物获得完工 episode；它在 12 个月内对同 need / function 的新项目提案压力最多减少 45%，但绝不伪造库存、水源或住所。便携产物只以当前目标材料栈来源与本项目 actionEventIds 的交集作为完成证据，旧项目同材质产物不会让新项目即时完成。能力载体落地也不自动完成：crop-processing 的本项目 Mill 必须由安装前已有资格的人，在半径 1 内对真实成熟作物完成普通分离并产生高于徒手基线的 Mill 增益；目标消失时只等待，不造作物、换旧设施或伪造功能事实。</span></li>
            <li><strong>局部去重</strong><span>同功能、受益者 / 目标与局部场地重叠时先复用，提交边界再次校验；同刻度竞争创建会合并受益者与触发事实并重绑意图。非所有者只在创建当月有界等待，远处不重叠项目仍可并行。</span></li>
            <li><strong>功能化项目身份</strong><span>同一 need 的不同功能提案在接受前把 desiredFunction 写入最终 ID。全新机械安装计划若仍引用旧粗粒度提案，计划 projectId 随最终 ID 重绑，并重算 plan key / network ID；维护和可靠性提案携带的是既有安装的外部计划，必须继续指向原安装和原网络，不能改成维护项目自身。</span></li>
            <li><strong>材料请求</strong><span>固定场地合金、铁器项目与明确的公共厅堂项目可发起追加式请求；普通 community-coordination 项目不因此获得新通道。open / fulfilled / expired / contributors-unavailable 从期限、实时缺口、贡献者与真实转移派生。转移精确引用请求，并按请求余量和当前缺口截量；固定冶金项目把材料送到作坊工位，不追逐移动中的 owner。</span></li>
            <li><strong>古代设施接续</strong><span>公共厅堂可由人物已经观察到的青铜 / 青铜工具、烧结砖，以及木牍或可制作木牍的木材与石制工具发起，不要求发起者先独占全部终材；缺料仍须经真实请求与转移汇合到固定工地。铸造场建成且本人可见或有可核对地点记忆时，后续青铜项目返回铸造场。观察到青铜能力与烧结砖可提出铁匠铺；Smithy 真实落地后，铁料、还原、锻打与铁制工具项目才逐段返回该工位。真实生产动作把设施写入事件，并兑现批量加成。</span></li>
            <li><strong>记录发布</strong><span>选题优先回应作者本人实际听到且仍开放的项目知识请求；作者必须可靠掌握与请求产物精确匹配的技术，并且已无法与请求者近距口授。项目所有者随后在固定场地写入空白载体；一旦背包中已有与项目、知识和写入事实精确匹配的已写载体，返回场地并投放到精确地面优先于旧搜索 / 物流。没有合格请求时仍可按原年龄 / 记忆压力自然选题；成功投放沿既有项目完成事实收口。</span></li>
            <li><strong>度量压力</strong><span>本人至少 3 次、跨 2 个月的生产经验，可由近期情景记忆或本人带源技术知识中的生产 provenance 保留；它必须对应本人当前持有、处于同一粗手感档的两个实体批次，并每次重验执行者、实体栈、生产动作与材料。这是局部不确定性，不注入精确质量或隐藏配方。</span></li>
            <li><strong>材料功能假说</strong><span>精确 BOM 必须能追溯到本人仍可靠的技术 / 记录或本人真实完成的配方事实；activeProject 与 desiredFunction 本身不构成材料知识。有 provenance 的已知技术和实体项目仍可使用精确需求；没有时，问题只表达功能角色与可感知性质，类型中不能携带 material ID、rule ID 或预期产物，模型也只看到感知 profile 与待试验问题。远看只知道相态、外形和表面观感，拿取 / 核验后才知道粗负重与刚性。候选按必需角色、本人或传播来的 response / no-response 证据、信息相关性与可选性质排序，不读取项目目标材料，也没有正确答案加分。campaign 候选 / 尝试 / 关闭预算为 7 / 4 / 3。度量问题仍只提出“两件相同结构件 + 柔性悬挂件”或“稳定参考物 + 可见标记”，已取得的仪器、参考物和已写载体保持受保护实体。</span></li>
            <li><strong>机械试建</strong><span>人物先有本人真实 Mill 劳动压力，再在可见、可达处 attend 具体水流段；项目只冻结来源与可见工地几何，不泄漏 WaterWheel / DriveShaft 配方、时代门槛或观察器目标，未知方法仍走有预算的盲试与验证。部件安装不因短期干涸或结冰丢失已经完成的制造机会；真实 commissioning / operate 仍必须等水流恢复。</span></li>
            <li><strong>电力试建与维护</strong><span>人物只从本人亲历的机械服务、局部可见材料、可靠操作知识或当前故障形成候选；安装计划冻结网络、部件和位置，维护还必须引用个人诊断与故障后制造/核验的替换件。人物不读取现代阶段的三项观察门槛。</span></li>
          </ul>
          <code>domain/project.ts · application/project-options.ts · application/projects/project-frontier.ts · application/project-hypotheses.ts</code>
        </details>

        <details class="rule-branch" data-tone="effect" open>
          <summary><span>动作与后果</span><small>世界规则裁决眼前动作是否合法</small></summary>
          <ul>
            <li><strong>五种原子动作</strong><span>move · transfer · act · attend · communicate。</span></li>
            <li><strong>移动成本</strong><span>每个规划刻度有 2 点地形成本预算：普通平地每边成本 2，连续夯土 / 木板道路每边成本 1，因此道路上可连续前进两格。高成本地形至少允许跨过一条相邻边；路径事件保留全部中间格，体力、代谢、踩踏与规划耗时使用同一累计成本。</span></li>
            <li><strong>有限化身操作</strong><span>第一人称转头、瞄准与查看提示只读；移动命令只从四向邻格中选一条当前合法站立边，即使在道路上也不跨两格。客户端只回传当前投影的 optionId + choiceKey，人物轮次重新编译并由领域层复核；生存、照护与必要避护仍可先接管。建造只展示真实 DecisionContext 中已有的项目 / 建造候选，沿同一材料、场址、Intent / Project 和 ActionFact 规则执行。</span></li>
            <li><strong>十种领域操作</strong><span>exert · separate · combine · expose · ingest · reproduce · hunt · dehydrate · rehydrate · inter。</span></li>
            <li><strong>提交前预演</strong><span>检查目标、路径、材料、工具、授权、身体和空间；person→ground 只能投放到人物当前 cell / z，不能远程落物。</span></li>
            <li><strong>语音与近身</strong><span>普通 voice 沟通允许水平相邻一格且站立高度相差不超过一级；接受 / 拒绝、交换与许可协商、教学和谈话都可隔着这一个相邻站位完成。更远的会合优先选择听者附近占用更低的可达位置。物品交付、照护、生殖、施力和携带仍要求精确同一站位。</span></li>
            <li><strong>载体守恒</strong><span>带 recordPayloadId 的本人库存栈不会进入普通 combine / exert / expose 消耗候选，领域层也在扣减前拒绝；空白载体仍可写入或用于其他合法动作。</span></li>
            <li><strong>机械链裁决</strong><span>工地必须保持冻结水流端点 → 正上方 WaterWheel → 水平 DriveShaft → 新 Mill。安装逐件复核计划、来源、网络、位置、拓扑和本人制造 / 核验事实，但安装瞬间可处于短期失流；commissioning 与 operate 始终要求当前 live flow。首次 commissioning misalignment 记为 progressed、Seed 输入守恒；只有 action、项目、plan key、network、source segment 与世界当前 fault 全部精确一致时，这个实体状态转换才刷新项目复核锚点，普通 progressed 或错绑定事实不能续期。随后必须用故障后新造的新轴与 BronzeTool 维修，维修后的 Seed → Food 作业才完成安装。完成网络只在真实 loaded use 时磨损；阈值后的下一次投入前生成 worn-drive-shaft 实体故障且 Seed 守恒。本人近身诊断后才能发起维护，故障后新制并核验备件、修理和再次带载运行共同证明恢复。可靠操作者只能经明确教导把操作传给相邻语音范围内达到学习年龄的人。临时失流留下计划绑定事实并等待恢复；错源、错计划、错站点或拓扑变化仍在扣减前拒绝。</span></li>
            <li><strong>电力链裁决</strong><span>发电源、导体与负载必须匹配同一冻结计划和当前体素拓扑；只有带具体输入的成功负载作业才累计运行并产生有用负载证据。故障、诊断、更换与再次带载恢复都绑定同一网络与来源事实，不能用新建标签跳过。</span></li>
            <li><strong>客观事件</strong><span>成功或阻塞都写入 ActionFact；库存、位置和身体不可凭叙事改动。</span></li>
          </ul>
          <code>domain/action.ts · domain/action-executor.ts</code>
        </details>

        <details class="rule-branch" data-tone="agent" open>
          <summary><span>社会与学习</span><small>重复的真实协作才可能形成社会结构</small></summary>
          <ul>
            <li><strong>互动</strong><span>先民双向关系从 55 开始；共同抵达只表示同群熟悉，不足以形成结伴，也不能单独作为被拒绝或撤回后的生育重提依据，但首次生育协商及完成、到期后的既有间隔保留原有机会时间带以维持人口频率。关系账本不为从未互动的陌生人预铺零值边；缺失边与旧式 canonical 全零、无来源边同义，首次真实有源互动才创建。新生儿只对出生时仍存活且精确同地的人形成由本人宜人性与外向性决定的单向弱信任 3..9，在世亲生父母另以同一出生事实保留有源亲缘 bond；异地或后来到场者不追授弱信任。“双方都行动且行动后同地”的共同活动按每个人的有效外向性 60% + 宜人性 40% 分别换算：高、中、低社会接近度每 3、4、5 个规划刻度形成一份定向 trust / bond +1，因此双方可以不同步增长；已生效的结伴双方在同一稳定生活区的不同格行动也可累计。当月已有基础增量时，未满 16 岁额外 trust +2，16–29 岁额外 trust +1，30 岁起不加；年龄加成不增加 bond，也不凭空创造关系。事实保存双方各自门槛与增量。单纯同处、空闲、休眠和失败动作不计。结伴仍要求本人有来源的 20 / 20，还需跨至少两个月的非开局双人经历并包含直接交流 / 照护；普通生殖不设关系分数门槛，首次机会保留原有时间带，拒绝后新形成的真实共同活动须经过至少三个月才能成为较弱的重评依据，后续仍由双方分别判断。魅魔是显式特质例外：成年女性可对同地成年男性形成单方生殖候选，不读取关系或对方同意，但事实不得冒充双方协议。</span></li>
            <li><strong>柔性拥挤</strong><span>精确站位超过两名存活人物时，本人产生有界 spatial-comfort 需要，并可自愿一步挪到附近占用更低的站位。它不扣健康、不强制弹开人物、不打断必须回应或生存任务；两人同位、住所容量、人口承载与资源竞争仍按各自规则处理。</span></li>
            <li><strong>共同生活</strong><span>结伴提议保存双方共知的稳定生活地点；生活区内可以各站不同格。日常取水、劳动、学习可各自行动；只在 24 个月约定的时间余量用尽、若不返回就无法累计 12 个月共同生活时，才以空闲生活槽位为目标返回，让待建立关系的已接受约定形成有来源的承诺需要，并按既有 fulfillment 优先协议打断普通工作。仍生效的共同生活关系按已接受 / 已建立、本人对对方的 trust / bond / fear 与当前是否处于共同生活区，连续满足一部分 belonging；多项关系按剩余缺口组合，只削减未满足压力，不删除新关系候选，也不会激活 generativity。结伴、共同体身份或仅仅看见别人都不会自动追踪实时坐标；超出相邻语音范围的生活交谈必须绑定一个有真实来源的话题和后续沟通。无任务目的的日常、回忆和轻松玩笑只在双方已处于相邻语音范围时生成，不驱动跨地追逐。</span></li>
            <li><strong>承诺</strong><span>提议必须回应；生效协议要通过后续行动履约。正向生殖的 needActivation 只能由 NeedAgenda 的 generativity need 产生；魅魔的单方候选由本人的出生特质提供有来源的 generativity 机会，并跳过关系、双方协议和家庭准备度门控。普通生殖中 belonging 与 autonomy 不能激活正向选项，关系、恐惧、人格、同意与风险只在激活后连续门控，拒绝或撤回仍可由 autonomy 驱动。准备度只取本人可感知的当前食物、水、当前可见且确认未占用的真实住所内部位置、照护余量与气候安全，住所质量来自 weatherProtection / thermalInsulation；记忆中的远处住所只保留未验证来源，对 shelter 分量贡献 0。项目记忆不能替代资源；被拒绝或撤回后，新的直接亲密、身体窗口或责任事实可以立即重开评估，新的真实共同活动则至少等待三个月，低压力闲聊始终不能解锁。完成和到期后的既有生理间隔保持原规则。普通接受形成最长四个月的可撤回窗口；普通和魅魔单方路径都限制同一伴侣每月最多一次真实尝试。普通动作精确绑定有效协议并保存当时关系快照，魅魔动作则记录本人、目标、特质来源与 <code>succubus-unilateral</code>，不能形成虚假的 agreement。</span></li>
            <li><strong>近亲风险认识</strong><span>亲缘不改变动作合法性，而是提高后代遗传负荷、出生偏差、寿命压力与后续疾病概率。人物观察或学到这些后果后，风险知识从第一次有源证据起按置信度连续形成软成本；满置信度也不再近似否决。每个关系与身体条件合格的伴侣都保留独立候选，再由同一认知 appraisal 比较关系、责任与亲缘风险。</span></li>
            <li><strong>再次开口</strong><span>普通可选交谈没有固定两月冷却：人物按同受众、同主题和新事实评估重复成本；日常闲聊的一段共同生活来源只生成一次开场，日常、回忆和玩笑本身不自动增加关系分。关系协议更严格：生育提议被拒绝或撤回后，新的直接亲密、身体窗口或责任事实可立即重开评估；新的真实共同活动至少经过三个月才可提供较弱的重评依据，低压力闲聊始终不能解锁。结伴提议还至少等待六个月，并要求新的直接亲密或责任事实；生育协议到期或完成后的原有生理间隔保持不变，间隔届满可重新评估。协议幂等、每人一次回应、同一事实 basis 与开场回应去重仍是硬门禁。</span></li>
            <li><strong>情境合作后验</strong><span>人物按“目标人物 × typed cooperation context”分别学习回应、接受意愿与履约可靠性；拒绝只影响意愿，没有回应只影响回应率。只有真实履约 / 违约、带贡献证据的共同项目完成，以及授权贡献到分配闭环，才影响可靠性；生殖不进入合作信誉。多人可选发起在同情境保留后验最高两名并按人物 / 月份稳定轮换一名探索对象，required response、履约 / 撤回和生殖绕过。</span></li>
            <li><strong>死讯传播</strong><span>loss 对话要求说话者先有具体死亡来源，并与听者实际完成沟通；听者此后才形成引用同一死亡事实的记忆和丧亲经历。远处未知者不会自动悲哀；远处未成年子女即使已经客观死亡，也不会自动从亲代的 reproductiveResponsibility 中消失，亲代取得引用该死亡的有来源认知后才释放责任。</span></li>
            <li><strong>传播</strong><span>观察到的成功可复查、教导、模仿或写入实体记录。直接教学通常把技术知识提升到 60；当教师可靠掌握青铜工具制作、身边学习者近期有真实生产劳动且尚无同等工具时，这项教学可进入前三个候选，并引用学习者的劳动事实。普通教学的既有排序不变。母脉出生链中的母亲第一次真实成功教导孩子时提升到 72，必须仍有完成的教导动作。阅读只形成不高于 54 的暂定知识，真实项目实验才使它上升并可能跨过 55 的可靠阈值。</span></li>
            <li><strong>记录复用</strong><span>V3 候选服务读者自己所有活跃项目的真实技术缺口，不要求该项目正占用当前 intent；只看本人背包与可见公共地面记录，并冻结 exact carrier source。地面正常链为 move → acquire → read → prepare-experiment → experiment：move 不计取得，只有精确 drop 成功转入本人背包才算 acquire，来源消失或替换时不换源。记录技术必须精确编译为该项目步骤，但阅读前不用先拿齐实验输入；阅读只形成暂定知识，后续逐 tick 重编译普通项目物流，输入到位后才绑定并执行真实实验。自解码、阅读和准备都不替代最终产物与置信度变化证据。</span></li>
            <li><strong>实践与制度</strong><span>至少跨两个不同月份的可靠合作才形成本人有来源的 supported coordination practice；后续违约或可靠性反证把它标为 contested。只有 supported practice 能开放共同体、成员或治理规则提议，一次回应、一次履约或一个项目不能直接生成制度。提议仍须有真实物质需要 / 不均事实并由参与者接受，practice 本身不授予规则、角色或权力。共同体只剩一名在世成员时进入 dormant；全部在世参与者接受后才可恢复 active，dissolved 共同体不能复活。</span></li>
          </ul>
          <code>application/social-options.ts · application/cognition/social-expectation.ts · application/record-use-options.ts · domain/social-learning.ts · domain/social-space.ts · domain/social-repetition.ts · domain/agreement.ts · domain/shared-living.ts · domain/governance.ts</code>
        </details>

        <details class="rule-branch observer-branch" data-tone="observer" open>
          <summary><span>观察与表现</span><small>只读，不参与人物选择</small></summary>
          <ul>
            <li><strong>文明指数</strong><span>人口、疆域 / 设施、科技、社会与历史的事后投影。</span></li>
            <li><strong>能力里程碑</strong><span>从事件证据链识别实践、阶段与复杂性，不向人物发奖励。</span></li>
            <li><strong>阶段归并与直接晋级</strong><span>v7 独立核验各阶段事实包并选择已完整闭合的最高层，不要求文明按标签顺序执行或逐级停留。原中世纪已并入古代文明，旧 v1–v4 快照中的 medieval 只是兼容别名。唯一最高阶段为“现代文明（含信息能力）”；它核验完整电网首次完成真实有用供电；标定后的可比质量测量；以及真实项目、记录、读者/作者、知识/codebook、实验产物与置信度从暂定跨过可靠阈值均闭合的他人记录复用。电网项目本身已经闭合部件制造、核验、安装、拓扑与真实有用负载。三项事实闭合后，在下一次权威观察提交时直接从任何较低阶段晋级，没有额外稳定月份。它不要求 CI、人口、年份或古代前置；钢、混凝土、信号、计算与自动化只是现代内部后续成就。门槛以小型、可见、可操作、可回放和明确成就感为准；人物不读取这些门槛。</span></li>
            <li><strong>住宅文化风格</strong><span>古代文明的已完工真实住所按世界种子与结构锚点稳定选择中国古建或西方中世纪形制；只更换台基、柱墙、木骨与屋顶等装饰语汇，不改变权威占地、材料、容量、防护、窗光或炉火事实。</span></li>
            <li><strong>耕作能力与当前土地</strong><span>当前耕作区只表示眼下仍存在的幼苗、成熟作物或贫瘠地，继续服务疆域与容量；阶段观察器 v7 仍只用同一已完成项目场址附近六个不同播种格，以及发生在这些播种格上的两次成熟收获证明既成能力。土地恢复不会抹掉闭环，零散、场外播种或项目外收获也不能冒充闭环。</span></li>
            <li><strong>成就展示</strong><span>现代阶段的代表卡为“电力与知识站”，以发电机、导体、有用负载、度量衡和记录架表达三项可见闭环。它是只读象征预览，不会在权威世界中凭空生成建筑、设备或能力。</span></li>
            <li><strong>死亡照料观察</strong><span>只有真实死亡、完整安葬与物质墓记来源闭合才识别对应能力；多人跨时段重复安葬才可能派生制度。</span></li>
            <li><strong>事实报告</strong><span>运行摘要、转折点、毁灭原因和文明编号都来自真实历史。记录完整链还必须通过同一 basis 的身份、项目、payload / codebook、精确取得、阅读理解、实验产物、置信度从低于 55 上升到至少 55、顺序及项目进度守卫；外部 exact-lineage 交付或既有已读可按真实状态继续，但不补造阶段、不计完整链。</span></li>
            <li><strong>文明纪事</strong><span>规则投影筛选文明开端、纪元切换、重要天气、野兽袭击、死亡、出生、协议、关键技术与项目完成，也允许已完成回应的日常、回忆和轻松玩笑进入近期纪事；只记录一轮回应，避免开场和回应重复刷屏。死亡只在来源链确实包含袭击且对象一致时归因给动物。同源原子动作在表达层归并，但纪事仍保留全部 sourceEventIds、涉及人物和可展开事实详情；模型只能压缩这组已筛事实。闲聊数量不计制度、阶段或文明指数。</span></li>
            <li><strong>口头台词</strong><span>主动对话、决策 utterance 与 speech-only 共用人物 Soul 保持同一声音；每轮只激活一个最相关情境侧面，记忆按话题与真实听者筛选，年龄 / communication 能力限制句式。speech-only 还从当前 speechAct、人格、控制敏感度、身体压力、关系及有源冲突派生 neutral / warm / familiar / guarded / blunt / confrontational 姿态：日常陈述默认 neutral，低信任通常先 guarded，blunt 只在边界话语与低宜人性、控制敏感或急迫压力共同支持时出现。命令式短句不要求礼貌词，但直接不自动等于不耐烦；敌意只由真实伤害、背约或拒绝后重复施压开放。规则动作只投影结构化 speechAct，不提供可显示原话。只有成功模型文本才绑定 completed voice communicate ActionFact 进入 GameFrame；失败时保留沟通事实但不显示文字气泡。</span></li>
            <li><strong>体素装饰</strong><span>把已有建筑、动作、天气和身体事实映射成画面，不写回世界。分离动作读取已提交 ActionFact 的源材质：结果灌木显示为采集野果，成熟作物显示为收割，不因人物携带工具就把野果采集画成耕种。</span></li>
          </ul>
          <code>domain/civilization-index.ts · domain/era-progression.ts · projection/derived-observations.ts · projection/ · voxelKits.ts</code>
        </details>
      </div>
    </section>

    <section class="rules-section" id="decisionTree" aria-labelledby="decisionTreeTitle">
      <div class="section-heading">
        <div><span class="section-no">03</span><div><span class="section-kicker">DECISION TREE</span><h2 id="decisionTreeTitle">每个规划刻度，人物怎样决定</h2></div></div>
        <p>决定不是一次性抽签。稳定意图默认延续；只有紧急反射、必须回应、履约、真实的新机会、客观停滞，或人物在自然对话中亲自选定的合法方向能改变焦点。界面不要求玩家区分聊天与建议；服务端先保守判定 actionChoiceRequested。第一阶段只生成并校验角色回复，模型误带旧版行动字段不会再拖垮回复；纯问题不暴露他人的 required response，也不触发隐藏意图调用。明确行动请求才用第二个 prompt 从已生成回复中提取意图，失败时静默保留回复；只有明确承诺且通过本地校验的 accept + choice 进入行动链。下一月只做本地稳定 key 重配，不再让模型重新决定。</p>
      </div>

      <div class="decision-map" aria-label="人物详细决策树">
        <div class="decision-tree-legend" aria-label="节点图例">
          <span data-kind="condition">条件</span>
          <span data-kind="process">处理</span>
          <span data-kind="action">动作</span>
          <span data-kind="terminal">出口</span>
          <small>分支线上标明条件结果；横向滚动可查看完整树。</small>
        </div>

        <section class="decision-phase" aria-labelledby="gateTreeTitle">
          <header><span>01 · EXECUTION GATE</span><h3 id="gateTreeTitle">先处理不可推迟的身体与照护事实</h3><p>一次推进先固定 atMonth = elapsedMonths + 1，再用同一月份运行月初过程、候选 / 重编译、年龄与协议门禁、15 个规划刻度和事实 ID；只读查询仍停留在已提交月，创世是显式零月例外。每个刻度中，存活人物按种子确定的稳定顺序读取刚刚提交过的世界。</p></header>
          <div class="decision-tree-scroll">
            <ol class="logic-tree">
              <li>
                <article class="logic-node" data-kind="process"><span>MONTH START</span><h4>推进月初世界</h4><p>纪元 / 跨月天气过程 → 预言结算 → 自然过程 → 协议与授权 → 记忆维护。</p></article>
                <ol>
                  <li><span class="edge-label">planning tick × 15</span>
                    <article class="logic-node" data-kind="condition"><span>G1</span><h4>人物仍存活？</h4><p>参与者列表只保留活人；刻度内再次检查。</p></article>
                    <ol>
                      <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="terminal"><span>EXIT</span><h4>跳过本刻度</h4><p>不产生人物动作。</p></article></li>
                      <li><span class="edge-label edge-yes">是</span>
                        <article class="logic-node" data-kind="condition"><span>G2</span><h4>脱水休眠 episode 当前相位？</h4><p><code>dormant</code> 禁止普通行动；重新水化或恒纪元转换只进入 <code>recovering</code>，不会凭空补足储备。留下真实补给来源且三项最低储备达到 45 后，下一月月初退出 episode；若乱纪元重临则沿用原 episode 回到 <code>dormant</code>。全员休眠不会终止文明。</p></article>
                        <ol>
                          <li><span class="edge-label edge-yes">dormant</span><article class="logic-node compact-node" data-kind="terminal"><span>HOLD</span><h4>维持低代谢与原位置</h4><p>本人不行动，也不会随亲代移动；每月仍消耗 0.35 水分、0.30 营养和 0.25 健康。认可待验证预言者不会提前唤醒；质疑者只能尝试一次，预言结算再改变双方关系。</p></article></li>
                          <li><span class="edge-label">recovering</span><article class="logic-node compact-node" data-kind="action"><span>RECOVER</span><h4>只执行真实补水补食链</h4><p>只允许必要移动、取得水 / 食物并摄入；未满 1 岁的依赖幼儿只能摄入本人已有物品，照护者可在近身水源旁每月协助补水一次。普通规划与原意图继续挂起。</p></article></li>
                          <li><span class="edge-label edge-no">无 episode</span>
                            <article class="logic-node" data-kind="condition"><span>G3</span><h4>本人或依赖者谁更紧急？</h4><ul><li>本人：水分 &lt;58、有食物且营养 &lt;52、无食物且营养 &lt;34，或已有冷热压力。</li><li>1–11 岁本人若水分 &lt;32、营养 &lt;34、健康 &lt;45 或已有冷热状态，会把当前可见亲代作为有 <code>caregiverRef</code> 的局部会合目标，不读取视野外位置。</li><li>依赖者：视野内、12 岁以下的亲生子女，比较缺水、缺食、健康与冷热压力；不读取视野外身体。</li><li>两边先换算到同一紧急度尺度；孩子危机更重且存在可执行帮助时优先照护，而非固定本人在前。</li><li>未满 1 岁的清醒婴儿不会独自迁移，同处亲代移动时会被携带；脱水休眠者始终留在原位。</li></ul></article>
                            <ol>
                              <li><span class="edge-label edge-yes">本人更急</span><article class="logic-node compact-node" data-kind="action"><span>REFLEX</span><h4>创建生存子中断并执行</h4><p>饮水 / 进食 / 移动 / 拾取 / 采集；完成后恢复原项目。</p></article></li>
                              <li><span class="edge-label edge-no">没有</span>
                                <article class="logic-node" data-kind="condition"><span>G4</span><h4>年轻依赖者需要紧急照护？</h4><ul><li>视野内、12 岁以下，优先身体储备最低者。</li><li>未近身时，只有安全脱水条件成立、亲代手中有可转移食物，或婴儿可被携带去取水 / 找食物 / 入住所，才先会合。</li><li>没有可执行近身帮助时不追逐移动中的孩子；满 1 岁后的取水与避护仍来自孩子自己的合法行动。</li></ul></article>
                                <ol>
                                  <li><span class="edge-label edge-yes">孩子更急</span><article class="logic-node compact-node" data-kind="action"><span>CARE</span><h4>创建照护子中断</h4><p>若未近身先沿真实可达路径会合，再转移手中食物、携婴寻找水 / 住所或帮助脱水；不把这段时间算作父项目停滞。</p></article></li>
                                  <li><span class="edge-label edge-no">不需要</span>
                                    <article class="logic-node" data-kind="condition"><span>G4-B</span><h4>年龄允许进入哪层规划？</h4><ul><li>未满 1 岁：留在亲代身边或原地等待照料，清醒时由同处亲代携带。</li><li>1–11 岁：不再自动随亲代移动；可做取水、拾取、学习、采收、拾柴等简单劳动，但普通目标须留在当前可见亲代的本地照护半径内。</li><li>12–15 岁：可参与生产与既有项目，不能发起重大项目或繁衍。</li><li>16 岁以上：进入完整规划。</li></ul></article>
                                    <article class="logic-node" data-kind="condition"><span>G5</span><h4>应继续留在住所？</h4><p>本人或同处依赖者有 ≥1 级冷热压力，脚下是真实遮蔽，照护者水分 ≥45、营养 ≥40，且没有更具体的住所改造项目。</p></article>
                                    <ol>
                                      <li><span class="edge-label edge-yes">是</span><article class="logic-node compact-node" data-kind="terminal"><span>HOLD</span><h4>记录避护子中断</h4><p>保持位置，不伪造“休息动作”；父意图随后恢复。</p></article></li>
                                      <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="process"><span>NEXT</span><h4>进入本地规划</h4><p>判断继续、打断或创建意图。</p></article></li>
                                    </ol>
                                  </li>
                                </ol>
                              </li>
                            </ol>
                          </li>
                        </ol>
                      </li>
                    </ol>
                  </li>
                </ol>
              </li>
            </ol>
          </div>
        </section>

        <section class="decision-phase" aria-labelledby="intentTreeTitle">
          <header><span>02 · INTENT SELECTION</span><h3 id="intentTreeTitle">再判断现有意图该继续、被中断还是被替换</h3><p>规划器只给本人可见、可达、有记忆来源的候选排序。文明指数、时代进度与里程碑不会进入候选或分数。</p></header>
          <div class="decision-tree-scroll wide-tree-scroll">
            <ol class="logic-tree">
              <li>
                <article class="logic-node" data-kind="condition"><span>P1</span><h4>本刻度需要重新审视吗？</h4><ul><li>没有当前意图；有效生殖窗口可继续或撤回，魅魔也可形成单方候选，但同一伴侣对当月完成一次尝试后都不再重复采样。待回应 / 待履约协议只有在当前上下文确实存在合法 required / fulfillment 候选时才走独立 edge，不冒充普通复核。</li><li>共同生活协议只在剩余期限已不足以补齐 12 个生活月时形成返回义务；目标是双方共知的固定生活区，不是同伴实时位置。</li><li>tick 1：健康 &lt;35，水分 / 营养 &lt;28，或冷热 / 伤病 ≥2 级。</li><li>意图已越过有界复核月；或距上次进展 ≥2 个月且目标未满足。采集、储藏、放置、种植和知识默认达成即结算；只有选项显式声明 maintain-state 才在达成后继续维护。</li><li>另行探测：月初生活复核、真实 preview 确认匹配项目缺口的记录、技术示范请求、需回应的真实对话，以及本人在一次玩家建议回复中已经选定、等待本地重验的合法方向。</li><li>每人每月通常一次普通广义选择；本月创建、复核或跨月带入的根意图真实完成 / 阻塞 / 失败 / 放弃，且完整处理中断返回后没有父意图恢复时，下一 tick 最多再获得一次。第二次即使 idle 也在暂存月度额度与重放哈希中消费，但不制造无变化的持久 DecisionFact。真实记录、紧急生存、履约、技术示范和本月新 required proposal / 对话走独立边沿通道；required response 始终优先。</li></ul></article>
                <ol>
                  <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="terminal"><span>CONTINUE</span><h4>不重新决策</h4><p>直接编译当前长期意图。</p></article></li>
                  <li><span class="edge-label edge-yes">是</span>
                    <article class="logic-node" data-kind="process"><span>P2</span><h4>在只读快照中编译候选</h4><p>输入只有可见格 / 人 / 动物 / 掉落物、本人记忆与知识、项目、协议、权限和当前意图。记录使用只检查本人拥有的活跃项目及真实技术缺口，载体来源限于本人背包与调用方已过滤的可见公共地面掉落物；不读他人背包、知识或意图，也不进入通用对话 follow-up。精确匹配后，认知 appraisal 可从记录 basis 重新验证当前项目并继承其 need / pressure / commitment，但记录子意图仍不写普通 projectId，取得和阅读不会冒充项目进展。普通材料物流只统计空白可消费载体；旧 episode 若锁定的掉落物现已承载记录便立即失效。预览搜索路线和物流步骤不会打开真实 campaign 或改写项目；嵌套 planning preview 继承外层当月 overlay，使候选动作与提交前重编译看到相同事实。年龄门禁在每次编译时执行。固体放置与领域执行器复用同一体素结合产物规则，机械 / 电力安装从自身冻结 action basis 取得精确安装位；无论是眼前 nextAction、移动后的 completionAction，还是移动 / 物流结束后才由 active intent 重编译出的放置，目标仍是空气却被身体占据时都只等待，不提交失败事实。身体离开后下一 tick 自然重编译；目标若已不再是空气则仍进入领域失败与项目复核。相同结构失败 basis 优先从 terminal Intent 引用的真实 blocked / failed ActionFact 重建；失败当月完全相同的实际动作不会因换 goal / project 被第二次普通复议原样提交，跨月后再按完整 basis 与新来源判断。第 0–6 月冷却、第 7 月恢复，兼容 failure memory 同样显式保留这 7 个月；required / fulfillment 绕过，旧自由文本无法还原 basis 时 fail-open。相似的可选社交不按固定月份删除，而在后续认知 appraisal 中评估重复成本。</p></article>
                    <ol>
                      <li><span class="edge-label">候选已生成</span>
                <article class="logic-node score-node" data-kind="process"><span>CAUSAL BDI</span><h4>Belief → Desire → Intention</h4><ul><li><b>硬优先级先行</b>：可感知的紧急休眠先于 required response，required response 又先于 fulfillment；若当前已经在执行回应或履约，新义务保留排队，不无条件打断。</li><li><b>B · Belief</b>：DecisionContext 只含局部感知、有来源记忆 / 知识、当前项目与承诺。Action 结果后验与 Intent goalOutcome 后验分离；后者决定目标成功预期。</li><li><b>D · Desire</b>：NeedAgenda 从身体、安全、照护、储备、能力、承诺、归属、generativity、自主与探究压力派生有界需要；仍生效的共同生活按关系质量与实际同居连续满足一部分 belonging，只削减未满足缺口。正向生殖只能由 generativity 激活，belonging / autonomy 不能旁路激活。普通生殖的关系、人格、双方同意与准备度只在激活后连续门控；魅魔由特质来源形成 generativity 并跳过这些社会门控，但不能跳过成年、异性、同地、在世和未妊娠等物理事实。</li><li><b>有界前向</b>：廉价排序后只比较最多 4 个根、每节点 2 个后继、深度 3、一次人物决策 24 节点；选择与执行审计复用同一树，required / commitment 与 follow-up 不另展开。只命名本人有来源的 response / no-response / verification / replan。没有真实两难、替代项或观察不会改变下一选择时 VoI 为 0；硬义务与急性生存优先不被绕过。</li><li><b>I · Intention</b>：候选先跨过本人 aspiration，再与当前 Intent 的进度、尽责性、项目压力、停滞和切换边际比较；每人只有一个执行焦点，急性任务保存可返回父意图。</li><li><b>因果排序</b>：需要使用概率并集，其他因素使用有明确语义的乘法门控；前向 / 信息软调整分别封顶 0.08 / 0.04，不再把九个任意量纲直接相加。稳定种子只以万分之一破真正同分。</li><li><b>计划与行动</b>：Project / HTN 从 Intention 编译下一步，领域执行器重验；提交的 ActionFact 更新动作 Belief，Intent 结算再独立更新 goalOutcome Belief，直接死亡与休眠恢复终局也不能旁路这一步。</li><li><b>诊断兼容</b>：旧 factor forest 只把 need、care、commitment、learning、relationship、social-repetition、consent、feasibility、harm 投影成理由与来源，不再拥有排序权。</li><li><b>可选模型重选</b>：实时模型与规则规划器共用 action-option-semantics-v1 完整校验；ID 只是不透明句柄。模型只看合法候选和同一只读 cognition 投影，开局、危险和既定履约不进入重选，返回后仍再次校验 option、follow-up 与结构化立场。</li></ul></article>
                        <ol>
                          <li><span class="edge-label">检查意图</span>
                            <article class="logic-node" data-kind="condition"><span>P3</span><h4>已有当前意图？</h4><p>每人只有一个执行焦点；中断会保存可返回的父意图。</p></article>
                            <ol>
                              <li><span class="edge-label edge-no">没有</span>
                                <article class="logic-node" data-kind="condition"><span>P4-A</span><h4>有候选跨过本人的 aspiration？</h4><p>选择 motivation ≥ aspiration 的最高候选。结构化提议、预测和教学不强配后续动作；只有生活对话与后续行动共享人物、项目或来源事实时才组合。</p></article>
                                <ol>
                                  <li><span class="edge-label edge-yes">有</span><article class="logic-node compact-node" data-kind="action"><span>START</span><h4>创建新意图</h4><p>记录选项、目标、来源事实与生命周期；默认达成即结算，显式等待才维护，旧 stateGoal 只作存档兼容。</p></article></li>
                                  <li><span class="edge-label edge-no">没有</span><article class="logic-node compact-node" data-kind="terminal"><span>IDLE</span><h4>保持空闲</h4><p>无合法候选，或所有候选都没有跨过本人当前行动阈值。</p></article></li>
                                </ol>
                              </li>
                              <li><span class="edge-label edge-yes">已有</span>
                                <article class="logic-node interrupt-node" data-kind="condition"><span>P4-B</span><h4>挑战者足以越过意图持续门槛？</h4><ol><li><b>优先义务</b>：紧急休眠、必须回应与履约在普通 BDI 竞争前处理；已经开始的优先义务先完成，新义务随后保留。</li><li><b>子中断</b>：回应、履约、生活复核或记录使用只有在父项目 / 返回上下文存在时保存可返回父意图。</li><li><b>生活复核</b>：低风险陪伴请求、正式结伴或生殖等具体关系候选，先满足生活压力 ≥ 项目压力 +10，随后仍须成为跨过 aspiration 的挑战者。</li><li><b>意图惯性</b>：同项目最佳步骤直接继续；否则比较进度、尽责性、项目压力、成功后验、停滞和切换边际。</li><li><b>替换证据</b>：期限已过、急性身体 / 安全 / 照护需要、持续停滞，或不同挑战者明显强于当前承诺。</li></ol></article>
                                <ol>
                                  <li><span class="edge-label edge-yes">有返回上下文</span><article class="logic-node compact-node" data-kind="action"><span>INTERRUPT</span><h4>创建可返回的子中断</h4><p>回应、履约、生活复核、记录使用，以及生存 / 照护 / 避护完成后返回父意图。</p></article></li>
                                  <li><span class="edge-label edge-yes">越过持续门槛</span><article class="logic-node compact-node" data-kind="action"><span>REVISE</span><h4>改用当前最佳目标</h4><p>期限、急性需要、停滞或明显更强的不同挑战者触发替换。</p></article></li>
                                  <li><span class="edge-label edge-no">未越过 / 义务执行中</span><article class="logic-node compact-node" data-kind="terminal"><span>CONTINUE</span><h4>保持原意图</h4><p>继续同一目标，或先完成已经开始的优先义务。</p></article></li>
                                </ol>
                              </li>
                            </ol>
                          </li>
                        </ol>
                      </li>
                    </ol>
                  </li>
                </ol>
              </li>
            </ol>
          </div>
        </section>

        <section class="decision-phase" aria-labelledby="compileTreeTitle">
          <header><span>03 · ACTION COMPILATION</span><h3 id="compileTreeTitle">最后把意图编译成一个可裁决、可回放的动作</h3><p>项目不是直接“完成”。规划器逐步补齐材料、路线、数量、工具与授权，每个刻度最多提交一个原子动作。</p></header>
          <div class="decision-tree-scroll">
            <ol class="logic-tree">
              <li>
                <article class="logic-node" data-kind="condition"><span>C1</span><h4>已选择目标的下一步可提交？</h4><p>候选阶段只做快照预览；选择后才在权威项目上检查数量缺口、AND / OR 材料需求、已知操作、固定场地、贡献者并提交搜索 / 物流状态。局部等价项目在提交边界再次去重：复用权威项目、合并受益者与触发事实、重绑意图；非所有者只可在创建当月等待已有步骤。</p></article>
                <ol>
                  <li><span class="edge-label edge-yes">是</span><article class="logic-node" data-kind="process"><span>C2-A</span><h4>生成直接动作</h4><p>从 move / transfer / act / attend / communicate 中选择一步；act 再指定物质操作。地面记录来源依冻结 basis 逐步执行 move → exact transfer-to-self（acquire）→ own-inventory attend（read）→ 同一项目真实 act（experiment）；acquire / read 保持为可返回的记录子意图，只有准备与实验进入项目动作账本。同月取得的多条记录以各自权威 transfer 事件区分实体栈。外部 exact-lineage 交付或既有已读只允许依当前真实状态继续，不补动作历史。</p></article></li>
                  <li><span class="edge-label edge-no">缺来源或方法</span>
                    <article class="logic-node" data-kind="condition"><span>C2-B</span><h4>本人有可用证据？</h4><ul><li>看见不等于可用：便携物必须在本人背包或当前可取得的掉落物中；设施必须真实放入世界且记忆位置仍可核对。</li><li>可见或有来源记忆的材料地点 → 生成路线 / 取材。</li><li>固定场地合金、铁器项目与明确的公共厅堂项目可向眼前有材料的人发追加式请求；普通协调项目不扩展。贡献转移精确引用请求，并按请求余量和实时缺口截量；冶金材料送到固定作坊，不追逐 owner。</li><li>已建且可核对的铸造场承接青铜冶金；观察到青铜能力与烧结砖可提出铁匠铺，Smithy 落地后铁料、还原、锻打与工具阶段逐段返回该工位。设施必须出现在实际生产事件中，不能只靠项目标签计使用。</li><li>水力机械只接受本人 attend 过的具体可用水流段；计划冻结源与直线工地，未知部件仍走盲试。冻结格若被后来实体占用，首次失败留下来源绑定的场地冲突并停止原址重试；尚无已装部件时，当前负责人或已亲自复查水流的合法继任者只能从眼前可见、可达、为空且有承托的同水流候选中显式改址，并保留已制造 / 核验构件。部分安装或无候选时不静默搬迁。安装可跨短期失流继续，但 commissioning / operate 必须等 live flow；首次试运转的 progressed 错位故障保留输入，故障后新轴 + BronzeTool 维修，再有真实 Seed → Food 作业才完成。</li><li>未知来源 → 只在有限可见范围内搜索；耗尽后仍先保留精确缺口至复核期限，并距最后真实进展或精确关闭至少 4 个月；期间出现精确新来源便由同一项目恢复。只有期限过后且没有合法等待才阻塞。以后同功能重开必须出现并实际使用精确的新来源或新可靠计划；旧来源换栈、换项目 ID、月份流逝、压力或移动变化都不算。</li><li>未知方法 → 用眼前材料做预算受限的假说试验；问题类型只能表达可感知角色 / 性质，不能表达正确 material ID、rule ID 或预期产物。排序读取本人 / 传播来的 response 与 no-response，不读项目目标材料。度量项目只按对称悬挂和稳定参考角色尝试二 / 三份实体。已经耗尽实体假说的建造项目同样要有新材料类型、新计划、新目标或新 verified response 才能续证。</li><li>已有完整物理链的定居耕作不进入通用材料配方假说：缺种时寻找真实种源；等待湿润或生长时暂不行动。项目还会按本项目已完成播种的不同位置计算缺口，优先使用从未播过的可耕格；只剩本地夯土时，人物以手中通用生产工具做不预告结果的有界地表尝试，真实无响应进入记忆，真实变化才成为可复用技术。</li></ul></article>
                    <ol>
                      <li><span class="edge-label edge-yes">可补齐</span><article class="logic-node compact-node" data-kind="process"><span>REPAIR</span><h4>插入同目标前置步骤</h4><p>移动、取材、恢复、请求协助或有限试验。</p></article></li>
                      <li><span class="edge-label edge-no">仍不可知</span><article class="logic-node compact-node" data-kind="terminal"><span>BLOCKED</span><h4>留下明确阻塞</h4><p>不读取隐藏配方或全局地图。</p></article></li>
                    </ol>
                  </li>
                </ol>
                <ol>
                  <li><span class="edge-label">已生成动作</span>
                    <article class="logic-node" data-kind="condition"><span>C3</span><h4>提交前预演是否合法？</h4><p>检查路径、目标、数量、材料、工具、授权、身体和空间；工具取得固定精确地面来源，生产动作在每次重编译后重新选择本人最佳适用工具。失败时优先在同一目标内局部修复，并留下可供有限冷却与新证据重开的结构 basis。</p></article>
                    <ol>
                      <li><span class="edge-label edge-no">否，可修复</span><article class="logic-node compact-node" data-kind="process"><span>LOOP</span><h4>重编译前置动作</h4><p>下一个可用刻度再预演。</p></article></li>
                      <li><span class="edge-label edge-no">否，不可修复</span><article class="logic-node compact-node" data-kind="terminal"><span>BLOCKED</span><h4>记录失败原因</h4><p>供项目、记忆与后续重评使用。</p></article></li>
                      <li><span class="edge-label edge-yes">是</span>
                        <article class="logic-node" data-kind="action"><span>COMMIT</span><h4>执行至多 1 个原子动作</h4><p>写入路径、消耗、产物、来源与成功 / 阻塞状态的 <code>ActionFact</code>。</p></article>
                        <ol>
                          <li><span class="edge-label">动作后</span><article class="logic-node compact-node" data-kind="terminal"><span>RETURN</span><h4>更新项目并检查中断返回</h4><p>子意图完成 / 阻塞 / 不可用时，恢复父意图的精确上下文；月末再结算身体、人口、项目、共同体与只读观察器。只有无存活者或达到显式 endpoint 才终止；全员休眠仍保留文明并继续世界过程。规则月提交后，完成的口头沟通先成为结构化 speechAct 草稿，只有模型成功表达才显示气泡。</p></article></li>
                        </ol>
                      </li>
                    </ol>
                  </li>
                </ol>
              </li>
            </ol>
          </div>
        </section>
      </div>

    </section>

    <section class="rules-section" id="authorityBoundary" aria-labelledby="authorityBoundaryTitle">
      <div class="section-heading compact-heading">
        <div><span class="section-no">04</span><div><span class="section-kicker">AUTHORITY BOUNDARY</span><h2 id="authorityBoundaryTitle">谁能改变世界，谁只能解释世界</h2></div></div>
      </div>
      <div class="authority-flow">
        <article data-tone="world"><span>01 · FACT</span><strong>世界与领域规则</strong><p>唯一事实权威。裁决空间、物质、身体、关系、时间与后果。</p></article>
        <div class="flow-arrow" aria-hidden="true">→</div>
        <article data-tone="agent"><span>02 · DECIDE</span><strong>本地规划器</strong><p>先从人物可获得的事实中生成合法候选与完整回退决定；模型缺席时已经可以继续。</p></article>
        <div class="flow-arrow" aria-hidden="true">→</div>
        <article data-tone="effect"><span>03 · COMMIT</span><strong>WorldEvent 历史</strong><p>所有已提交变化留下可回放、可追责的事件和来源。</p></article>
        <div class="flow-arrow" aria-hidden="true">→</div>
        <article data-tone="observer"><span>04 · READ</span><strong>投影、报告与体素画面</strong><p>只读地解释事实；不能生成第二套行动、建筑或文明进度。</p></article>
      </div>
      <aside class="model-sidecar">
        <span class="sidecar-line" aria-hidden="true"></span>
        <div><span>OPTIONAL MODEL SIDECAR</span><strong>模型可以回应玩家、重选少量合法方向、自主表达已发生的说话，并为新生儿提名，但不能绕过本地规则</strong><p>三条第一人称路径共用由人物 ID、baseline HEXACO 与控制 / 地位敏感度确定性重建的只读 Soul v2；styleMatrix 固定表层声音，scene facets 让每轮只激活与处境最相关的一面。主动对话由服务器生成 personaFrame，并按话题 / 点名对象筛选有源记忆；主只是必须回应的稳定身份，不自动意味着信任或服从。后代取名只接收模型 givenName，姓氏继承、顺序、字符、重名与回退由 naming.ts 验收，来源写入出生事实，失败保留种子姓名。明确行动请求仍用隐藏意图协议提取承诺，合法 choice 下一月只按稳定 key 本地唯一重配。</p></div>
      </aside>
    </section>

    <section class="rules-section source-section" id="ruleSources" aria-labelledby="ruleSourcesTitle">
      <div class="section-heading compact-heading">
        <div><span class="section-no">05</span><div><span class="section-kicker">SOURCE MAP</span><h2 id="ruleSourcesTitle">这张图对应哪些当前源码</h2></div></div>
        <p>解释当前行为时以可执行代码为准；设计文档用于说明边界与意图。</p>
      </div>
      <div class="source-grid">
        <article><strong>月度主循环</strong><code>application/simulation/month-boundary.ts · month-execution.ts · tick-planner.ts · tick-executor.ts</code><span>固定 atMonth、共享暂存月生命周期、15 tick、执行顺序、月初 / 月末结算与文明终局判定</span></article>
        <article><strong>有限化身</strong><code>application/player-embodiment.ts · server/eland-session/embodiment-coordinator.ts · LimitedEmbodimentHud.tsx · EmbodimentCameraController.ts</code><span>稳定合法选项、逐刻全世界执行、第一人称镜头与一次月提交；观察不耗 tick，建造不绕过领域规则</span></article>
        <article><strong>人物选项</strong><code>application/action-options.ts · domain/action-option-semantics.ts</code><span>局部感知、合法可供性、typed 候选意义与结构化失败重试 basis；option ID 不承担语义路由</span></article>
        <article><strong>因果 BDI</strong><code>application/cognition/** · domain/cognition.ts</code><span>动态需要、人格 / 记忆 / 结果后验门控、有界前向 / VoI 与意图持续</span></article>
        <article><strong>人格学习</strong><code>domain/personality.ts</code><span>HEXACO 初始化、行动证据、跨情境整合与慢速变化</span></article>
        <article><strong>人物 Soul</strong><code>domain/person-soul.ts · server/persona-context.ts</code><span>baseline 人格到稳定 styleMatrix / scene facets，以及按处境、话题和听者选择的只读 personaFrame 与记忆包</span></article>
        <article><strong>人物特质</strong><code>domain/trait.ts · docs/person-traits-v1.md</code><span>固定先民、确定性遗传、随机异变、三项遗传加一项异变上限，以及先知 / 魅魔 / 双生 / 饕餮与身体 / 记忆 / 母脉效果</span></article>
        <article><strong>生命周期</strong><code>domain/life-stage.ts · application/age-planning.ts</code><span>年龄门禁、受限劳动与婴儿移动归属</span></article>
        <article><strong>纪元预言</strong><code>domain/era-prediction.ts</code><span>历史估计、可信听众与休眠唤醒边界</span></article>
        <article><strong>人口承载</strong><code>domain/population-capacity.ts</code><span>受孕概率衰减与超载资源竞争</span></article>
        <article><strong>死亡善后</strong><code>domain/mortuary.ts · application/mortuary-options.ts</code><span>遗体、死亡知情、丧亲需要、物理安葬链与墓记</span></article>
        <article><strong>本地排序</strong><code>application/rule-planner.ts · application/cognition/bdi-deliberation.ts</code><span>硬优先级、aspiration、意图持续与继续 / 中断 / 改计划</span></article>
        <article><strong>模型重选</strong><code>server/backend-decider.ts · model-decision-gateway.ts</code><span>关键上下文筛选、协议请求、候选 ID 归一化与失败回退</span></article>
        <article><strong>人物主动对话</strong><code>server/agent-interaction-gateway.ts · server/persona-context.ts · application/player-interaction-choice.ts · PersonConversation.tsx</code><span>可见回复与隐藏意图两阶段、情境人格帧、定向记忆、表达能力、来源约束事实与本地合法 choice</span></article>
        <article><strong>实时台词</strong><code>projection/live-speech.ts · server/live-speech-service.ts</code><span>结构化 speechAct 草稿、共用 Soul、关系姿态帧与 speech-only 批处理；中性日常为默认，直接表达无需礼貌词，强硬取决于当前话语行为，敌意必须有冲突证据</span></article>
        <article><strong>后代取名</strong><code>naming.ts · server/newborn-naming-service.ts</code><span>确定性保底姓名、父母与处境提名上下文、本地 givenName 验收、出生事实来源与失败回退</span></article>
        <article><strong>共同生活</strong><code>domain/shared-living.ts · domain/agreement.ts · application/social-options.ts</code><span>稳定生活锚点、12 / 24 月履约窗口、独立行动和不追踪成员实时位置</span></article>
        <article><strong>社会学习</strong><code>domain/social-learning.ts · application/cognition/social-expectation.ts</code><span>情境化回应 / 意愿 / 可靠性、top2 + 轮换探索、supported / contested practice 与制度提议门</span></article>
        <article><strong>持续项目</strong><code>application/project-options.ts · application/local-material-evidence.ts · domain/project-material-request.ts</code><span>压力、能力证据、局部去重、材料请求、物流、试验、协作与完成</span></article>
        <article><strong>水流机械链</strong><code>domain/mechanical-power.ts · application/mechanical-power-options.ts · domain/action-executor.ts</code><span>显式有向水流、本人观察、冻结工地、严格拓扑、commissioning、持续负载磨损、实体断轴、个人诊断、故障后备件、修后运行与明确教导</span></article>
        <article><strong>耐久记录</strong><code>application/record-use-options.ts · domain/action-executor.ts · server/evolution-artifacts.ts</code><span>写入发布、载体守恒、读者自有项目、精确来源复用与严格完整链审计</span></article>
        <article><strong>动作裁决</strong><code>domain/action-executor.ts</code><span>五种原子动作与九种物质操作的后果</span></article>
        <article><strong>自然过程</strong><code>domain/monthly-processes.ts</code><span>纪元、天气、生态、身体、出生与死亡</span></article>
        <article><strong>观察器</strong><code>domain/civilization-index.ts · domain/era-progression.ts · projection/derived-observations.ts</code><span>文明指数、当前物理耕作区与可回放耕作闭环的只读阶段门槛</span></article>
        <article><strong>表现层</strong><code>adapter.ts · SocietyScene3D.tsx · src/game/voxelKits.ts</code><span>按 ActionFact 源材质区分野果采集与成熟作物收割，并把其余权威状态映射成人间体素装饰</span></article>
      </div>
      <footer class="rules-footer"><span>ELAND KB · RULE MAP</span><p>规则树帮助看懂“为什么发生”；事件历史负责证明“确实发生过”。</p></footer>
    </section>
  </div>
`;

export function mountRulesPage({ assets = [], selectAsset = () => false } = {}) {
  const recipesPage = document.getElementById('recipesPage');
  const rulesPage = document.getElementById('rulesPage');
  const docsPage = document.getElementById('docsPage');
  const searchPage = document.getElementById('searchPage');
  const assetStage = document.getElementById('assetStage');
  const assetNav = document.getElementById('assetNav');
  const recipeNav = document.getElementById('recipeNav');
  const ruleNav = document.getElementById('ruleNav');
  const docsNav = document.getElementById('docsNav');
  const pages = ['assets', 'recipes', 'rules', 'docs'];
  const tabs = [
    document.getElementById('tabAssets'),
    document.getElementById('tabRecipes'),
    document.getElementById('tabRules'),
    document.getElementById('tabDocs'),
  ];
  if (!recipesPage || !rulesPage || !docsPage || !searchPage || !assetStage || !assetNav || !recipeNav || !ruleNav || !docsNav || tabs.some((tab) => !tab)) return;

  rulesPage.innerHTML = RULES_PAGE_MARKUP;
  const recipeLibrary = mountRecipeLibrary();
  const documentLibrary = mountDocumentLibrary();
  const markRuleNav = (hash) => {
    ruleNav.querySelectorAll('a').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === hash));
  };

  const selectPage = (page, focus = false) => {
    const showRecipes = page === 'recipes';
    const showRules = page === 'rules';
    const showDocs = page === 'docs';
    const showSearch = page === 'search';
    const selectedPage = showSearch ? 'search' : showRecipes ? 'recipes' : showRules ? 'rules' : showDocs ? 'docs' : 'assets';
    document.body.dataset.page = selectedPage;
    assetStage.hidden = selectedPage !== 'assets';
    recipesPage.hidden = !showRecipes;
    rulesPage.hidden = !showRules;
    docsPage.hidden = !showDocs;
    searchPage.hidden = !showSearch;
    assetNav.hidden = selectedPage !== 'assets';
    recipeNav.hidden = !showRecipes;
    ruleNav.hidden = !showRules;
    docsNav.hidden = !showDocs;
    tabs.forEach((tab, index) => {
      const selected = index === pages.indexOf(selectedPage);
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    if (showRules) {
      rulesPage.scrollTop = 0;
      requestAnimationFrame(() => {
        rulesPage.querySelectorAll('.decision-tree-scroll').forEach((scroller) => {
          scroller.scrollLeft = Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
        });
      });
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      const page = pages[index];
      selectPage(page);
      if (page === 'assets') history.replaceState(null, '', '#assets');
      if (page === 'recipes') {
        history.replaceState(null, '', '#recipes');
        recipeLibrary?.selectType('all');
      }
      if (page === 'rules') {
        history.replaceState(null, '', '#ruleOverview');
        markRuleNav('#ruleOverview');
      }
      if (page === 'docs' && !window.location.hash.startsWith('#doc-')) {
        documentLibrary?.selectDocument('module-boundary');
      }
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = tabs.indexOf(tab);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : (currentIndex + 1) % tabs.length;
      selectPage(pages[nextIndex], true);
    });
  });

  ruleNav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      markRuleNav(link.getAttribute('href'));
    });
  });

  mountKnowledgeSearch({
    assets,
    recipes: (recipeLibrary?.recipes ?? []).map(recipeSearchRecord),
    documents: KNOWLEDGE_DOCUMENTS,
    rulesPage,
    ruleNav,
    selectPage,
    navigate(result) {
      if (result.kind === 'asset') {
        selectPage('assets');
        if (selectAsset(result.id)) history.replaceState(null, '', `#asset-${result.id}`);
        return;
      }
      if (result.kind === 'recipe') {
        selectPage('recipes');
        recipeLibrary?.selectRecipe(result.id);
        return;
      }
      if (result.kind === 'rule') {
        selectPage('rules');
        const hash = `#${result.id}`;
        history.replaceState(null, '', hash);
        markRuleNav(hash);
        requestAnimationFrame(() => document.getElementById(result.id)?.scrollIntoView({ block: 'start' }));
        return;
      }
      if (result.kind === 'document') {
        selectPage('docs');
        documentLibrary?.selectDocument(result.id);
      }
    },
  });

  const initialAssetHash = window.location.hash.startsWith('#asset-');
  const initialRecipeHash = window.location.hash.startsWith('#recipe-');
  const initialRecipesPage = window.location.hash === '#recipes';
  const initialDocsHash = window.location.hash.startsWith('#doc-') || window.location.hash === '#docs';
  const initialRulesHash = /^#(?:rule|architectureAtlas|personArchitecture|decisionTree|authorityBoundary)/.test(window.location.hash);
  selectPage(initialRecipeHash || initialRecipesPage ? 'recipes' : initialDocsHash ? 'docs' : initialRulesHash ? 'rules' : 'assets');
  if (initialAssetHash) requestAnimationFrame(() => selectAsset(window.location.hash.slice(7)));
  if (initialRecipeHash) requestAnimationFrame(() => recipeLibrary?.selectRecipe(window.location.hash.slice(8), false));
  if (initialRulesHash) {
    markRuleNav(window.location.hash);
    requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView({ block: 'start' }));
  }
}
