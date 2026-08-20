import { mountDocumentLibrary } from './docs-page.js';
import { KNOWLEDGE_DOCUMENTS } from './knowledge-docs.js';
import { mountRecipeLibrary, recipeSearchRecord } from './recipes-page.js';
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

        <article class="architecture-board" aria-labelledby="worldArchitectureTitle">
          <header class="architecture-board-head">
            <div><span>02 · WORLD ARCHITECTURE</span><h3 id="worldArchitectureTitle">世界架构</h3></div>
            <p><code>SimulationState</code> 是根；物理、生命、社会与历史共享同一条时间线。</p>
          </header>
          <div class="architecture-root" data-tone="world">
            <span>ROOT</span><strong>SimulationState</strong><small>不是多个互相猜测的子世界</small>
          </div>
          <div class="architecture-branch-grid architecture-branch-grid-2">
            <section data-tone="world"><span>W1 · 物理世界</span><strong>空间与物质</strong><p>84 × 52 × 12 体素、掉落物、结构、容器、水流、站立位置和路径。</p></section>
            <section data-tone="world"><span>W2 · 自然世界</span><strong>时间与生态</strong><p>纪元、跨月天气、火、作物、动物、身体过程、出生与死亡。</p></section>
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

        <article class="architecture-board" aria-labelledby="personArchitectureTitle">
          <header class="architecture-board-head">
            <div><span>03 · PERSON ARCHITECTURE</span><h3 id="personArchitectureTitle">人物架构</h3></div>
            <p>人物不是一个 prompt，而是一条从局部事实到行动后学习的闭环。</p>
          </header>
          <div class="person-architecture">
            <section class="person-layer" data-tone="world">
              <span>P1 · 权威输入</span><strong>世界事实 + PersonState + 共享承诺状态</strong>
              <p>身体、位置、库存、知识、记忆、关系、人格，以及状态中的 Intent / Project / Agreement。</p>
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
            <li><strong>时间与纪元</strong><span>恒纪元 / 乱纪元持续区段；天气按月结算但以跨月过程叠加在纪元之上，类型具有不改变长程占比的延续惯性，强度只偶发逐级变化。</span></li>
            <li><strong>空间与物质</strong><span>84 × 52 × 12 体素、通行、可达位置、掉落物和材料响应。</span></li>
            <li><strong>水流与机械动力</strong><span>河道持久化有向 water current 段，段是否可用仍由当前 Water 体素与上游连通性现场派生；普通 Water 不能被猜成动力源。这只是受限机械网络，不代表电力、信号、计算或信息时代。</span></li>
            <li><strong>身体与人口</strong><span>健康、水分、营养、冷热、伤病、衰老、妊娠、9–15 个月产后恢复、出生与死亡；人口接近 50 时受孕机会递减，超过承载能力后资源消耗继续上升。出生始终先生成种子可回放的保底姓名；模型演进可在提交前提议 givenName，但姓氏、顺序、字符、重名与失败回退由本地规则控制。</span></li>
            <li><strong>文明终局</strong><span>只有月末无存活者，或运行达到显式 endpoint 时结束。全员脱水休眠不是终局；环境、身体代价、纪元切换与恢复仍继续推进。</span></li>
            <li><strong>生态</strong><span>植物生长、动物迁移 / 捕猎 / 繁殖，以及风暴、干旱、冰雪和火。</span></li>
          </ul>
          <code>domain/monthly-processes.ts · world/grid.ts</code>
        </details>

        <details class="rule-branch" data-tone="agent" open>
          <summary><span>人物事实</span><small>规划器只能读取本人可获得的信息</small></summary>
          <ul>
            <li><strong>局部感知</strong><span>可见格、可见人物 / 动物 / 掉落物，以及真实可达性。</span></li>
            <li><strong>记忆与知识</strong><span>近期事件、有来源的已知地点、技术置信度、关系和失败经验；本人亲历动作还保存机器可读的动作 / 目标 basis、结果、效价与参与者，并从真实 ActionFact 更新有界 Beta 成功后验、预计努力与预计伤害，不解析中文摘要。失败重试比较动作、目标、数量、人物、项目、记录与关系组成的结构 basis，不比较临时 option ID 或显示摘要。成年人只有在历史估计进入未来六个月窗口后才会形成纪元预言，不能读取隐藏调度或发布几年后的远期预言。</span></li>
            <li><strong>能力证据</strong><span>observed 只证明看见；accessible portable 只含本人背包和可取得掉落物；placed facility 必须是世界中真实放置、记忆后重新核对仍在场的设施。旁人背包不能冒充本人工具或公共设施。</span></li>
            <li><strong>工具升级与采用</strong><span>生产工具按木 / 骨、石器、石锄、青铜、铁的真实效用等级比较；低级工具只部分缓解劳动压力。本人近期真实生产劳动可提高可达高级地面工具与交换报价的价值；他人背包工具只能经同格自愿交换，且持有者交易后必须保留原有最高生产能力。移动后的采集、收获与捕猎会重新选择本人当前实际效用最高的适用工具。</span></li>
            <li><strong>年龄与能力</strong><span>未满 1 岁依赖亲代；1–11 岁可自主跟随、取水、拾取、学习和简单劳动，但普通移动不得逐格漂出当前可见亲代的本地照护半径，严重压力时只可走向当前可见亲代；12–15 岁可生产及协作既有项目；16 岁起才有完整规划能力。</span></li>
            <li><strong>身体、身份与人格</strong><span>身体储备、状态限制、HEXACO 六维、控制 / 地位敏感度、亲缘认识和共同体职责；父母、子女与兄弟姐妹从 geneticParents 稳定投影，不挤占可衰减的事件记忆。经历只能通过带来源证据缓慢改变人格。baseline 人格和稳定身份还会派生跨轮一致的 Soul v2：稳定 styleMatrix 与危险、自主、亲近、承诺、未知五个情境侧面可参与合法候选内的个人取舍，但不创造候选或事实。</span></li>
            <li><strong>当前意图</strong><span>一个 BDI 执行焦点；进度、尽责性、项目压力与个人成功预期维持承诺惯性，普通竞争候选不会让它每刻度重抽。其他压力不会同时变成并行动作。</span></li>
          </ul>
          <code>domain/person.ts · domain/person-soul.ts · domain/memory.ts · application/action-options.ts</code>
        </details>

        <details class="rule-branch" data-tone="social" open>
          <summary><span>需要与项目</span><small>持续工作以项目为单位</small></summary>
          <ul>
            <li><strong>生存与安全</strong><span>保温、捕猎安全、照护、熟食与住所容量。</span></li>
            <li><strong>生产与储备</strong><span>工具、耕作、储藏、供水、窑炉、冶金与功能建筑；受抚养人口会提高生产和储备压力。工具项目的第一件偶然样品不会直接完成，项目来源的更优工具仍须由本人持有，并把对应制作技艺复验到可靠阈值。</span></li>
            <li><strong>住所建材边界</strong><span>住所项目只消耗尚未组装的石、木、木板等实体建材；谷仓、窑炉、容器和机械构件等 placeable 成品保持自身功能，不能被当作通用墙体再次消费。</span></li>
            <li><strong>公共谷仓收敛</strong><span>谷仓构件一旦由项目协作者制成，同月其他人会先等待它落地；真实落地后只继续形成首批储备，不再回退制作第二套设施。已知设施配方只能在仍有对应项目时重复制作，不能作为普通试验把成品堆进背包。仍存在的已完成谷仓会抑制项目受益人和贡献者重复立项，但不会泄露远处库存或赋予远程取用能力。</span></li>
            <li><strong>定居耕作</strong><span>本人计入自己的局部食物与身体压力；附近人口只可提高优先级，不再是启动资格。人物还必须感知到可用种源与可耕作地点；项目锚定局部地块，缺种先取种，等待湿润或生长时不猜无关配方，并只用本项目在该地块的六个不同播种格与两次真实收获判定完成。</span></li>
            <li><strong>知识与探索</strong><span>因真实缺口触发有限试验、验证、教学和耐久记录。</span></li>
            <li><strong>项目持久性</strong><span>触发事实、压力、场地、材料数量、物流、贡献者、进度与失败均可追溯；完成证据先于所有者死亡结算，已做成的项目不会被误记为放弃。便携产物只以当前目标材料栈来源与本项目 actionEventIds 的交集作为完成证据，旧项目同材质产物不会让新项目即时完成。</span></li>
            <li><strong>局部去重</strong><span>同功能、受益者 / 目标与局部场地重叠时先复用，提交边界再次校验；同刻度竞争创建会合并受益者与触发事实并重绑意图。非所有者只在创建当月有界等待，远处不重叠项目仍可并行。</span></li>
            <li><strong>材料请求</strong><span>当前仅固定场地合金项目可发起追加式请求；open / fulfilled / expired / contributors-unavailable 从期限、实时缺口、贡献者与真实转移派生。转移精确引用请求，并按请求余量和当前缺口截量。</span></li>
            <li><strong>记录发布</strong><span>项目所有者在固定场地写入空白载体；一旦背包中已有与项目、知识和写入事实精确匹配的已写载体，返回场地并投放到精确地面优先于旧搜索 / 物流。没有合格载体时仍走原制造与物流，成功投放沿既有项目完成事实收口。</span></li>
            <li><strong>机械试建</strong><span>人物先有本人真实 Mill 劳动压力，再在可见、可达处 attend 具体水流段；项目只冻结来源与可见工地几何，不泄漏 WaterWheel / DriveShaft 配方、时代门槛或观察器目标，未知方法仍走有预算的盲试与验证。</span></li>
          </ul>
          <code>domain/project.ts · domain/project-material-request.ts · application/local-material-evidence.ts · application/project-options.ts</code>
        </details>

        <details class="rule-branch" data-tone="effect" open>
          <summary><span>动作与后果</span><small>世界规则裁决眼前动作是否合法</small></summary>
          <ul>
            <li><strong>五种原子动作</strong><span>move · transfer · act · attend · communicate。</span></li>
            <li><strong>九种物质操作</strong><span>exert · separate · combine · expose · ingest · reproduce · hunt · dehydrate · rehydrate。</span></li>
            <li><strong>提交前预演</strong><span>检查目标、路径、材料、工具、授权、身体和空间；person→ground 只能投放到人物当前 cell / z，不能远程落物。</span></li>
            <li><strong>载体守恒</strong><span>带 recordPayloadId 的本人库存栈不会进入普通 combine / exert / expose 消耗候选，领域层也在扣减前拒绝；空白载体仍可写入或用于其他合法动作。</span></li>
            <li><strong>机械链裁决</strong><span>工地必须保持 Water 端点 → 正上方 WaterWheel → 水平 DriveShaft → 新 Mill。首次 commissioning misalignment 记为 progressed、Seed 输入守恒；随后必须用故障后新造的新轴与 BronzeTool 维修，维修后的 Seed → Food 作业才完成项目。失流、错源、错计划、错站点或拓扑变化都在扣减前拒绝。</span></li>
            <li><strong>客观事件</strong><span>成功或阻塞都写入 ActionFact；库存、位置和身体不可凭叙事改动。</span></li>
          </ul>
          <code>domain/action.ts · domain/action-executor.ts</code>
        </details>

        <details class="rule-branch" data-tone="agent" open>
          <summary><span>社会与学习</span><small>重复的真实协作才可能形成社会结构</small></summary>
          <ul>
            <li><strong>互动</strong><span>先民双向关系从 55 开始；同月每 5 个“双方都行动且行动后同地”的规划刻度，双向增加 trust / bond 各 1；已生效的结伴双方在同一稳定生活区的不同格行动也可累计。单月最多 3；单纯同处、空闲、休眠和失败动作不计。结伴门槛为本人有来源的 20 / 20，生殖要求双方双向 60 / 60。</span></li>
            <li><strong>共同生活</strong><span>结伴提议保存双方共知的稳定生活地点；生活区内可以各站不同格。日常取水、劳动、学习可各自行动；只在 24 个月约定的时间余量用尽、若不返回就无法累计 12 个月共同生活时，才以空闲生活槽位为目标返回。结伴、共同体身份或仅仅看见别人都不会自动追踪实时坐标；跨地交谈必须绑定一个有真实来源的话题和后续沟通。</span></li>
            <li><strong>承诺</strong><span>提议必须回应；生效协议要通过后续行动履约。生殖接受形成最长四个月的可撤回窗口，同一伴侣对每月最多一次真实尝试；每次动作精确绑定协议并重验 60 / 60，未受孕继续窗口，受孕、撤回、关系失效或到期才结清。</span></li>
            <li><strong>近亲风险认识</strong><span>亲缘不改变动作合法性，而是提高后代遗传负荷、出生偏差、寿命压力与后续疾病概率。人物观察或学到这些后果后，风险知识从第一次有源证据起按置信度连续形成软成本；满置信度也不再近似否决。每个关系与身体条件合格的伴侣都保留独立候选，再由同一认知 appraisal 比较关系、责任与亲缘风险。</span></li>
            <li><strong>再次开口</strong><span>没有固定两月冷却：可选社交仍生成候选，再由人物自己的记忆评估同受众、同主题是否有新事实。无新证据且上次未回应 / 拒绝 / 保留会降权；新事实，或与求助 / 照护 / 困境直接相关的显著生存危险，可提高再次开口价值。协议幂等、每人一次回应、同一事实 basis 与开场回应去重仍是硬门禁。</span></li>
            <li><strong>传播</strong><span>观察到的成功可复查、教导、模仿或写入实体记录。直接教学仍可把技术知识提升到 60；阅读只形成不高于 54 的暂定知识，真实项目实验再增加 18。</span></li>
            <li><strong>记录复用</strong><span>新候选只服务读者本人活跃项目的真实技术缺口，只看本人背包与可见公共地面记录，并冻结 exact source。地面正常链为 move → acquire → read → experiment：move 不计取得，只有精确 drop 成功转入本人背包才算 acquire，来源消失或替换时不换源。</span></li>
            <li><strong>制度</strong><span>多人项目、重复角色、授权与分配闭环改变未来行为时才成立。</span></li>
          </ul>
          <code>application/social-options.ts · application/record-use-options.ts · domain/social-repetition.ts · domain/agreement.ts · domain/shared-living.ts · domain/governance.ts</code>
        </details>

        <details class="rule-branch observer-branch" data-tone="observer" open>
          <summary><span>观察与表现</span><small>只读，不参与人物选择</small></summary>
          <ul>
            <li><strong>文明指数</strong><span>人口、疆域 / 设施、科技、社会与历史的事后投影。</span></li>
            <li><strong>能力里程碑</strong><span>从事件证据链识别实践、阶段与复杂性，不向人物发奖励。</span></li>
            <li><strong>事实报告</strong><span>运行摘要、转折点、毁灭原因和文明编号都来自真实历史。记录完整链还必须通过同一 basis 的身份、项目、payload / codebook、精确取得、可靠阅读、实验产物与 +18、顺序及项目进度守卫；外部 exact-lineage 交付或既有已读可按真实状态继续，但不补造阶段、不计完整链。</span></li>
            <li><strong>口头台词</strong><span>主动对话、决策 utterance 与 speech-only 共用人物 Soul 保持同一声音；每轮只激活一个最相关情境侧面，记忆按话题与真实听者筛选，年龄 / communication 能力限制句式。speech-only 还从当前 speechAct、人格、控制敏感度、身体压力、关系及有源冲突派生 neutral / warm / familiar / guarded / blunt / confrontational 姿态：日常陈述默认 neutral，低信任通常先 guarded，blunt 只在边界话语与低宜人性、控制敏感或急迫压力共同支持时出现。命令式短句不要求礼貌词，但直接不自动等于不耐烦；敌意只由真实伤害、背约或拒绝后重复施压开放。规则动作只投影结构化 speechAct，不提供可显示原话。只有成功模型文本才绑定 completed voice communicate ActionFact 进入 GameFrame；失败时保留沟通事实但不显示文字气泡。</span></li>
            <li><strong>体素装饰</strong><span>把已有建筑、动作、天气和身体事实映射成画面，不写回世界。</span></li>
          </ul>
          <code>domain/civilization-index.ts · projection/ · voxelKits.ts</code>
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
                <article class="logic-node" data-kind="condition"><span>P1</span><h4>本刻度需要重新审视吗？</h4><ul><li>没有当前意图，或有待回应 / 待履约协议；有效生殖窗口可继续或撤回，但同一伴侣对当月完成一次尝试后不再重复采样。</li><li>共同生活协议只在剩余期限已不足以补齐 12 个生活月时形成返回义务；目标是双方共知的固定生活区，不是同伴实时位置。</li><li>tick 1：健康 &lt;35，水分 / 营养 &lt;28，或冷热 / 伤病 ≥2 级。</li><li>状态目标已过期；或距上次进展 ≥2 个月且目标未满足。</li><li>另行探测：月初生活复核、真实 preview 确认匹配项目缺口的记录、技术示范请求、需回应的真实对话，以及本人在一次玩家建议回复中已经选定、等待本地重验的合法方向。</li><li>完整的可选重规划每人每月最多一次；15 个行动刻度仍全部执行。只有真实记录机会、紧急生存、履约、技术示范或本月新收到且已在只读 overlay 中可解析的 required proposal / 对话，才能在后续刻度再次唤醒；required response 始终优先。</li></ul></article>
                <ol>
                  <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="terminal"><span>CONTINUE</span><h4>不重新决策</h4><p>直接编译当前长期意图。</p></article></li>
                  <li><span class="edge-label edge-yes">是</span>
                    <article class="logic-node" data-kind="process"><span>P2</span><h4>在只读快照中编译候选</h4><p>输入只有可见格 / 人 / 动物 / 掉落物、本人记忆与知识、项目、协议、权限和当前意图。记录使用只检查本人拥有的活跃项目及真实技术缺口，载体来源限于本人背包与调用方已过滤的可见公共地面掉落物；不读他人背包、知识或意图，也不进入通用对话 follow-up。预览搜索路线和物流步骤不会打开真实 campaign 或改写项目；年龄门禁在每次编译时执行。相同结构失败 basis 在失败月起 0–6 月冷却，第 7 月恢复；新来源或目标、数量、人物、项目、记录、关系改变立即重开，required / fulfillment 绕过，旧自由文本无法还原 basis 时 fail-open。相似的可选社交不按固定月份删除，而在后续认知 appraisal 中评估重复成本。</p></article>
                    <ol>
                      <li><span class="edge-label">候选已生成</span>
                <article class="logic-node score-node" data-kind="process"><span>CAUSAL BDI</span><h4>动态需要、个人经验与意图持续</h4><ul><li><b>硬优先级先行</b>：可感知的紧急休眠先于 required response，required response 又先于 fulfillment；若当前已经在执行回应或履约，新义务保留排队，不无条件打断。</li><li><b>NeedAgenda</b>：从当前身体、安全、照护、储备、能力、承诺、归属、自主与探究压力派生有界欲望，不把文明指数当奖励。</li><li><b>人格门控</b>：HEXACO 分别调节注意、风险、坚持、探索、社会接近与伤害抑制；不生成候选，也不绕过硬合法性。</li><li><b>个人经验</b>：同语义 ActionFact 的 Beta 后验给出成功预期、不确定度、努力与伤害；结构化情节记忆在社会行动中优先匹配同一目标人物，无位移 move 不学习。</li><li><b>候选 appraisal</b>：需要用概率并集，经验、人格、关系、重复、伦理、可行性和连续性用有语义的乘法门控；不再把九个任意量纲直接相加。稳定种子只以万分之一破真正同分。</li><li><b>BDI intention</b>：当前 Intent 是唯一执行焦点；普通候选不重抽，只有到期、急性需要、持续停滞或明显更强的不同方案才替换。项目 / HTN 编译下一步，领域层最终重验。</li><li><b>诊断兼容</b>：旧 factor forest 只把 need、care、commitment、learning、relationship、social-repetition、consent、feasibility、harm 投影成理由与来源，不再拥有排序权。</li><li><b>可选模型重选</b>：实时模型只看合法候选和同一只读 cognition 投影，只能引用输入 ID；开局、危险和既定履约不进入重选，返回后仍再次校验 option、follow-up 与结构化立场。</li></ul></article>
                        <ol>
                          <li><span class="edge-label">检查意图</span>
                            <article class="logic-node" data-kind="condition"><span>P3</span><h4>已有当前意图？</h4><p>每人只有一个执行焦点；中断会保存可返回的父意图。</p></article>
                            <ol>
                              <li><span class="edge-label edge-no">没有</span>
                                <article class="logic-node" data-kind="condition"><span>P4-A</span><h4>有候选跨过本人的 aspiration？</h4><p>选择 motivation ≥ aspiration 的最高候选。结构化提议、预测和教学不强配后续动作；只有生活对话与后续行动共享人物、项目或来源事实时才组合。</p></article>
                                <ol>
                                  <li><span class="edge-label edge-yes">有</span><article class="logic-node compact-node" data-kind="action"><span>START</span><h4>创建新意图</h4><p>记录选项、目标与来源事实。</p></article></li>
                                  <li><span class="edge-label edge-no">没有</span><article class="logic-node compact-node" data-kind="terminal"><span>IDLE</span><h4>保持空闲</h4><p>无合法候选，或所有候选都没有跨过本人当前行动阈值。</p></article></li>
                                </ol>
                              </li>
                              <li><span class="edge-label edge-yes">已有</span>
                                <article class="logic-node interrupt-node" data-kind="condition"><span>P4-B</span><h4>挑战者足以越过意图持续门槛？</h4><ol><li><b>优先义务</b>：紧急休眠、必须回应与履约在普通 BDI 竞争前处理；已经开始的优先义务先完成，新义务随后保留。</li><li><b>子中断</b>：回应、履约、生活复核或记录使用只有在父项目 / 返回上下文存在时保存可返回父意图。</li><li><b>生活复核</b>：具体关系候选先满足生活压力 ≥ 项目压力 +10，随后仍须成为跨过 aspiration 的挑战者。</li><li><b>意图惯性</b>：同项目最佳步骤直接继续；否则比较进度、尽责性、项目压力、成功后验、停滞和切换边际。</li><li><b>替换证据</b>：期限已过、急性身体 / 安全 / 照护需要、持续停滞，或不同挑战者明显强于当前承诺。</li></ol></article>
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
                  <li><span class="edge-label edge-yes">是</span><article class="logic-node" data-kind="process"><span>C2-A</span><h4>生成直接动作</h4><p>从 move / transfer / act / attend / communicate 中选择一步；act 再指定物质操作。地面记录来源依冻结 basis 逐步执行 move → exact transfer-to-self（acquire）→ own-inventory attend（read）→ 同一项目真实 act（experiment）；外部 exact-lineage 交付或既有已读只允许依当前真实状态继续，不补动作历史。</p></article></li>
                  <li><span class="edge-label edge-no">缺来源或方法</span>
                    <article class="logic-node" data-kind="condition"><span>C2-B</span><h4>本人有可用证据？</h4><ul><li>看见不等于可用：便携物必须在本人背包或当前可取得的掉落物中；设施必须真实放入世界且记忆位置仍可核对。</li><li>可见或有来源记忆的材料地点 → 生成路线 / 取材。</li><li>固定场地合金项目可向眼前有材料的人发追加式请求；贡献转移精确引用请求，并按请求余量和实时缺口截量。</li><li>水力机械只接受本人 attend 过的具体可用水流段；计划冻结源与直线工地，未知部件仍走盲试。首次试运转的 progressed 错位故障保留输入，故障后新轴 + BronzeTool 维修，再有真实 Seed → Food 作业才完成；失流或 basis / 工地不一致先拒绝。</li><li>未知来源 → 只在有限可见范围内搜索。</li><li>未知方法 → 用眼前材料做预算受限的假说试验。</li><li>已有完整物理链的定居耕作不进入通用假说：缺种时寻找真实种源，地块等待湿润或生长时暂不行动。</li></ul></article>
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
        <article><strong>月度主循环</strong><code>application/simulation/month-boundary.ts · tick-planner.ts · tick-executor.ts</code><span>固定 atMonth、15 tick、执行顺序、月初 / 月末结算与文明终局判定</span></article>
        <article><strong>人物选项</strong><code>application/action-options.ts</code><span>局部感知、合法可供性与结构化失败重试 basis</span></article>
        <article><strong>因果 BDI</strong><code>application/cognition/** · domain/cognition.ts</code><span>动态需要、人格 / 记忆 / 结果后验门控与意图持续</span></article>
        <article><strong>人格学习</strong><code>domain/personality.ts</code><span>HEXACO 初始化、行动证据、跨情境整合与慢速变化</span></article>
        <article><strong>人物 Soul</strong><code>domain/person-soul.ts · server/persona-context.ts</code><span>baseline 人格到稳定 styleMatrix / scene facets，以及按处境、话题和听者选择的只读 personaFrame 与记忆包</span></article>
        <article><strong>生命周期</strong><code>domain/life-stage.ts · application/age-planning.ts</code><span>年龄门禁、受限劳动与婴儿移动归属</span></article>
        <article><strong>纪元预言</strong><code>domain/era-prediction.ts</code><span>历史估计、可信听众与休眠唤醒边界</span></article>
        <article><strong>人口承载</strong><code>domain/population-capacity.ts</code><span>受孕概率衰减与超载资源竞争</span></article>
        <article><strong>本地排序</strong><code>application/rule-planner.ts · application/cognition/bdi-deliberation.ts</code><span>硬优先级、aspiration、意图持续与继续 / 中断 / 改计划</span></article>
        <article><strong>模型重选</strong><code>server/backend-decider.ts · model-decision-gateway.ts</code><span>关键上下文筛选、协议请求、候选 ID 归一化与失败回退</span></article>
        <article><strong>人物主动对话</strong><code>server/agent-interaction-gateway.ts · server/persona-context.ts · application/player-interaction-choice.ts · PersonConversation.tsx</code><span>可见回复与隐藏意图两阶段、情境人格帧、定向记忆、表达能力、来源约束事实与本地合法 choice</span></article>
        <article><strong>实时台词</strong><code>projection/live-speech.ts · server/live-speech-service.ts</code><span>结构化 speechAct 草稿、共用 Soul、关系姿态帧与 speech-only 批处理；中性日常为默认，直接表达无需礼貌词，强硬取决于当前话语行为，敌意必须有冲突证据</span></article>
        <article><strong>后代取名</strong><code>naming.ts · server/newborn-naming-service.ts</code><span>确定性保底姓名、父母与处境提名上下文、本地 givenName 验收、出生事实来源与失败回退</span></article>
        <article><strong>共同生活</strong><code>domain/shared-living.ts · domain/agreement.ts · application/social-options.ts</code><span>稳定生活锚点、12 / 24 月履约窗口、独立行动和不追踪成员实时位置</span></article>
        <article><strong>持续项目</strong><code>application/project-options.ts · application/local-material-evidence.ts · domain/project-material-request.ts</code><span>压力、能力证据、局部去重、材料请求、物流、试验、协作与完成</span></article>
        <article><strong>水流机械链</strong><code>domain/mechanical-power.ts · application/mechanical-power-options.ts · domain/action-executor.ts</code><span>显式有向水流、本人观察、冻结工地、严格拓扑、commissioning 故障、来源绑定维修与维修后运行</span></article>
        <article><strong>耐久记录</strong><code>application/record-use-options.ts · domain/action-executor.ts · server/evolution-artifacts.ts</code><span>写入发布、载体守恒、读者自有项目、精确来源复用与严格完整链审计</span></article>
        <article><strong>动作裁决</strong><code>domain/action-executor.ts</code><span>五种原子动作与九种物质操作的后果</span></article>
        <article><strong>自然过程</strong><code>domain/monthly-processes.ts</code><span>纪元、天气、生态、身体、出生与死亡</span></article>
        <article><strong>观察器</strong><code>domain/civilization-index.ts</code><span>文明指数只读投影与阶段门槛</span></article>
        <article><strong>表现层</strong><code>src/game/voxelKits.ts</code><span>把权威状态映射成人间体素装饰</span></article>
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
  const initialDocsHash = window.location.hash.startsWith('#doc-');
  const initialRulesHash = /^#(?:rule|architectureAtlas|decisionTree|authorityBoundary)/.test(window.location.hash);
  selectPage(initialRecipeHash || initialRecipesPage ? 'recipes' : initialDocsHash ? 'docs' : initialRulesHash ? 'rules' : 'assets');
  if (initialAssetHash) requestAnimationFrame(() => selectAsset(window.location.hash.slice(7)));
  if (initialRecipeHash) requestAnimationFrame(() => recipeLibrary?.selectRecipe(window.location.hash.slice(8), false));
  if (initialRulesHash) {
    markRuleNav(window.location.hash);
    requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView({ block: 'start' }));
  }
}
