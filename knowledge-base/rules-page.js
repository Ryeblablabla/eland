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
          <li><span>04</span><strong>长期关切与需要</strong><small>主观 aim · 当前压力</small></li>
          <li><span>05</span><strong>执行意图与项目</strong><small>唯一焦点 · 现场 · 贡献者</small></li>
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
                <div class="architecture-node"><strong>人物心智</strong><small>PersonMind · MentalAct</small></div>
                <div class="architecture-node"><strong>增量编译器</strong><small>只展开当前下一步</small></div>
                <div class="architecture-node"><strong>现实执行器</strong><small>试错 · 观察 · 重验</small></div>
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
            <aside data-tone="agent"><span>MODEL MIND</span><strong>模型形成目标 · 假说 · 策略 · 协商</strong><p>模型先输出 MentalAct，本地只把当前已知部分编译成下一步。隐藏配方、远处障碍和最终成败必须经过真实观察或试错后才进入人物心智；模型缺席时保守规则仍可运行。</p></aside>
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
            <section data-tone="agent"><span>W3 · 人物与社会</span><strong>持续状态</strong><p>人物、库存、知识、记忆、关系、CharacterAgenda、Intent、Project、Agreement、Collective 与 Governance。</p></section>
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
            <p>人物 Agent 由 PersonMind、MentalAct 与 Intent 构成：模型拥有主观方向，规则只拥有现实合法性和后果。</p>
          </header>
          <div class="bdi-architecture" aria-label="人物 BDI Agent 架构">
            <section class="bdi-node" data-tone="world">
              <span>B · BELIEF</span><strong>本人相信什么</strong>
              <p><b>PersonMind</b>：每个人持久化一份 Markdown，按“当前关切 / 经历 / 信念 / 最近思考”组织；本地 writer 依据真实个人事实更新，本地 compiler 生成瞬时结构，模型只读文档而不直接改写记忆。</p>
              <small>不是全局真相；看不见、没经历、无来源的事实不能进入。</small>
            </section>
            <section class="bdi-node" data-tone="agent">
              <span>D · DIRECTION</span><strong>想达到什么，准备怎样试</strong>
              <p><b>MentalAct</b> 保存目标、策略、假说与预期观察；长期方向落为 concern，未知结果不会被编译器提前回答。</p>
              <small>模型可提出当前没有完整做法的新方向；本地只寻找一个现在可尝试的步骤。</small>
            </section>
            <section class="bdi-node" data-tone="social">
              <span>I · INTENTION</span><strong>现在决定坚持什么</strong>
              <p><b>active Intent</b>：当前已经落地的一段执行；稳定时直接继续，停滞或出现新证据时才重新形成 MentalAct。</p>
              <small>生存和正式义务可以中断它；模型不负责逐格移动或直接改写世界。</small>
            </section>
            <div class="bdi-plan" data-tone="effect">
              <span>P · COMPILE &amp; TRY</span><strong>MentalAct → 当前一步 → PrimitiveAction → ActionExecutor</strong>
              <small>编译到人物认知边界就停止；后续路线、材料效果和他人选择由世界逐步暴露。</small>
            </div>
            <div class="bdi-feedback" data-tone="world">
              <span aria-hidden="true">↺</span><strong>ActionFact 更新 Belief</strong><small>成功、失败、努力、伤害、关系和项目进度进入下一轮局部认知；模型文本不会替代经验事实。</small>
            </div>
          </div>
          <div class="person-architecture">
            <section class="person-layer" data-tone="world">
              <span>P1 · 权威输入</span><strong>世界事实 + PersonState + 共享承诺状态</strong>
              <p>身体、位置、库存、知识、记忆、关系、人格、出生时确定的永久特质，以及状态中的 CharacterAgenda / Intent / Project / Agreement。</p>
            </section>
            <div class="architecture-arrow"><span>只投影本人可获得的事实 ↓</span></div>
            <section class="person-layer" data-tone="agent">
              <span>P2 · 局部认知视图</span><strong>PersonMind + visible + current</strong>
              <p>经历、信念、关切、眼前实体与当前意图组成唯一模型输入；不发送候选评分和隐藏失败原因。</p>
            </section>
            <div class="architecture-arrow"><span>模型形成 MentalAct ↓</span></div>
            <section class="person-layer person-layer-split" data-tone="agent">
              <div><span>P3-A · 硬门禁</span><strong>休眠 · 生存 · 照护 · 年龄 · 正式回应 · 履约</strong><p>不可推迟的事实先行；正在执行的优先义务不会被新义务无条件打断。普通生活回应不在这条硬门禁中。</p></div>
              <div><span>P3-B · 主观方向</span><strong>目标 → 假说 → 策略 → 预期观察</strong><p>模型可以创造新方向和可失败方法；无当前步骤时保留 concern，有步骤时本地只编译该步，不证明整个方案可行。</p></div>
            </section>
            <div class="architecture-arrow"><span>只编译当前已知部分 ↓</span></div>
            <section class="person-layer" data-tone="social">
              <span>P4 · 唯一执行焦点</span><strong>Intent → Project / HTN → 下一原子动作</strong>
              <p>当前步骤由可感知事实落地；走到未知边界后生成观察、询问或小规模尝试，方法失败不自动删除目标。</p>
            </section>
            <div class="architecture-arrow"><span>领域预演与重验 ↓</span></div>
            <section class="person-layer" data-tone="effect">
              <span>P5 · 规则提交</span><strong>ActionExecutor → ActionFact / WorldEvent</strong>
              <p>每 tick 至多一个动作；成功、推进、阻塞与失败都留下路径、消耗、产物和来源。</p>
            </section>
            <div class="person-feedback" data-tone="world">
              <span>↺ FEEDBACK</span><strong>事实反哺下一次决定</strong>
              <p>只有真实观察结果更新经历和信念；模型可以据此改换解释与策略，但不能把假说写成世界事实。</p>
            </div>
          </div>
          <div class="architecture-rails architecture-rails-compact">
            <aside data-tone="observer"><span>READ-ONLY PERSONA</span><strong>Soul v3 / experience / turn note</strong><p>稳定核心与有源经历分层；输出前只激活一个 facet、reaction 和合成声线示例，不写回世界事实。</p></aside>
            <aside data-tone="observer"><span>OUTSIDE REALITY AUTHORITY</span><strong>模型 / 文明指数 / UI</strong><p>模型是人物心智而不是世界裁判；它能创造方向、实验和协商，不能创造成功、知识、同意或物质后果。</p></aside>
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
            <li><strong>时间与纪元</strong><span>恒纪元 / 乱纪元持续区段；实时天象候选需连续 3 个权威月，且当前纪元已持续至少 6 个月才确认切换。天气按月结算但普通过程至少持续 2 个月，之后每月有 75% 延续惯性，强度只偶发逐级变化。实时宇宙的 burned 明确携带三日凌空终局语义，普通 fire 即使达到强度 10 也不能冒充。</span></li>
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
            <li><strong>创世先民</strong><span>每局按种子从 101 人档案池确定性抽取 5–12 位，也可由配置显式指定最多 12 位；共同抵达事实列明全体先民并只赋予双向 trust / bond 10 的相识起点，后代不会继承这条开局来源，旧存档也不会被回写。</span></li>
            <li><strong>局部感知</strong><span>可见格、可见人物 / 动物 / 掉落物 / 暴露遗体，以及真实可达性；有标记墓穴可让来访者得知死者，未标记墓穴不泄漏身份。</span></li>
            <li><strong>记忆与知识</strong><span>每个人持久化一份 Markdown 心智文档，按当前关切、经历、信念和最近思考组织；本地 writer 只从人物可获得的真实来源更新，本地 compiler 再提供规则需要的瞬时结构，模型只读而不能编辑。旧的近期事件、有来源地点、技术置信度、关系和失败经验字段暂作 schema 17 codec backing；本人亲历动作还保存机器可读的 basis、结果、效价与参与者。Action 后验用于预计努力与伤害，Intent goalOutcome Beta 后验决定目标成功预期：未受孕可以是 completed 动作与 attempted-unmet 目标，无真实受孕样本的提前阻塞是 not-evaluated，不写入目标后验。生殖方向被实际选中时，DecisionFact 另冻结 generativity、motivation、aspiration、关系门、准备度五个分量及其来源，供事后审计，不把观察器结果变成人物奖励。灵记把个人记忆容量与留存提高 50%，但不产生知识；先知出生时可靠掌握当前全部 47 项规则配方，仍不获得材料、地图或行动豁免。失败重试优先从 terminal Intent 引用的真实 blocked / failed ActionFact 读取实际动作，再比较动作、目标、数量、人物、项目、记录与关系组成的结构 basis；容量有限的自传记忆只作兼容，不比较临时 option ID 或显示摘要。成年人只有在历史估计进入未来六个月窗口后才会形成纪元预言，不能读取隐藏调度或发布几年后的远期预言。</span></li>
            <li><strong>能力证据</strong><span>observed 只证明看见；accessible portable 只含本人背包和可取得掉落物；placed facility 必须是世界中真实放置、记忆后重新核对仍在场的设施。旁人背包不能冒充本人工具或公共设施。</span></li>
            <li><strong>工具升级与采用</strong><span>生产工具按木 / 骨、石器、石锄、青铜、铁的真实效用等级比较；低级工具只部分缓解劳动压力。本人近期真实生产劳动可提高可达高级地面工具与交换报价的价值；他人背包工具只能经同格自愿交换。既有路径仍允许持有者用更高阶备用工具替代待交换的低阶单件；青铜工具还可在至少保留石制生产工具时交换，其他最高阶单件不会被自动让出。移动后的采集、收获与捕猎会重新选择本人当前实际效用最高的适用工具。</span></li>
            <li><strong>年龄与能力</strong><span>未满 1 岁依赖亲代；1–11 岁可自主跟随、取水、拾取、学习和简单劳动，但普通移动不得逐格漂出当前可见亲代的本地照护半径，严重压力时只可走向当前可见亲代；12–15 岁可生产及协作既有项目；16 岁起才有完整规划能力。</span></li>
            <li><strong>身体、身份与人格</strong><span>身体储备、状态限制、HEXACO 六维、控制 / 地位敏感度、亲缘认识、共同体职责，以及出生时一次确定、最多三个遗传 / 先民项加一个随机异变且终身不变的特质；父母、子女与兄弟姐妹从 geneticParents 稳定投影，不挤占可衰减的事件记忆。创世档案摘要经通用语义信号形成有界 HEXACO / motive center，再与种子差异混合；每个原型取得三个合成反应范式，每个范式只有一句非原作的短声线示例。后代不读取原型，只走父母人格继承。baseline 与反应范式派生 Soul v3；experience 让有来源变化和当前记忆调整本轮注意。模型请求末端的 `character-turn-note-v1` 只发送一个 facet / reaction / example 与至多两个经历 cue，完整 Soul 不再常驻发送，也不能创造候选或事实。</span></li>
            <li><strong>当前意图</strong><span>一个 BDI 执行焦点；进度、尽责性、项目压力与个人成功预期维持承诺惯性，普通竞争候选不会让它每刻度重抽。其他压力不会同时变成并行动作。直接死亡会终结当前及全部暂停意图；休眠恢复发现目标已终局时按真实样本结算 goalOutcome，只有真正恢复为 active 的意图暂不结算。项目因作物生长、他人物流或负责人休眠而真实等待时，当前 episode 可用 world-change wait 让出焦点；Project 后来完成、阻塞或放弃后，所有同 projectId 的停泊 episode 按 exact completion / failure 来源结算，仍活动的项目等待不受影响。同一自然月内仍未满足的保护性 child episode 继续已经推进的普通移动目标；目标达成、动作失败、直接食水 / 身体动作、新取水路线、可见野兽或下月结算仍可改变计划，不靠切换次数或冷却限制人物。</span></li>
            <li><strong>候选语义</strong><span>每个生产 ActionOption 都携带 action-option-semantics-v1：义务、普通 / 边沿通道、用途、最低年龄、需要、对话、生殖与社会情境均为 typed 字段。optionId 只作身份、排序、选择和回放；规则规划器与服务端模型网关共用校验，不从前缀、正则或拆字符串猜意义。只有旧存档迁移可使用显式 legacy 解析。</span></li>
          </ul>
          <code>domain/person.ts · domain/person-soul.ts · domain/memory.ts · application/action-options.ts</code>
        </details>

        <details class="rule-branch" data-tone="social" open>
          <summary><span>需要与项目</span><small>持续工作以项目为单位</small></summary>
          <ul>
            <li><strong>生存与安全</strong><span>保温、捕猎安全、照护、熟食与住所容量。无可见或记忆水源时，急性找水只冻结最多四个初始可见前沿；到达或证伪后依次耗尽，移动后的新视野不能让目标无限外漂，只有新的本人水源证据或真实饮水事实才能重开。学习期孩子的会合目标绑定精确照护者；已经与任一在世亲生照护者同处即视为会合满足，不会为了另一名可见亲代离开。孩子同月短暂会合并恢复原食水 / 健康 Intent 后，先让根行动取得真实后果，再判断是否需要再次会合；下一月或新的紧急后果仍正常重评。未满 3 岁幼儿只有在亲代同处且取水、取食、休眠恢复或入住所的当月依据仍成立时才随照护移动，到达真实水源后还需近身帮助饮水；已有冷热伤害并在真实住所内的婴儿不会被普通成人行程自动带到无遮蔽处。冰面融化等自然变化若让同格人物失去支撑，只在该真实变化格上把人物移到半径 2 内最近可站立位置并留下环境事实；看得见未成年人但没有可站立路径时，照护反射不生成必然失败的隔空喂食或搬运。人物已选择并有来源的自我脱水动作本身是立即避护后果，不会被普通住所维护分支只记录决定而挡住。</span></li>
            <li><strong>死亡照料</strong><span>人物先因看见遗体、有标记墓穴或有来源传话得知具体死亡，再由关系与人格形成丧亲压力。完整安葬依次搬运、择地挖墓、入葬、用同一次挖掘产生的原土覆土；墓记还要真实消耗空白木板并持有合格工具。</span></li>
            <li><strong>生产与储备</strong><span>工具、耕作、储藏、供水、窑炉、冶金与功能建筑；食物与饮水是独立储备缺口，健康 / 营养 / 水分也是独立身体维度，采食不能缓解缺水，取水也不能缓解低营养。取得型候选只有在本人缺少对应可摄入库存时才承接身体压力；项目压力还绑定精确 projectId，不能被普通采食冒领。受抚养人口会提高生产和储备压力。工具项目的第一件偶然样品不会直接完成，项目来源的更优工具仍须由本人持有，并把对应制作技艺复验到可靠阈值。</span></li>
            <li><strong>住所建材边界</strong><span>住所项目只消耗尚未组装的石、木、木板等实体建材；谷仓、窑炉、容器和机械构件等 placeable 成品保持自身功能，不能被当作通用墙体再次消费。</span></li>
            <li><strong>住所容量压力</strong><span>人物只比较完整可见范围内的存活人物与真实可通行住所位置；局部容量不足时即使天气温和也可提出扩容，一处容量已满的住所不能压制露宿者立项。局部重叠施工仍复用同一项目，不从全局人口或观察器指标生成住房任务。</span></li>
            <li><strong>住所空位优先</strong><span>本人暂时站在室外不等于缺房。完整可见、可达且未被可见人物占用的内部位置，或本人有来源记得且仍可到达的住所，会先提供入住所行动；风暴、寒热或烈火只有在局部人口容量仍短缺，或本人没有已知可达空位时才支持新住所项目。远处占用未知不靠全局人口偷看，到达时仍按真实世界重验。</span></li>
            <li><strong>住所构件连通</strong><span>物理结构通常只按六方向面接触合并；共同形成同一个真实 shelterGeometry 的屋顶与侧墙属于窄功能连接，因为可通行内部会让二者只沿边斜接。它们合为一栋完成住所，普通斜邻工地仍保持分离，不再把同一住所的两块墙投影成旁边永久未完成的脚手架。</span></li>
            <li><strong>公共谷仓收敛</strong><span>谷仓构件一旦由项目协作者制成，同月其他人会先等待它落地；真实落地后只继续形成首批储备，不再回退制作第二套设施。已知设施配方只能在仍有对应项目时重复制作，不能作为普通试验把成品堆进背包。仍存在的已完成谷仓会抑制项目受益人和贡献者重复立项，但不会泄露远处库存或赋予远程取用能力。</span></li>
            <li><strong>定居耕作</strong><span>本人计入自己的局部食物与身体压力；附近人口只可提高优先级，不再是启动资格。人物还必须感知到可用种源与可耕作地点；项目锚定局部地块，缺种先取种，并只用本项目真实完成播种的六个不同位置与两次真实收获判定完成。尚未播过的可耕格优先于旧格复种；既有可种地不足时，人物可让手中通用生产工具对本人可见、可达的裸土、夯土或草地进行有界地表尝试。草地先成为裸土，裸土或夯土才可进一步整理为可播种地；这些较易地表用尽后，只有已经从真实 ActionFact 学会“手中工具可整理裸土”的人物，才会分离固定地块内的灌木或枝叶，再依据真实结果继续整地，避免没有后续能力的盲目砍伐。未知时规划器不读取正确工具、规则或产物；同一工具对同一类地表两次真实无响应后换候选，成功后才形成有 ActionFact 来源的精确整地技术，工具本身不消耗。</span></li>
            <li><strong>知识与探索</strong><span>因真实缺口触发有限试验、验证、教学和耐久记录。</span></li>
            <li><strong>项目持久性</strong><span>触发事实、压力、场地、材料数量、物流、贡献者、进度与失败均可追溯；完成证据先于所有者死亡结算，已做成的项目不会被误记为放弃。旧搜索只有与当前缺口材料完全一致、晚于最近进展，而且没有协作者、休眠、当月产物落地或作物生长等待时，才进入耗尽候选；即使搜索或实体假说耗尽，也须等到有效复核期限，并距最后真实进展或本次精确关闭至少 4 个月才会阻塞。等待时保留精确缺口、预约和同一项目，不重开相同 campaign；期限前出现精确新来源时原项目直接恢复物流 / 生产。终局失败后 owner + desiredFunction 会继承当时的机会依据；只有精确新材料来源、相关可靠技术、新目标环境或新 verified response 能续证重开，ID、月份、压力、移动与同一来源改名不能。后继首步必须实际使用 renewal；从未发生这类终局失败的普通建造保持原行为。只有真正交付最后功能性动作的人物获得完工 episode；它在 12 个月内对同 need / function 的新项目提案压力最多减少 45%，但绝不伪造库存、水源或住所。便携产物只以当前目标材料栈来源与本项目 actionEventIds 的交集作为完成证据，旧项目同材质产物不会让新项目即时完成。能力载体落地也不自动完成：crop-processing 的本项目 Mill 必须由安装前已有资格的人，在半径 1 内对真实成熟作物完成普通分离并产生高于徒手基线的 Mill 增益；目标消失时只等待，不造作物、换旧设施或伪造功能事实。</span></li>
            <li><strong>局部去重</strong><span>同功能、受益者 / 目标与局部场地重叠时先复用，提交边界再次校验；同刻度竞争创建会合并受益者与触发事实并重绑意图。非所有者只在创建当月有界等待，远处不重叠项目仍可并行。</span></li>
            <li><strong>功能化项目身份</strong><span>同一 need 的不同功能提案在接受前把 desiredFunction 写入最终 ID。全新机械安装计划若仍引用旧粗粒度提案，计划 projectId 随最终 ID 重绑，并重算 plan key / network ID；维护和可靠性提案携带的是既有安装的外部计划，必须继续指向原安装和原网络，不能改成维护项目自身。</span></li>
            <li><strong>材料请求</strong><span>固定场地合金、铁器项目与明确的公共厅堂项目可发起追加式请求；普通 community-coordination 项目不因此获得新通道。open / fulfilled / expired / contributors-unavailable 从期限、实时缺口、贡献者与真实转移派生。转移精确引用请求，并按请求余量和当前缺口截量；固定冶金项目把材料送到作坊工位，不追逐移动中的 owner。</span></li>
            <li><strong>古代设施接续</strong><span>公共厅堂可由人物已经观察到的青铜 / 青铜工具、烧结砖，以及木牍或可制作木牍的木材与石制工具发起，不要求发起者先独占全部终材；缺料仍须经真实请求与转移汇合到固定工地。铸造场建成且本人可见或有可核对地点记忆时，后续青铜项目返回铸造场。观察到青铜能力与烧结砖可提出铁匠铺；Smithy 真实落地后，铁料、还原、锻打与铁制工具项目才逐段返回该工位。真实生产动作把设施写入事件，并兑现批量加成。</span></li>
            <li><strong>记录发布</strong><span>选题优先回应作者本人实际听到且仍开放的项目知识请求；作者必须可靠掌握与请求产物精确匹配的技术，并且已无法与请求者近距口授。项目所有者随后在固定场地写入空白载体；一旦背包中已有与项目、知识和写入事实精确匹配的已写载体，返回场地并投放到精确地面优先于旧搜索 / 物流。没有合格请求时仍可按原年龄 / 记忆压力自然选题；成功投放沿既有项目完成事实收口。</span></li>
            <li><strong>度量压力</strong><span>本人至少 3 次、跨 2 个月的生产经验，可由近期情景记忆或本人带源技术知识中的生产 provenance 保留；它必须对应本人当前持有、处于同一粗手感档的两个实体批次，并每次重验执行者、实体栈、生产动作与材料。这是局部不确定性，不注入精确质量或隐藏配方。</span></li>
            <li><strong>材料功能假说</strong><span>精确 BOM 必须能追溯到本人仍可靠的技术 / 记录或本人真实完成的配方事实；activeProject 与 desiredFunction 本身不构成材料知识。有 provenance 的已知技术和实体项目仍可使用精确需求；没有时，问题只表达功能角色与可感知性质，类型中不能携带 material ID、rule ID 或预期产物，模型也只看到感知 profile 与待试验问题。远看只知道相态、外形和表面观感，拿取 / 核验后才知道粗负重与刚性。候选按必需角色、本人对精确输入 / 工具的经验、同一试验的 response / no-response、信息相关性与可选性质排序，不读取项目目标材料，也没有正确答案加分。campaign 是项目负责人的个人猜想，贡献者可以交付材料、演示或使用自己可靠掌握的技术，但不会借用负责人的未知候选。人物已有精确 expose 技术时，烧砖、炼铜和炼锡项目锚定与其陶窑 / 铸造设施一致的真实场址；技术未知才使用一般高温场址做有界试验。已核验产物只改善该实体的感知 profile；只有 operation、question、candidate 与当前有形来源组合都相同的真实 response 才能成为 learned evidence，不能把一个产物的成功复制给其他未试组合。campaign 候选 / 尝试 / 关闭预算为 7 / 4 / 3。度量问题仍只提出“两件相同结构件 + 柔性悬挂件”或“稳定参考物 + 可见标记”，已取得的仪器、参考物和已写载体保持受保护实体。</span></li>
            <li><strong>机械试建</strong><span>人物先有本人真实 Mill 劳动压力，再在可见、可达处 attend 具体水流段；项目只冻结来源与可见工地几何，不泄漏 WaterWheel / DriveShaft 配方、时代门槛或观察器目标，未知方法仍走有预算的盲试与验证。部件安装不因短期干涸或结冰丢失已经完成的制造机会；真实 commissioning / operate 仍必须等水流恢复。</span></li>
            <li><strong>电力试建与维护</strong><span>人物只从本人亲历的机械服务、局部可见材料、可靠操作知识或当前故障形成候选；安装计划冻结网络、部件和位置，维护还必须引用个人诊断与故障后制造/核验的替换件。人物不读取现代阶段的三项观察门槛。</span></li>
          </ul>
          <code>domain/project.ts · application/project-options.ts · application/projects/project-frontier.ts · application/project-hypotheses.ts</code>
        </details>

        <details class="rule-branch" data-tone="effect" open>
          <summary><span>动作与后果</span><small>世界规则裁决眼前动作是否合法</small></summary>
          <ul>
            <li><strong>五种原子动作</strong><span>move · transfer · act · attend · talk。</span></li>
            <li><strong>语言与身体并行</strong><span>talk 使用人物的语言通道，不再必然挤掉同 tick 的身体行动。完成沟通子 Intent 后立即恢复原父 Intent，并可继续移动、取得、制作或观察；狩猎、生殖、休眠出入等高占用身体动作仍互斥。听见不占身体通道，主动回应才提交新的沟通 ActionFact。</span></li>
            <li><strong>移动成本</strong><span>每个规划刻度有 2 点地形成本预算：普通平地每边成本 2，连续夯土 / 木板道路每边成本 1，因此道路上可连续前进两格。高成本地形至少允许跨过一条相邻边；路径事件保留全部中间格，体力、代谢、踩踏与规划耗时使用同一累计成本。</span></li>
            <li><strong>有限化身操作</strong><span>第一人称转头、瞄准与查看提示只读；移动命令只从四向邻格中选一条当前合法站立边，即使在道路上也不跨两格。客户端只回传当前投影的 optionId + choiceKey，人物轮次重新编译并由领域层复核；生存、照护与必要避护仍可先接管。建造只展示真实 DecisionContext 中已有的项目 / 建造候选，沿同一材料、场址、Intent / Project 和 ActionFact 规则执行。</span></li>
            <li><strong>十种领域操作</strong><span>exert · separate · combine · expose · ingest · reproduce · hunt · dehydrate · rehydrate · inter。</span></li>
            <li><strong>工艺语义边界</strong><span>内部 combine 可兼容承载库存制作、播种、容器改造与结构安装，但人物知识按真实工艺重新表述。空气只表示尚未占用的安装位置，不是配方原料；例如木材落地成木板应理解为“加工并安装”，不得写成“木材与空气结合”。旧存档按稳定 technique ID 迁移知识与记录摘要，不改写历史 ActionFact。</span></li>
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
            <li><strong>互动</strong><span>新文明先民双向关系从 trust / bond 10 开始，旧存档保留自身已持久化数值。共同抵达 founding 只表示相识，不能单独成为 company、companion 或普通生育提议的关系证据；预测、无关环境事实与未指向这对人物的行动也被排除。关系账本不为从未互动的陌生人预铺零值边；缺失边与旧式 canonical 全零、无来源边同义，首次真实有源互动才创建。每条定向关系保留最近 24 条来源供近期情境与自然遗忘，另有界保留真实双方互动、直接照护 / 实质回应 / 履约、共同生活和明确接受 / 拒绝边界；共同项目只在 Project 已完成、来源 ID 精确属于 completionEventIds 且双方都在 contributorIds 时成立，协议也只在 fulfilled、精确 fulfillmentEventIds 且双方同为 party 时成立，不能从最终 primitive action 的表面类型或 beneficiary 身份猜测关系。decision boundary 按 companion / reproduce 与 self / other 的语义槽位保存，同月不同方向的决定不会互相覆盖。正式关系从前几类读取关键来由；接受 / 拒绝边界只形成软偏好，其强度随时间及之后可回放的对话、照护、履约、共同生活等真实后果连续变化，不改变关系分、不解锁能力，也不删除候选。高频普通更新不能挤掉关键关系来由；语义锚点不参与生活对话原样去重，不形成永久黑名单。有效生活对话的中性回应即使 trust / bond 增量为 0，也作为双方确实参与的关系来源保留；数值不变不等于事实没发生，但 everyday / reminiscence / playful 仍不属于正式关系要求的直接亲密证据。新生儿只对出生时仍存活且精确同地的人形成由本人宜人性与外向性决定的单向弱信任 3..9，在世亲生父母另以同一出生事实保留有源亲缘 bond；异地或后来到场者不追授弱信任。“双方都行动且行动后同地”的共同活动按每个人的有效外向性 60% + 宜人性 40% 分别换算：高、中、低社会接近度每 3、4、5 个规划刻度形成一份定向 trust / bond +1，因此双方可以不同步增长；已生效的结伴双方在同一稳定生活区的不同格行动也可累计。当月已有基础增量时，未满 16 岁额外 trust +2，16–29 岁额外 trust +1，30 岁起不加；年龄加成不增加 bond，也不凭空创造关系。事实保存双方各自门槛与增量。单纯同处、空闲、休眠和失败动作不计。短期 company 请求至少需要一条排除 founding 的真实双方关系事件；正式 companion 与普通生育提议都要求提议者有来源的 20 / 20、证据覆盖至少两个自然月，并包含直接照护 / 实质回应、履约、共同养育或明确支持。普通闲聊不能独自承担这条直接证据；身体适格的生育回应者仍同时获得接受与拒绝，不要求其反向分数也达到 20 / 20。拒绝不会删除同一对象的后续候选；后续真实证据只是连续削弱旧边界的负偏好，同月证据权重更低，也没有按话题白名单设置固定解锁。魅魔是显式特质例外：成年女性可对同地成年男性形成单方生殖候选，不读取关系或对方同意，但事实不得冒充双方协议。</span></li>
            <li><strong>柔性拥挤</strong><span>精确站位超过两名存活人物时，本人产生有界 spatial-comfort 需要，并可自愿一步挪到附近占用更低的站位。它不扣健康、不强制弹开人物、不打断正式 required response 或生存任务；两人同位、住所容量、人口承载与资源竞争仍按各自规则处理。</span></li>
            <li><strong>共同生活</strong><span>结伴提议保存双方共知的稳定生活地点；生活区内可以各站不同格。日常取水、劳动、学习可各自行动；只在 24 个月约定的时间余量用尽、若不返回就无法累计 12 个月共同生活时，才以空闲生活槽位为目标返回，让待建立关系的已接受约定形成有来源的承诺需要，并按既有 fulfillment 优先协议打断普通工作。到达后通过显式 maintain-state 至少保持到下一月边界，不把同刻触碰锚点又离开当作共同生活。仍生效的共同生活关系按已接受 / 已建立、本人对对方的 trust / bond / fear 与当前是否处于共同生活区，连续满足一部分 belonging；多项关系按剩余缺口组合，只削减未满足压力，不删除新关系候选，也不会激活 generativity。结伴、共同体身份或仅仅看见别人都不会自动追踪实时坐标；超出相邻语音范围的生活交谈必须绑定具体高价值来源和后续沟通。低压力 everyday / reminiscence 只在双方已处于相邻语音范围时生成，不驱动跨地追逐；共同抵达只能支持 everyday，只有具体共同动作或已履行约定才支持 reminiscence，规则不预造 playful 小插曲。</span></li>
            <li><strong>承诺</strong><span>提议必须回应；生效协议要通过后续行动履约。若一项尚未说出口的提议因生存或休眠中断拖过原回应期限，执行会在 completed 事实前阻塞，人物只能按当前处境重新决定；接受 / 拒绝也要重验协议仍为 proposed、本人未回应且回应时钟仍开放，不能把聚合拒绝的无效回应伪记成已经表达。同一人物对、同一需要的求助在 proposed / active 或本自然月已经回应时只是一项语义事件，不能换 Intent 在同月重复说；下一月若危险仍在仍可重新请求，不靠固定冷却禁止。主动协助类协议的 helper 进入休眠时，履约期限只按实际休眠月暂停，恢复后补回相同月数；不可行动期不伪记为违约，暂停也不扩散到其他协议。取水互助在接受前要求 helper 本人可见或记得一处双方都能到达的同一岸边；helper 到达或一次真实核验只完成自己的 contribution，requester 仍须沿同一路线实际饮水。每个 planning tick 反复查看同一水体不能累计成帮助。无协议绑定的生存反射不能冒充履约，动作当时验证的水源与饮水写入版本化事实回执，后来的冻结、融化或地形变化不能改写已经发生的帮助。普通正向生殖发起的 needActivation 只能由 NeedAgenda 的 generativity need 产生；魅魔的单方候选由本人的出生特质提供有来源的 generativity 机会，并跳过关系、双方协议和家庭准备度门控。普通生殖中 belonging 与无关 autonomy 不能凭空激活正向选项；若本人已形成与同一对象、同一关系主题的意图，对方先提出相同结果，接受回应也承接这项具体自主选择。接受与拒绝仍同时存在，并继续由关系、恐惧、人格、当前责任、家庭准备度和风险连续门控。撤回始终合法，但属于普通 optional 决定而非 commitment edge；自主压力绑定具体协议或人物，只有相对本人同意时的新准备度下降、新增子女责任、严重身体状态或对象一致恐惧才推动本地撤回，拒绝 / 撤回表达本身不缓解 belonging。准备度只取本人可感知的当前食物、水、当前可见且确认未占用的真实住所内部位置、照护余量与气候安全，住所质量来自 weatherProtection / thermalInsulation；记忆中的远处住所只保留未验证来源，对 shelter 分量贡献 0。项目记忆不能替代资源；被拒绝或撤回后，后续对话、照护、履约、共同生活、身体与责任事实按来源和时间连续改变旧边界的软成本，不靠话题切换或固定月份解锁。完成和到期后的既有生理间隔保持原规则。普通接受形成最长四个月的可撤回窗口；未受孕只记录尝试并允许同一窗口下月继续，普通和魅魔单方路径都限制同一伴侣每月最多一次真实尝试。普通动作精确绑定有效协议并保存当时关系快照，魅魔动作则记录本人、目标、特质来源与 <code>succubus-unilateral</code>，不能形成虚假的 agreement。</span></li>
            <li><strong>近亲风险认识</strong><span>亲缘不改变动作合法性，而是提高后代遗传负荷、出生偏差、寿命压力与后续疾病概率。人物观察或学到这些后果后，风险知识从第一次有源证据起按置信度连续形成软成本；满置信度也不再近似否决。每个关系与身体条件合格的伴侣都保留独立候选，再由同一认知 appraisal 比较关系、责任与亲缘风险。</span></li>
            <li><strong>生活对话</strong><span>opening 与 response 都是 optional conversation edge；被点名者可以不回应，response 也不会过滤其他普通候选。listener pool 不取 visiblePeople 的前三项：先按可解析处境、语音距离、共享项目、关系来源、亲近度与空间距离排序，完全同档时按 speakerId + atMonth 在稳定 personId 序列中轮换，因此数组顺序不造成偏置，合法对象也不会因固定 ID 永久出局。完整本地模式仍使用 failure / discovery / everyday 等有源菜单；failure 只引用具体非沟通动作，若同一意图先完成生活开场、后续物理目标未满足，旧开场会从下一次 failure basis 移除，避免对话摘要套娃。compact 与 full 模型请求都隐藏这些预选开场，只为 pool 中处于语音范围且已有可解析关系来源的每名听者保留一个 open affordance。模型决定实际 utterance 并从本次最多 6 个匿名事实句柄中选择 0～3 个；服务端映射后在 Intent 创建与执行前重新编译，陌生人无 fallback 不生成候选。open 本身不传知识、不增加 trust / bond。一般可选交谈按同受众、同主题和新事实评估软重复成本；规则演化中真实完成的有源对话还会给双方各写一条有界 Agent dialogue basis，同一 response 更新同一项而不扩张关系最近来源。完整 basis 的稳定指纹保存在有界记忆 ID 中，不受可读文本截短影响，双方交换说话方向也不能把同一来源伪装成新话题；人物真正遗忘后仍可重谈，没有额外固定月份禁令或永久黑名单。低压力 everyday / reminiscence / playful 另按双人节律处理：完成一轮后至少跨过 6 个自然月且出现新的共同来源才再次开放，避免逐月寒暄；它不影响照护、困境、履约或正式回应。关系协议的旧拒绝也不作为布尔锁：技术失败说明、普通照护、履约与共同生活等后续事实依其因果强度连续削弱负偏好，同月新证据权重更低；候选始终保留，再由当前关系、家庭、身体与责任共同排序。正式提议的 accept / reject 仍是 required；协议幂等、每人一次正式回应、同一事实 basis 与开场回应去重仍是硬门禁。</span></li>
            <li><strong>开放交谈去重与续接</strong><span>同一人物对仍记得的旧 open 来源不再作为新 handle；上一轮 opening / response ActionFact 也不能自我喂回成为下一轮“新共同事实”，提交前按最新记忆再验至少一条新增的非对话来源。最终台词还读取同一听者相关的至多四条既往精确原话；没有 replyTo 时不能换词复读。speech-only 的 continue 只在参与者、回合和六个月时限仍合法时续接同一个 ConversationEpisode；close / rupture、明确不回应、超回合或到期才关闭，已发生的 ActionFact、知识与关系都不由文本改写。预测示例不再附赠没有当前来源支持的统一囤粮、备柴口号。</span></li>
            <li><strong>情境合作后验</strong><span>人物按“目标人物 × typed cooperation context”分别学习回应、接受意愿与履约可靠性；拒绝只影响意愿，没有回应只影响回应率。只有真实履约 / 违约、带贡献证据的共同项目完成，以及授权贡献到分配闭环，才影响可靠性；生殖不进入合作信誉。多人可选发起在同情境保留后验最高两名并按人物 / 月份稳定轮换一名探索对象，正式 required response、履约 / 撤回和生殖绕过。</span></li>
            <li><strong>死讯传播</strong><span>loss 对话要求说话者先有具体死亡来源，并与听者实际完成沟通；听者此后才形成引用同一死亡事实的记忆和丧亲经历。远处未知者不会自动悲哀；远处未成年子女即使已经客观死亡，也不会自动从亲代的 reproductiveResponsibility 中消失，亲代取得引用该死亡的有来源认知后才释放责任。</span></li>
            <li><strong>传播</strong><span>观察到的成功可复查、教导、模仿或写入实体记录。直接教学通常把技术知识提升到 60；当教师可靠掌握青铜工具制作、身边学习者近期有真实生产劳动且尚无同等工具时，这项教学可进入前三个候选，并引用学习者的劳动事实。普通教学的既有排序不变。母脉出生链中的母亲第一次真实成功教导孩子时提升到 72，必须仍有完成的教导动作。带精确技术、制造事件与预期材料的实体核验先重验产物物性和原来源，即使该载体后来写入另一项记录也不改读文字；没有核验请求时才按当前 payload 与 codebook 阅读。阅读只形成不高于 54 的暂定知识，真实项目实验才使它上升并可能跨过 55 的可靠阈值。</span></li>
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
            <li><strong>阶段归并与直接晋级</strong><span>v8 只观察“原始部落 → 农耕定居 → 古代文明”三个阶段，独立核验农耕与古代事实包并选择已完整闭合的最高层。旧快照中的 medieval 与 modern-civilization 只作兼容输入，恢复观察时统一规范化为古代文明。电力、标定测量和他人记录复用仍由真实项目与物质规则产生，但不再组合成现代阶段、前端成就卡或后端专用历史见证。人物不读取阶段、指数、门槛或候选进度。</span></li>
            <li><strong>住宅文化风格</strong><span>古代文明的已完工真实住所按世界种子与结构锚点稳定选择中国古建或西方中世纪形制；只更换台基、柱墙、木骨与屋顶等装饰语汇，不改变权威占地、材料、容量、防护、窗光或炉火事实。</span></li>
            <li><strong>耕作能力与当前土地</strong><span>当前耕作区只表示眼下仍存在的幼苗、成熟作物或贫瘠地，继续服务疆域与容量；阶段观察器 v7 仍只用同一已完成项目场址附近六个不同播种格，以及发生在这些播种格上的两次成熟收获证明既成能力。土地恢复不会抹掉闭环，零散、场外播种或项目外收获也不能冒充闭环。</span></li>
            <li><strong>现代观察器已移除</strong><span>前后端都不再组合现代文明证据、现代阶段或代表卡。电力、度量与记录若由真实项目产生，仍作为世界事实和独立能力历史存在，但不会被观察层重新包装成现代文明。</span></li>
            <li><strong>死亡照料观察</strong><span>只有真实死亡、完整安葬与物质墓记来源闭合才识别对应能力；多人跨时段重复安葬才可能派生制度。</span></li>
            <li><strong>事实报告</strong><span>运行摘要、转折点、毁灭原因和文明编号都来自真实历史。记录完整链还必须通过同一 basis 的身份、项目、payload / codebook、精确取得、阅读理解、实验产物、置信度从低于 55 上升到至少 55、顺序及项目进度守卫；外部 exact-lineage 交付或既有已读可按真实状态继续，但不补造阶段、不计完整链。</span></li>
            <li><strong>文明纪事</strong><span>规则投影筛选文明开端、纪元切换、重要天气、野兽袭击、死亡、出生、协议、关键技术与项目完成，也允许有真实来源且已完成的可选生活回应作为低优先级片段进入近期纪事；只记录一轮回应，避免开场和回应重复刷屏。没有合法模型台词时只写间接沟通事实，不把规划摘要伪装成逐字对白。死亡只在来源链确实包含袭击且对象一致时归因给动物。同源原子动作在表达层归并，但纪事仍保留全部 sourceEventIds、涉及人物和可展开事实详情；模型只能压缩这组已筛事实。闲聊数量不计制度、阶段或文明指数。</span></li>
            <li><strong>口头台词</strong><span>主动对话、决策 utterance 与 speech-only 共用稳定 Soul v3 和有来源 experience layer；每轮只激活一个最相关情境侧面。请求末端追加 `character-turn-note-v1`，只带一个反应范式和合成 `exampleLine`，要求先接住最具体的一点，说到够用就停；允许半句、改口和停顿，但不强迫每轮表演。历史原话维持事实连续性，不要求沿用旧回复的篇幅、客套或助手口吻。记忆按话题、真实听者和有效人格有界排序，年龄 / communication 能力限制句式。规则动作只投影结构化 speechAct，不提供可显示原话；普通生活 response 也不预写 supportive / listened / willing 态度。不依赖精确父句且通过事实 / stance 校验的 decision utterance 在动作完成后直接成为 decision-model 原话；其余 speech-only 才要求实际文本、move 与 continue / close / rupture disposition。response 只有父 SpeechLine 已持久化且参与者匹配时才获得父原话；缺父不发布孤儿引号台词。成功台词按 sourceEventId 回放，下一月 decision 最多读取四条本人已说或听见且可核验的原话；原话不证明客观事实或同意。</span></li>
            <li><strong>体素装饰</strong><span>把已有建筑、动作、天气和身体事实映射成画面，不写回世界。分离动作读取已提交 ActionFact 的源材质：结果灌木显示为采集野果，成熟作物显示为收割，不因人物携带工具就把野果采集画成耕种。</span></li>
          </ul>
          <code>domain/civilization-index.ts · domain/era-progression.ts · projection/derived-observations.ts · projection/ · voxelKits.ts</code>
        </details>
      </div>
    </section>

    <section class="rules-section" id="decisionTree" aria-labelledby="decisionTreeTitle">
      <div class="section-heading">
        <div><span class="section-no">03</span><div><span class="section-kicker">DECISION TREE</span><h2 id="decisionTreeTitle">每个规划刻度，人物怎样决定</h2></div></div>
        <p>决定不是一次性抽签。稳定意图默认延续；只有紧急反射、正式提议的必须回应、履约、真实的新机会、客观停滞，或人物在自然对话中亲自选定的合法方向能改变焦点。普通生活 opening / response 都是可放弃的自主候选。界面不要求玩家区分聊天与建议；服务端先保守判定 actionChoiceRequested。第一阶段只生成并校验角色回复，模型误带旧版行动字段不会再拖垮回复；纯问题不暴露他人的 required response，也不触发隐藏意图调用。明确行动请求才用第二个 prompt 从已生成回复中提取意图，失败时静默保留回复；只有明确承诺且通过本地校验的 accept + choice 进入行动链。下一月只做本地稳定 key 重配，不再让模型重新决定。</p>
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
                        <article class="logic-node" data-kind="condition"><span>G2</span><h4>脱水休眠 episode 当前相位？</h4><p><code>dormant</code> 禁止普通行动；新恒纪元、提前休眠所依据的预言失效，或恒纪元中的身体危险只在严重缺水者持有可饮物、或能沿当前感知路径到达真实水源时，才使其进入 <code>recovering</code>，且不会凭空补足储备。没有补水可供性时继续低代谢并保留旁人救援机会。看见同一休眠者的人物共用一个以 sleeper + condition + era 为身份的持续项目，后续见证者成为贡献者，按“接近 → 取得 / 制作容器 → 真实水源装水 → 返回 → 近身补水”推进；携带水绑定实体容器并在使用时消耗。留下真实补给来源且三项最低储备达到 45 后，下一月月初退出 episode；若乱纪元重临则沿用原 episode 回到 <code>dormant</code>。全员休眠不会终止文明。</p></article>
                        <ol>
                          <li><span class="edge-label edge-yes">dormant</span><article class="logic-node compact-node" data-kind="terminal"><span>HOLD</span><h4>维持低代谢与原位置</h4><p>本人不行动，也不会随亲代移动；每月仍消耗 0.35 水分、0.30 营养和 0.25 健康。认可待验证预言者不会提前唤醒；质疑者只能尝试一次，预言结算再改变双方关系。</p></article></li>
                          <li><span class="edge-label">recovering</span><article class="logic-node compact-node" data-kind="action"><span>RECOVER</span><h4>只执行真实补水补食链</h4><p>只允许必要移动、取得水 / 食物并摄入；未满 3 岁的恢复期幼儿只能摄入本人已有物品，不独自前往外部来源，清醒帮助者可在同地使用附近真实水源或装在实体容器中带回的水，每月协助补水一次。普通规划与原意图继续挂起。</p></article></li>
                          <li><span class="edge-label edge-no">无 episode</span>
                            <article class="logic-node" data-kind="condition"><span>G3</span><h4>本人或依赖者谁更紧急？</h4><ul><li>本人：水分 &lt;58、有食物且营养 &lt;52、无食物且营养 &lt;34，或已有冷热压力。</li><li>1–11 岁本人若水分 &lt;32、营养 &lt;34、健康 &lt;45 或已有冷热状态，会把当前可见亲代作为有 <code>caregiverRef</code> 的局部会合目标，不读取视野外位置；未满 3 岁且已在真实住所内时，不因冷热压力追逐外出亲代。</li><li>依赖者：视野内、12 岁以下的亲生子女，比较缺水、缺食、健康与冷热压力；不读取视野外身体。</li><li>两边先换算到同一紧急度尺度；孩子危机更重且存在可执行帮助时优先照护，而非固定本人在前。</li><li>未满 1 岁的清醒婴儿不会独自迁移，普通情况下由同处亲代携带；若已有冷热伤害且正在真实住所避护，成人普通行程会把婴儿留在住所，只有更急且带来源的照护运输才能带离。脱水休眠者始终留在原位。</li></ul></article>
                            <ol>
                              <li><span class="edge-label edge-yes">本人更急</span><article class="logic-node compact-node" data-kind="action"><span>REFLEX</span><h4>创建生存子中断并执行</h4><p>饮水 / 进食 / 移动 / 拾取 / 采集；有真实逃离路线时，同一已见野兽在本地视野内持续复用一个避险 episode，直到进入住所或威胁离开视野。没有安全退路的 hold 完成后下一刻重新按当前警戒半径 / 追击事实观察，旧动物 ID 不会永久阻止其他生存行动。</p></article></li>
                              <li><span class="edge-label edge-no">没有</span>
                                <article class="logic-node" data-kind="condition"><span>G4</span><h4>年轻依赖者需要紧急照护？</h4><ul><li>视野内、12 岁以下，优先身体储备最低者；同一照护 episode 已选中具体孩子时先重验该目标，再看新进入视野的其他孩子。同一目的格的成年子女不能因数组顺序覆盖真正依赖者。</li><li>未近身时，只有安全脱水条件成立、亲代手中有可转移食物，或婴儿可被携带去取水 / 找食物 / 入住所，才先会合。</li><li>孩子已经处于真实住所时，单独的冷热状态不触发会合，也不能让亲代用照护名义为自己另找住所；食水、健康和休眠危机仍分别成立。</li><li>没有可执行近身帮助时不追逐移动中的孩子；满 1 岁后的取水与避护仍来自孩子自己的合法行动。</li></ul></article>
                                <ol>
                              <li><span class="edge-label edge-yes">孩子更急</span><article class="logic-node compact-node" data-kind="action"><span>CARE</span><h4>创建照护子中断</h4><p>以具体孩子 personId 保存目标；若未近身先沿真实可达路径会合，绕障暂时越过感知边界或眼前出现健康孩子都不覆盖原目标。未满 3 岁且同处时，用当月有效的 transport basis 共同前往真实水源、食物或住所，到水边还要近身帮助饮水。普通行程不把正在住所避护的冷热受伤婴儿带出；不把照护时间算作父项目停滞。</p></article></li>
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
                <article class="logic-node" data-kind="condition"><span>P1</span><h4>本刻度需要重新审视吗？</h4><ul><li>没有当前意图；有效生殖窗口可继续或撤回，魅魔也可形成单方候选，但同一伴侣对当月完成一次尝试后都不再重复采样。待回应 / 待履约协议只有在当前上下文确实存在合法 required / fulfillment 候选时才走独立 edge，不冒充普通复核；生活 opening / response 保留在普通自主候选中。</li><li>共同生活协议只在剩余期限已不足以补齐 12 个生活月时形成返回义务；目标是双方共知的固定生活区，不是同伴实时位置。</li><li>tick 1：健康 &lt;35，水分 / 营养 &lt;28，或冷热 / 伤病 ≥2 级。</li><li>意图已越过有界复核月；或距上次进展 ≥2 个月且目标未满足。采集、储藏、放置、种植和知识默认达成即结算；只有选项显式声明 maintain-state 才在达成后继续维护。</li><li>另行探测：月初生活复核、真实 preview 确认匹配项目缺口的记录、技术示范请求、正式提议回应，以及本人在一次玩家建议回复中已经选定、等待本地重验的合法方向。</li><li>每人每月通常一次普通广义选择；本月创建、复核或跨月带入的根意图真实完成 / 阻塞 / 失败 / 放弃，且完整处理中断返回后没有父意图恢复时，下一 tick 最多再获得一次。第二次即使 idle 也在暂存月度额度与重放哈希中消费，但不制造无变化的持久 DecisionFact。真实记录、紧急生存、履约、技术示范和本月新 formal required proposal 走独立边沿通道；required accept / reject 始终优先，普通生活 response 不强制。</li></ul></article>
                <ol>
                  <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="terminal"><span>CONTINUE</span><h4>不重新决策</h4><p>直接编译当前长期意图。</p></article></li>
                  <li><span class="edge-label edge-yes">是</span>
                    <article class="logic-node" data-kind="process"><span>P2</span><h4>在只读快照中编译候选</h4><p>输入只有可见格 / 人 / 动物 / 掉落物、本人记忆与知识、长期关切、项目、协议、权限和当前意图。仍开放 agenda 的 approach 只有在本人当前仍持有 / 看得见对应 opaque ref 且没有同 basis 无新证据的失败评价时，才编译为 observe / combine / expose / exert 的有界候选。新的 agenda 目前只从显式模型 update / proposal 创建或修改；本地 option、Project 与多月 Intent 继续保持各自客观生命周期，并只能绑定既有 agenda，不能自动合成主观关切。旧 local-deliberation item 保留兼容，玩家直接写入口尚未实现。记录使用只检查本人拥有的活跃项目及真实技术缺口，载体来源限于本人背包与调用方已过滤的可见公共地面掉落物；不读他人背包、知识或意图，也不进入通用对话 follow-up。精确匹配后，认知 appraisal 可从记录 basis 重新验证当前项目并继承其 need / pressure / commitment，但记录子意图仍不写普通 projectId，取得和阅读不会冒充项目进展。普通材料物流只统计空白可消费载体；旧 episode 若锁定的掉落物现已承载记录便立即失效。预览搜索路线和物流步骤不会打开真实 campaign 或改写项目；嵌套 planning preview 继承外层当月 overlay，使候选动作与提交前重编译看到相同事实。年龄门禁在每次编译时执行。固体放置与领域执行器复用同一体素结合产物规则，机械 / 电力安装从自身冻结 action basis 取得精确安装位；无论是眼前 nextAction、移动后的 completionAction，还是移动 / 物流结束后才由 active intent 重编译出的放置，目标仍是空气却被身体占据时都只等待，不提交失败事实。身体离开后下一 tick 自然重编译；目标若已不再是空气则仍进入领域失败与项目复核。相同结构失败 basis 优先从 terminal Intent 引用的真实 blocked / failed ActionFact 重建；失败当月完全相同的实际动作不会因换 goal / project 被第二次普通复议原样提交，跨月后再按完整 basis 与新来源判断。第 0–6 月冷却、第 7 月恢复，兼容 failure memory 同样显式保留这 7 个月；required / fulfillment 绕过，旧自由文本无法还原 basis 时 fail-open。相似的可选社交不按固定月份删除，而在后续认知 appraisal 中评估重复成本。</p></article>
                    <ol>
                      <li><span class="edge-label">候选已生成</span>
                <article class="logic-node score-node" data-kind="process"><span>CAUSAL BDI</span><h4>Belief → Durable Concern → Desire → Intention</h4><ul><li><b>硬优先级先行</b>：可感知的紧急休眠先于正式 required accept / reject，后者又先于 fulfillment；普通生活 response 留在自主候选中。若当前已经在执行正式回应或履约，新义务保留排队，不无条件打断。</li><li><b>B · Belief</b>：DecisionContext 只含局部感知、有来源记忆 / 知识、当前项目与承诺。Action 结果后验与 Intent goalOutcome 后验分离；后者决定目标成功预期。程序性信念明确命名 action / goal family 和精确次数，不用“这类事情”或小样本伪百分比。</li><li><b>长期关切</b>：CharacterAgenda 的 aim 是人物主观且有来源的跨月关切，approach 是可被 response / no-response 替换的办法。一个 agenda 可关联多个 Intent / Project，却不能直接执行；方法失败不删除 aim，同 basis 无新事实不得盲重试。自由策略可保留为 MentalAct；一旦方法被判为 executable，就必须改用本地选中 option 的摘要，只有重验通过的 opaque probe 可保留为有界试验。新 item 只由显式模型 update / proposal 创建，本地计划只能绑定既有 item；旧 local-deliberation 状态兼容。过期且无 executable episode 的 concern 会 suspended 并可让出容量。</li><li><b>D · Desire</b>：agenda need 精确绑定 characterAgendaItemId，只能激活同一关切编译的候选，不能给同属 inquiry / capability 的无关 option 冒领。其他 NeedAgenda 仍从身体、安全、照护、储备、能力、承诺、归属、generativity、自主与探究压力派生有界需要；仍生效的共同生活按关系质量与实际同居连续满足一部分 belonging，只削减未满足缺口。正向生殖只能由 generativity 激活，belonging / autonomy 不能旁路激活。普通生殖的关系、人格、双方同意与准备度只在激活后连续门控；魅魔由特质来源形成 generativity 并跳过这些社会门控，但不能跳过成年、异性、同地、在世和未妊娠等物理事实。</li><li><b>有界前向</b>：廉价排序后只比较最多 4 个根、每节点 2 个后继、深度 3、一次人物决策 24 节点；选择与执行审计复用同一树，required / commitment 与 follow-up 不另展开。只命名本人有来源的 response / no-response / verification / replan。没有真实两难、替代项或观察不会改变下一选择时 VoI 为 0；硬义务与急性生存优先不被绕过。</li><li><b>I · Intention</b>：候选先跨过本人 aspiration，再与当前 Intent 的进度、尽责性、同一 agenda / 项目压力、停滞和切换边际比较；每人只有一个执行焦点，急性任务保存可返回父意图。Project Intent 保存稳定项目目标，当前原子步骤只由当次 option / ActionFact 描述。</li><li><b>因果排序</b>：需要使用概率并集，其他因素使用有明确语义的乘法门控；前向 / 信息软调整分别封顶 0.08 / 0.04，不再把九个任意量纲直接相加。稳定种子只以万分之一破真正同分。</li><li><b>计划与行动</b>：Project / HTN 从 Intention 编译下一步，领域执行器重验；提交的 ActionFact 更新动作 Belief，Intent 结算再独立更新 goalOutcome Belief；二者也据实评价关联 approach。动作失败只由同一 ActionFact 写一次经历；无 ActionFact 的重编译终止结算为 not-evaluated，不增加目标失败后验，也不把编译诊断写成人物经历。无 ActionFact 的终止会 park，不留下幽灵 activeIntent；直接死亡与休眠恢复终局也不能旁路结算。</li><li><b>诊断兼容</b>：旧 factor forest 只把 need、care、commitment、learning、relationship、social-repetition、consent、feasibility、harm 投影成理由与来源，不再拥有排序权。</li><li><b>模型所有权</b>：实时模型与规则规划器共用 action-option-semantics-v1；ID 只是不透明句柄。真实 decision 路由存在时，optional talk 的自愿社交由模型选择或 idle；本地回退和后续 tick 过滤它们，只继续 required response、commitment、生存、生产与物理行动，急迫求水 / 求食保留为本地例外。创世上下文参与普通有界容量，危险与既定履约不进入重选。compact 与 full 都隐藏 failure / discovery / everyday 等预选 opening，每个有来源近身听者只给一个 open 方向；模型用 0～3 个当次 q handle 绑定本人事实，服务端映射并在执行前重编译。返回后仍校验 option、follow-up、grounding 与正式 stance。decision 使用 compact DTO，可随 start / revise / idle 返回 create / revise / pause / abandon；不新增调用。模型还可读取至多四条本人已说或听见、早于本月且核验到 completed ActionFact 的原话，但原话不证明事实或同意。create / revise 缺匹配 option / probe 时以 missing-affordance 孵化且不创建 Intent；probe 只允许 observe / combine / expose / exert，已有 agenda 用当次 g1 / g2 handle 修订并重验引用。</li></ul></article>
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
                                <article class="logic-node interrupt-node" data-kind="condition"><span>P4-B</span><h4>挑战者足以越过意图持续门槛？</h4><ol><li><b>优先义务</b>：紧急休眠、正式 required accept / reject 与履约在普通 BDI 竞争前处理；普通生活 response 自主竞争。已经开始的优先义务先完成，新义务随后保留。</li><li><b>子中断</b>：已经选择的回应、履约、生活复核或记录使用只有在父项目 / 返回上下文存在时保存可返回父意图。</li><li><b>生活复核</b>：低风险陪伴请求、正式结伴或生殖等具体关系候选，先满足生活压力 ≥ 项目压力 +10，随后仍须成为跨过 aspiration 的挑战者。</li><li><b>意图惯性</b>：同项目最佳步骤直接继续；否则比较进度、尽责性、项目压力、成功后验、停滞和切换边际。</li><li><b>替换证据</b>：期限已过、急性身体 / 安全 / 照护需要、持续停滞，或不同挑战者明显强于当前承诺。</li></ol></article>
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
          <header><span>03 · ACTION COMPILATION</span><h3 id="compileTreeTitle">最后把意图编译成可裁决、可回放的动作</h3><p>项目不是直接“完成”。规划器逐步补齐材料、路线、数量、工具与授权；同一刻度最多提交一个语言动作和一个兼容身体动作，分别留下事实。</p></header>
          <div class="decision-tree-scroll">
            <ol class="logic-tree">
              <li>
                <article class="logic-node" data-kind="condition"><span>C1</span><h4>已选择目标的下一步可提交？</h4><p>候选阶段只做快照预览；选择后才在权威项目上检查数量缺口、AND / OR 材料需求、已知操作、固定场地、贡献者并提交搜索 / 物流状态。局部等价项目在提交边界再次去重：复用权威项目、合并受益者与触发事实、重绑意图；非所有者只可在创建当月等待已有步骤。</p></article>
                <ol>
                  <li><span class="edge-label edge-yes">是</span><article class="logic-node" data-kind="process"><span>C2-A</span><h4>生成直接动作</h4><p>从 move / transfer / act / attend / talk 中选择一步；act 再指定物质操作。地面记录来源依冻结 basis 逐步执行 move → exact transfer-to-self（acquire）→ own-inventory attend（read）→ 同一项目真实 act（experiment）；acquire / read 保持为可返回的记录子意图，只有准备与实验进入项目动作账本。同月取得的多条记录以各自权威 transfer 事件区分实体栈。外部 exact-lineage 交付或既有已读只允许依当前真实状态继续，不补动作历史。</p></article></li>
                  <li><span class="edge-label edge-no">缺来源或方法</span>
                    <article class="logic-node" data-kind="condition"><span>C2-B</span><h4>本人有可用证据？</h4><ul><li>看见不等于可用：便携物必须在本人背包或当前可取得的掉落物中；设施必须真实放入世界且记忆位置仍可核对。</li><li>可见或有来源记忆的材料地点 → 生成路线 / 取材。</li><li>固定场地合金、铁器项目与明确的公共厅堂项目可向眼前有材料的人发追加式请求；普通协调项目不扩展。贡献转移精确引用请求，并按请求余量和实时缺口截量；冶金材料送到固定作坊，不追逐 owner。</li><li>已建且可核对的铸造场承接青铜冶金；观察到青铜能力与烧结砖可提出铁匠铺，Smithy 落地后铁料、还原、锻打与工具阶段逐段返回该工位。设施必须出现在实际生产事件中，不能只靠项目标签计使用。</li><li>水力机械只接受本人 attend 过的具体可用水流段；计划冻结源与直线工地，未知部件仍走盲试。冻结格若被后来实体占用，首次失败留下来源绑定的场地冲突并停止原址重试；尚无已装部件时，当前负责人或已亲自复查水流的合法继任者只能从眼前可见、可达、为空且有承托的同水流候选中显式改址，并保留已制造 / 核验构件。部分安装或无候选时不静默搬迁。安装可跨短期失流继续，但 commissioning / operate 必须等 live flow；首次试运转的 progressed 错位故障保留输入，故障后新轴 + BronzeTool 维修，再有真实 Seed → Food 作业才完成。</li><li>未知来源 → 只在有限可见范围内搜索；耗尽后仍先保留精确缺口至复核期限，并距最后真实进展或精确关闭至少 4 个月；期间出现精确新来源便由同一项目恢复。只有期限过后且没有合法等待才阻塞。以后同功能重开必须出现并实际使用精确的新来源或新可靠计划；旧来源换栈、换项目 ID、月份流逝、压力或移动变化都不算。</li><li>未知方法 → 用眼前材料做预算受限的假说试验；问题类型只能表达可感知角色 / 性质，不能表达正确 material ID、rule ID 或预期产物。排序只继承人物自己的精确输入 / 工具经验，以及 operation、question、candidate 与当前有形来源组合都相同的 response / no-response；已核验产物只能改善该实体的感知 profile，不能给其他未试组合加分。`attempt:*` 只是试验身份，不是应生成的合成知识目标；ActionFact 评价 response，未生成该虚构知识不得写成目标失败。度量项目只按对称悬挂和稳定参考角色尝试二 / 三份实体。已经耗尽实体假说的建造项目同样要有新材料类型、新计划、新目标或新 verified response 才能续证。</li><li>已有完整物理链的定居耕作不进入通用材料配方假说：缺种时只有眼前确有可达浆果灌木或成熟作物，才建立绑定源体素、工作位与 Seed 缺口的 source episode；等待湿润或生长时以 world-change wait 让出当前焦点，不制造“无法编译”的失败。项目还会按本项目已完成播种的不同位置计算缺口，优先使用从未播过的可耕格；只剩本地夯土时，人物以手中通用生产工具做不预告结果的有界地表尝试，真实无响应进入记忆，真实变化才成为可复用技术。</li></ul></article>
                    <ol>
                      <li><span class="edge-label edge-yes">可补齐</span><article class="logic-node compact-node" data-kind="process"><span>REPAIR</span><h4>插入同目标前置步骤</h4><p>移动、取材、恢复、请求协助或有限试验。</p></article></li>
                      <li><span class="edge-label edge-no">仍不可知</span><article class="logic-node compact-node" data-kind="terminal"><span>BLOCKED</span><h4>留下明确阻塞</h4><p>不读取隐藏配方或全局地图；耕作可先用有形田间工具逐步整理草地、裸土或夯土，之后只有幼苗可等待生长，成熟作物必须收获或进入正常复核。</p></article></li>
                    </ol>
                  </li>
                </ol>
                <ol>
                  <li><span class="edge-label">已生成动作</span>
                    <article class="logic-node" data-kind="condition"><span>C3</span><h4>提交前预演是否合法？</h4><p>检查路径、目标、数量、材料、工具、授权、身体和空间；工具取得固定精确地面来源，生产动作在每次重编译后重新选择本人最佳适用工具。失败时优先在同一目标内局部修复，并留下可供有限冷却与新证据重开的结构 basis。</p></article>
                    <ol>
                      <li><span class="edge-label edge-no">否，可修复</span><article class="logic-node compact-node" data-kind="process"><span>LOOP</span><h4>重编译前置动作</h4><p>下一个可用刻度再预演。</p></article></li>
                      <li><span class="edge-label edge-no">否，不可修复</span><article class="logic-node compact-node" data-kind="terminal"><span>BLOCKED</span><h4>保留规划诊断</h4><p>供项目与后续重评使用；没有真实 ActionFact 时不写人物经历，也不累计目标失败。</p></article></li>
                      <li><span class="edge-label edge-yes">是</span>
                        <article class="logic-node" data-kind="action"><span>COMMIT</span><h4>提交语言与身体通道</h4><p>写入同一 actionTick 下各自的路径、沟通、消耗、产物、来源与成功 / 阻塞 <code>ActionFact</code>。</p></article>
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
        <article data-tone="agent"><span>02 · DECIDE</span><strong>本地候选与硬边界</strong><p>先从人物可获得的事实中生成合法候选并处理生存、必须回应、承诺、生产与物理行动；模型模式不替模型生成可选社交，本地模式则可完整继续。</p></article>
        <div class="flow-arrow" aria-hidden="true">→</div>
        <article data-tone="effect"><span>03 · COMMIT</span><strong>WorldEvent 历史</strong><p>所有已提交变化留下可回放、可追责的事件和来源。</p></article>
        <div class="flow-arrow" aria-hidden="true">→</div>
        <article data-tone="observer"><span>04 · READ</span><strong>投影、报告与体素画面</strong><p>只读地解释事实；不能生成第二套行动、建筑或文明进度。</p></article>
      </div>
      <aside class="model-sidecar">
        <span class="sidecar-line" aria-hidden="true"></span>
        <div><span>MODEL MIND LOOP</span><strong>模型在月初和月内认知事件后形成 MentalAct，但不能绕过本地规则</strong><p>真实沟通、观察、combine / exert / expose 结果或失败会把相关人物加入下一 tick 前的批量心智请求；每人每月最多两次。上下文含 planningTick 和此前已发生的本月事实，输出从下一 tick 生效。协议错误或网络失败只退回本地合法链，已经执行的事实不回滚，也不重新调用模型回放。</p></div>
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
        <article><strong>生活对话</strong><code>application/conversation-options.ts · domain/action-option-semantics.ts</code><span>本地有源菜单、模型单一 open affordance、0～3 个 request-scoped grounding handles、执行前重编译、optional response、语音门禁与 listener 轮换</span></article>
        <article><strong>关系证据</strong><code>domain/relation.ts · domain/relationship-evidence.ts · application/social-options.ts</code><span>先民 10 / 10 相识起点；最近 24 条热来源与有界语义锚点分层，决定按关系主题和 self / other 槽位保存；founding 不解锁 company / companion / reproduction；有效中性回应以 0 数值变化保留参与事实，正式关系仍要求精确双方、跨月和直接照护 / 实质回应 / 履约来源；接受 / 拒绝边界只作由时间与后续真实证据连续改变的软偏好，锚点不充当候选禁令</span></article>
        <article><strong>长期关切</strong><code>domain/character-agenda.ts · application/character-agenda.ts · application/simulation/model-review.ts</code><span>显式模型 create / revise / pause / abandon、缺 affordance 孵化、有界 probe、durable option 绑定、model agenda 客观达成后 fulfilled、ActionFact response / no-response 评价、无相关新证据禁重试；本地不自动合成，旧 local-deliberation 状态兼容</span></article>
        <article><strong>因果 BDI</strong><code>application/cognition/** · domain/cognition.ts</code><span>动态需要、人格 / 记忆 / 结果后验门控、有界前向 / VoI 与意图持续</span></article>
        <article><strong>人格学习</strong><code>founder-persona.ts · domain/personality.ts</code><span>创世档案先验、后代继承、行动证据、跨情境整合与慢速变化</span></article>
        <article><strong>人物 Persona</strong><code>domain/person-soul.ts · server/persona-context.ts</code><span>Soul v3 稳定核心、合成声线示例、有来源 experience，以及输出前单侧面 character-turn-note</span></article>
        <article><strong>人物特质</strong><code>domain/trait.ts · docs/person-traits-v1.md</code><span>固定先民、确定性遗传、随机异变、三项遗传加一项异变上限，以及先知 / 魅魔 / 双生 / 饕餮与身体 / 记忆 / 母脉效果</span></article>
        <article><strong>生命周期</strong><code>domain/life-stage.ts · application/age-planning.ts</code><span>年龄门禁、受限劳动与婴儿移动归属</span></article>
        <article><strong>纪元预言</strong><code>domain/era-prediction.ts</code><span>历史估计、可信听众与休眠唤醒边界</span></article>
        <article><strong>人口承载</strong><code>domain/population-capacity.ts</code><span>受孕概率衰减与超载资源竞争</span></article>
        <article><strong>死亡善后</strong><code>domain/mortuary.ts · application/mortuary-options.ts</code><span>遗体、死亡知情、丧亲需要、物理安葬链与墓记</span></article>
        <article><strong>本地排序</strong><code>application/rule-planner.ts · application/cognition/need-agenda.ts · application/cognition/option-appraisal.ts · application/cognition/bdi-deliberation.ts</code><span>硬优先级、aspiration、按 project / agreement / person 精确绑定的需要、意图持续与继续 / 中断 / 改计划</span></article>
        <article><strong>模型重选</strong><code>domain/action-option-semantics.ts · application/rule-planner.ts · application/model-decision/* · server/backend-decider.ts · model-decision-gateway.ts</code><span>模型模式拥有 optional talk，自愿社交失败不由本地补造；required / commitment / survival / physical 仍本地执行。compact / full 都隐藏规则预选 opening，默认 compact handles、开放交谈事实句柄、至多四条已提交原话、agenda update piggyback 与最终重验</span></article>
        <article><strong>人物主动对话</strong><code>server/agent-interaction-gateway.ts · server/persona-context.ts · application/player-interaction-choice.ts · PersonConversation.tsx</code><span>可见回复与隐藏意图两阶段、情境人格帧、定向记忆、表达能力、来源约束事实与本地合法 choice</span></article>
        <article><strong>实时台词</strong><code>projection/live-speech.ts · projection/speech-history.ts · server/live-speech-service.ts</code><span>合法非依赖 decision utterance 原话直出、结构化 speechAct 草稿、精确父 SpeechLine 依赖、speech-only dialogueMove / disposition / replyToSpeechLineId、行动历史同源原话；缺父不发孤儿引号台词</span></article>
        <article><strong>后代取名</strong><code>naming.ts · server/newborn-naming-service.ts</code><span>确定性保底姓名、父母与处境提名上下文、本地 givenName 验收、出生事实来源与失败回退</span></article>
        <article><strong>共同生活</strong><code>domain/shared-living.ts · domain/agreement.ts · application/social-options.ts</code><span>稳定生活锚点、12 / 24 月履约窗口、独立行动和不追踪成员实时位置</span></article>
        <article><strong>社会学习</strong><code>domain/social-learning.ts · application/cognition/social-expectation.ts</code><span>情境化回应 / 意愿 / 可靠性、top2 + 轮换探索、supported / contested practice 与制度提议门</span></article>
        <article><strong>持续项目</strong><code>application/project-options.ts · application/local-material-evidence.ts · domain/project-material-request.ts</code><span>压力、能力证据、局部去重、材料请求、物流、试验、协作与完成</span></article>
        <article><strong>水流机械链</strong><code>domain/mechanical-power.ts · application/mechanical-power-options.ts · domain/action-executor.ts</code><span>显式有向水流、本人观察、冻结工地、严格拓扑、commissioning、持续负载磨损、实体断轴、个人诊断、故障后备件、修后运行与明确教导</span></article>
        <article><strong>耐久记录</strong><code>application/record-use-options.ts · domain/action-executor.ts · server/evolution-artifacts.ts</code><span>写入发布、载体守恒、读者自有项目、精确来源复用与严格完整链审计</span></article>
        <article><strong>动作裁决</strong><code>domain/action-executor.ts</code><span>五种原子动作与九种物质操作的后果</span></article>
        <article><strong>自然过程</strong><code>domain/monthly-processes.ts</code><span>纪元、天气、生态、身体、出生与死亡</span></article>
        <article><strong>观察器</strong><code>domain/civilization-index.ts · domain/era-progression.ts · projection/derived-observations.ts</code><span>文明指数、当前物理耕作区与可回放耕作闭环的只读阶段门槛</span></article>
        <article><strong>表现层</strong><code>server/authoritative-cosmos.ts · server/live-observer-runner.ts · adapter.ts · month-playback-buffer.ts · ImmersiveGame.tsx · SocietyScene3D.tsx · society-scene/speechPlayback.ts · src/game/voxelKits.ts</code><span>服务端仅在有效在线观察租约存在时推进权威月份；浏览器轮询最新已提交帧并在 authority 切换时完整重同步，人物、环境与逐句台词只在相邻权威投影之间做表现插值</span></article>
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
