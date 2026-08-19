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

    <section class="rules-section" id="ruleTree" aria-labelledby="ruleTreeTitle">
      <div class="section-heading">
        <div><span class="section-no">01</span><div><span class="section-kicker">RULE TREE</span><h2 id="ruleTreeTitle">当前游戏规则树</h2></div></div>
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
            <li><strong>时间与纪元</strong><span>恒纪元 / 乱纪元持续区段；每月天气叠加在纪元之上。</span></li>
            <li><strong>空间与物质</strong><span>84 × 52 × 12 体素、通行、可达位置、掉落物和材料响应。</span></li>
            <li><strong>身体与人口</strong><span>健康、水分、营养、冷热、伤病、衰老、妊娠、9–15 个月产后恢复、出生与死亡；人口接近 50 时受孕机会递减，超过承载能力后资源消耗继续上升。</span></li>
            <li><strong>文明终局</strong><span>月末无存活者，或所有存活者均处于脱水休眠时立即结束；全员休眠的毁灭原因记录为“全员脱水”，不伪造人物死亡。</span></li>
            <li><strong>生态</strong><span>植物生长、动物迁移 / 捕猎 / 繁殖，以及风暴、干旱、冰雪和火。</span></li>
          </ul>
          <code>domain/monthly-processes.ts · world/grid.ts</code>
        </details>

        <details class="rule-branch" data-tone="agent" open>
          <summary><span>人物事实</span><small>规划器只能读取本人可获得的信息</small></summary>
          <ul>
            <li><strong>局部感知</strong><span>可见格、可见人物 / 动物 / 掉落物，以及真实可达性。</span></li>
            <li><strong>记忆与知识</strong><span>近期事件、有来源的已知地点、技术置信度、关系和失败经验；成年人只有在历史估计进入未来六个月窗口后才会形成纪元预言，不能读取隐藏调度或发布几年后的远期预言。</span></li>
            <li><strong>年龄与能力</strong><span>未满 1 岁依赖亲代；1–11 岁可自主跟随、取水、拾取、学习和简单劳动，但普通移动不得逐格漂出当前可见亲代的本地照护半径，严重压力时只可走向当前可见亲代；12–15 岁可生产及协作既有项目；16 岁起才有完整规划能力。</span></li>
            <li><strong>身体、身份与人格</strong><span>身体储备、状态限制、HEXACO 六维、控制 / 地位敏感度、亲缘认识和共同体职责；父母、子女与兄弟姐妹从 geneticParents 稳定投影，不挤占可衰减的事件记忆。经历只能通过带来源证据缓慢改变人格。baseline 人格和稳定身份还会派生跨轮一致的 Soul，可参与模型在合法候选内的个人取舍，但不创造候选或事实。</span></li>
            <li><strong>当前意图</strong><span>一个执行焦点；其他压力不会同时变成并行动作。</span></li>
          </ul>
          <code>domain/person.ts · domain/person-soul.ts · domain/memory.ts · application/action-options.ts</code>
        </details>

        <details class="rule-branch" data-tone="social" open>
          <summary><span>需要与项目</span><small>持续工作以项目为单位</small></summary>
          <ul>
            <li><strong>生存与安全</strong><span>保温、捕猎安全、照护、熟食与住所容量。</span></li>
            <li><strong>生产与储备</strong><span>工具、耕作、储藏、供水、窑炉、冶金与功能建筑；受抚养人口会提高生产和储备压力。</span></li>
            <li><strong>定居耕作</strong><span>本人计入自己的局部食物与身体压力；附近人口只可提高优先级，不再是启动资格。人物还必须感知到可用种源与可耕作地点；项目锚定局部地块，缺种先取种，等待湿润或生长时不猜无关配方，并只用本项目在该地块的六个不同播种格与两次真实收获判定完成。</span></li>
            <li><strong>知识与探索</strong><span>因真实缺口触发有限试验、验证、教学和耐久记录。</span></li>
            <li><strong>项目持久性</strong><span>触发事实、压力、场地、材料数量、物流、贡献者、进度与失败均可追溯。</span></li>
          </ul>
          <code>domain/project.ts · application/project-options.ts</code>
        </details>

        <details class="rule-branch" data-tone="effect" open>
          <summary><span>动作与后果</span><small>世界规则裁决眼前动作是否合法</small></summary>
          <ul>
            <li><strong>五种原子动作</strong><span>move · transfer · act · attend · communicate。</span></li>
            <li><strong>九种物质操作</strong><span>exert · separate · combine · expose · ingest · reproduce · hunt · dehydrate · rehydrate。</span></li>
            <li><strong>提交前预演</strong><span>检查目标、路径、材料、工具、授权、身体和空间。</span></li>
            <li><strong>客观事件</strong><span>成功或阻塞都写入 ActionFact；库存、位置和身体不可凭叙事改动。</span></li>
          </ul>
          <code>domain/action.ts · domain/action-executor.ts</code>
        </details>

        <details class="rule-branch" data-tone="agent" open>
          <summary><span>社会与学习</span><small>重复的真实协作才可能形成社会结构</small></summary>
          <ul>
            <li><strong>互动</strong><span>先民双向关系从 55 开始；同月每 5 个“双方都行动且行动后同地”的规划刻度，双向增加 trust / bond 各 1，单月最多 3。单纯同处、空闲、休眠和失败动作不计；伤害、拘束或未授权取物的双方当月不增加。结伴门槛为本人有来源的 20 / 20，生殖要求双方双向 60 / 60。</span></li>
            <li><strong>承诺</strong><span>提议必须回应；生效协议要通过后续行动履约。生殖接受形成最长四个月的可撤回窗口，同一伴侣对每月最多一次真实尝试；每次动作精确绑定协议并重验 60 / 60，未受孕继续窗口，受孕、撤回、关系失效或到期才结清。</span></li>
            <li><strong>再次开口</strong><span>没有固定两月冷却：可选社交仍生成候选，再由人物自己的记忆评估同受众、同主题是否有新事实。无新证据且上次未回应 / 拒绝 / 保留会降权；新事实，或与求助 / 照护 / 困境直接相关的显著生存危险，可提高再次开口价值。协议幂等、每人一次回应、同一事实 basis 与开场回应去重仍是硬门禁。</span></li>
            <li><strong>传播</strong><span>观察到的成功可复查、教导、模仿或写入实体记录。</span></li>
            <li><strong>制度</strong><span>多人项目、重复角色、授权与分配闭环改变未来行为时才成立。</span></li>
          </ul>
          <code>application/social-options.ts · domain/social-repetition.ts · domain/agreement.ts · domain/governance.ts</code>
        </details>

        <details class="rule-branch observer-branch" data-tone="observer" open>
          <summary><span>观察与表现</span><small>只读，不参与人物选择</small></summary>
          <ul>
            <li><strong>文明指数</strong><span>人口、疆域 / 设施、科技、社会与历史的事后投影。</span></li>
            <li><strong>能力里程碑</strong><span>从事件证据链识别实践、阶段与复杂性，不向人物发奖励。</span></li>
            <li><strong>事实报告</strong><span>运行摘要、转折点、毁灭原因和文明编号都来自真实历史。</span></li>
            <li><strong>口头台词</strong><span>主动对话、决策 utterance 与 speech-only 共用人物 Soul 保持同一声音；规则动作只投影结构化 speechAct，不提供可显示原话。只有成功模型文本才绑定 completed voice communicate ActionFact 进入 GameFrame；失败时保留沟通事实但不显示文字气泡。</span></li>
            <li><strong>体素装饰</strong><span>把已有建筑、动作、天气和身体事实映射成画面，不写回世界。</span></li>
          </ul>
          <code>domain/civilization-index.ts · projection/ · voxelKits.ts</code>
        </details>
      </div>
    </section>

    <section class="rules-section" id="decisionTree" aria-labelledby="decisionTreeTitle">
      <div class="section-heading">
        <div><span class="section-no">02</span><div><span class="section-kicker">DECISION TREE</span><h2 id="decisionTreeTitle">每个规划刻度，人物怎样决定</h2></div></div>
        <p>决定不是一次性抽签。稳定意图默认延续；只有紧急反射、必须回应、履约、真实的新机会、客观停滞，或人物在自然对话中亲自选定的合法方向能改变焦点。界面不区分聊天与建议：每句话都可能影响下一步，但纯问题不得生成行动。人物在同一次回复中作选择，下一月只做本地重验，不再由第二轮模型重新猜自由文本。</p>
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
          <header><span>01 · EXECUTION GATE</span><h3 id="gateTreeTitle">先处理不可推迟的身体与照护事实</h3><p>每月先推进世界，然后运行 15 个规划刻度。每个刻度中，存活人物按种子确定的稳定顺序读取刚刚提交过的世界。</p></header>
          <div class="decision-tree-scroll">
            <ol class="logic-tree">
              <li>
                <article class="logic-node" data-kind="process"><span>MONTH START</span><h4>推进月初世界</h4><p>纪元 / 天气 → 预言结算 → 自然过程 → 协议与授权 → 记忆维护。</p></article>
                <ol>
                  <li><span class="edge-label">planning tick × 15</span>
                    <article class="logic-node" data-kind="condition"><span>G1</span><h4>人物仍存活？</h4><p>参与者列表只保留活人；刻度内再次检查。</p></article>
                    <ol>
                      <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="terminal"><span>EXIT</span><h4>跳过本刻度</h4><p>不产生人物动作。</p></article></li>
                      <li><span class="edge-label edge-yes">是</span>
                        <article class="logic-node" data-kind="condition"><span>G2</span><h4>处于脱水休眠？</h4><p><code>dehydrated-hibernation</code> 禁止普通行动。重新水化需近身水源与身体危机、预言失效 / 已应验或有来源的预言质疑；同一待验证计划不能被无新证据反复唤醒。月末若所有存活者都处于休眠，文明立即以“全员脱水”结束。</p></article>
                        <ol>
                          <li><span class="edge-label edge-yes">是</span><article class="logic-node compact-node" data-kind="terminal"><span>HOLD</span><h4>维持低代谢与原位置</h4><p>本人不行动，也不会随亲代移动；每月仍消耗 0.35 水分、0.30 营养和 0.25 健康。认可待验证预言者不会提前唤醒；质疑者只能尝试一次，预言结算再改变双方关系。</p></article></li>
                          <li><span class="edge-label edge-no">否</span>
                            <article class="logic-node" data-kind="condition"><span>G3</span><h4>本人或依赖者谁更紧急？</h4><ul><li>本人：水分 &lt;58、有食物且营养 &lt;52、无食物且营养 &lt;34，或已有冷热压力。</li><li>1–11 岁本人若水分 &lt;32、营养 &lt;34、健康 &lt;45 或已有冷热状态，会把当前可见亲代作为有 `caregiverRef` 的局部会合目标，不读取视野外位置。</li><li>依赖者：视野内、12 岁以下的亲生子女，比较缺水、缺食、健康与冷热压力；不读取视野外身体。</li><li>两边先换算到同一紧急度尺度；孩子危机更重且存在可执行帮助时优先照护，而非固定本人在前。</li><li>未满 1 岁的清醒婴儿不会独自迁移，同处亲代移动时会被携带；脱水休眠者始终留在原位。</li></ul></article>
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
                <article class="logic-node" data-kind="condition"><span>P1</span><h4>本刻度需要重新审视吗？</h4><ul><li>没有当前意图，或有待回应 / 待履约协议；有效生殖窗口可继续或撤回，但同一伴侣对当月完成一次尝试后不再重复采样。</li><li>tick 1：健康 &lt;35，水分 / 营养 &lt;28，或冷热 / 伤病 ≥2 级。</li><li>状态目标已过期；或距上次进展 ≥2 个月且目标未满足。</li><li>另行探测：月初生活复核、匹配项目缺口的记录、技术示范请求、需回应的真实对话，以及本人在一次玩家建议回复中已经选定、等待本地重验的合法方向。</li><li>完整的可选重规划每人每月最多一次；15 个行动刻度仍全部执行，紧急生存、履约、技术示范和新收到的真实对话可在后续刻度继续即时打断。</li></ul></article>
                <ol>
                  <li><span class="edge-label edge-no">否</span><article class="logic-node compact-node" data-kind="terminal"><span>CONTINUE</span><h4>不重新决策</h4><p>直接编译当前长期意图。</p></article></li>
                  <li><span class="edge-label edge-yes">是</span>
                    <article class="logic-node" data-kind="process"><span>P2</span><h4>在只读快照中编译候选</h4><p>输入只有可见格 / 人 / 动物 / 掉落物、本人记忆与知识、项目、协议、权限和当前意图。预览搜索路线和物流步骤不会打开真实 campaign 或改写项目；年龄门禁在每次编译时执行。相似的可选社交不再按固定月份删除，而在后续因果树中评估重复成本；若存在必须回应，候选集会收窄为这些回应。</p></article>
                    <ol>
                      <li><span class="edge-label">候选已排序</span>
                <article class="logic-node score-node" data-kind="process"><span>FACTOR FOREST</span><h4>九棵可解释因果树投票</h4><ul><li><b>need</b>：身体、物资与住所缺口；<b>care</b>：眼前他人的危险与照护关系。</li><li><b>commitment</b>：既有项目连续性与项目压力；<b>learning</b>：观察、记录和技术缺口。</li><li><b>relationship</b>：有来源的信任、羁绊、恐惧和社会接近；<b>social-repetition</b>：本人记忆中的同受众同主题沟通、新证据、上次结果与再次开口成本。</li><li><b>consent</b>：具体协议的接受 / 拒绝 / 撤回、已学得风险、产后恢复和已有子女责任；<b>feasibility</b>：来源、耗时和风险。</li><li><b>harm</b>：伤害是否有足够生存压力；每棵树保留理由与来源事实。</li><li><b>HEXACO 调节</b>：H 调节占取与强制，E 调节照护与避险，X 调节主动社交，A 调节合作与冲突，C 调节项目持续和后果权衡，O 调节探究；人格不能生成候选或绕过合法性。</li><li>自愿行动先生成带来源的人格证据；至少跨 3 个月和 2 个情境后，月末才可能变化 1 点。滚动一年每维最多 2 点，累计偏移限于 ±20。</li><li>必须回应 / 履约先由门禁处理；小于 1 分的稳定种子值只破同分，不能制造动机。</li><li><b>可选模型重选</b>：只有设置页启用模型演进时，实时会话才把真有选择空间的上下文交给模型；可选社交附带与本地因子树同源的重复成本、新证据和上次结果，但仍是软权衡而非合法性门禁。必须回应需有 ≥2 个合法 required option，或唯一 required option 有 ≥2 个语义匹配的 follow-up；生活对话、空闲新方向、停滞或复核也需多个合法方向。开局、危险和履约不进入重选；返回结果还要再次校验 option、follow-up 与结构化立场。单一固定回应和其他无需选择的说话仍由规则正常提交。</li></ul></article>
                        <ol>
                          <li><span class="edge-label">检查意图</span>
                            <article class="logic-node" data-kind="condition"><span>P3</span><h4>已有当前意图？</h4><p>每人只有一个执行焦点；中断会保存可返回的父意图。</p></article>
                            <ol>
                              <li><span class="edge-label edge-no">没有</span>
                                <article class="logic-node" data-kind="condition"><span>P4-A</span><h4>存在因果总票为正的合法候选？</h4><p>结构化提议、预测和教学不强配后续动作；只有生活对话与后续行动共享人物、项目或来源事实时才组合。</p></article>
                                <ol>
                                  <li><span class="edge-label edge-yes">有</span><article class="logic-node compact-node" data-kind="action"><span>START</span><h4>创建新意图</h4><p>记录选项、目标与来源事实。</p></article></li>
                                  <li><span class="edge-label edge-no">没有</span><article class="logic-node compact-node" data-kind="terminal"><span>IDLE</span><h4>保持空闲</h4><p>无候选，或所有候选都没有正向价值。</p></article></li>
                                </ol>
                              </li>
                              <li><span class="edge-label edge-yes">已有</span>
                                <article class="logic-node interrupt-node" data-kind="condition"><span>P4-B</span><h4>是否存在足以改变焦点的证据？</h4><ol><li><b>必须回应</b>：优先本人作答。</li><li><b>履约 / 职责</b>：履行已生效承诺。</li><li><b>生活复核</b>：具体关系候选存在，且生活压力 ≥ 项目压力 +10；紧急状态不走此分支。</li><li><b>记录使用</b>：实体记录与当前项目的真实技术缺口匹配。</li><li><b>共同体延续</b>：与既有协作者重逢且有来源事实。</li><li><b>替换条件</b>：身体紧急、目标到期或恢复后的父意图仍连续 ≥2 月无进展。</li></ol></article>
                                <ol>
                                  <li><span class="edge-label edge-yes">1–4</span><article class="logic-node compact-node" data-kind="action"><span>INTERRUPT</span><h4>创建可返回的子中断</h4><p>回应、履约、生活复核、记录使用，以及生存 / 照护 / 避护完成后返回父意图。</p></article></li>
                                  <li><span class="edge-label edge-yes">5–6</span><article class="logic-node compact-node" data-kind="action"><span>REVISE</span><h4>改用当前最佳目标</h4><p>共同体机会、紧急、过期或停滞触发替换。</p></article></li>
                                  <li><span class="edge-label edge-no">都不是</span><article class="logic-node compact-node" data-kind="terminal"><span>CONTINUE</span><h4>保持原意图</h4><p>不为“有新选项”做无意义改换。</p></article></li>
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
                <article class="logic-node" data-kind="condition"><span>C1</span><h4>已选择目标的下一步可提交？</h4><p>候选阶段只做快照预览；选择后才在权威项目上检查数量缺口、AND / OR 材料需求、已知操作、固定场地、贡献者并提交搜索 / 物流状态。</p></article>
                <ol>
                  <li><span class="edge-label edge-yes">是</span><article class="logic-node" data-kind="process"><span>C2-A</span><h4>生成直接动作</h4><p>从 move / transfer / act / attend / communicate 中选择一步；act 再指定物质操作。</p></article></li>
                  <li><span class="edge-label edge-no">缺来源或方法</span>
                    <article class="logic-node" data-kind="condition"><span>C2-B</span><h4>本人有可用证据？</h4><ul><li>可见或有来源记忆的材料地点 → 生成路线 / 取材。</li><li>未知来源 → 只在有限可见范围内搜索。</li><li>未知方法 → 用眼前材料做预算受限的假说试验。</li><li>已有完整物理链的定居耕作不进入通用假说：缺种时寻找真实种源，地块等待湿润或生长时暂不行动。</li></ul></article>
                    <ol>
                      <li><span class="edge-label edge-yes">可补齐</span><article class="logic-node compact-node" data-kind="process"><span>REPAIR</span><h4>插入同目标前置步骤</h4><p>移动、取材、恢复、请求协助或有限试验。</p></article></li>
                      <li><span class="edge-label edge-no">仍不可知</span><article class="logic-node compact-node" data-kind="terminal"><span>BLOCKED</span><h4>留下明确阻塞</h4><p>不读取隐藏配方或全局地图。</p></article></li>
                    </ol>
                  </li>
                </ol>
                <ol>
                  <li><span class="edge-label">已生成动作</span>
                    <article class="logic-node" data-kind="condition"><span>C3</span><h4>提交前预演是否合法？</h4><p>检查路径、目标、数量、材料、工具、授权、身体和空间；失败时优先在同一目标内局部修复。</p></article>
                    <ol>
                      <li><span class="edge-label edge-no">否，可修复</span><article class="logic-node compact-node" data-kind="process"><span>LOOP</span><h4>重编译前置动作</h4><p>下一个可用刻度再预演。</p></article></li>
                      <li><span class="edge-label edge-no">否，不可修复</span><article class="logic-node compact-node" data-kind="terminal"><span>BLOCKED</span><h4>记录失败原因</h4><p>供项目、记忆与后续重评使用。</p></article></li>
                      <li><span class="edge-label edge-yes">是</span>
                        <article class="logic-node" data-kind="action"><span>COMMIT</span><h4>执行至多 1 个原子动作</h4><p>写入路径、消耗、产物、来源与成功 / 阻塞状态的 <code>ActionFact</code>。</p></article>
                        <ol>
                          <li><span class="edge-label">动作后</span><article class="logic-node compact-node" data-kind="terminal"><span>RETURN</span><h4>更新项目并检查中断返回</h4><p>子意图完成 / 阻塞 / 不可用时，恢复父意图的精确上下文；月末再结算身体、人口、项目、共同体与只读观察器。无存活者，或所有存活者均处于脱水休眠时，文明立即终止；后者记录为“全员脱水”。规则月提交后，完成的口头沟通先成为结构化 speechAct 草稿，只有模型成功表达才显示气泡。</p></article></li>
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
        <div><span class="section-no">03</span><div><span class="section-kicker">AUTHORITY BOUNDARY</span><h2 id="authorityBoundaryTitle">谁能改变世界，谁只能解释世界</h2></div></div>
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
        <div><span>OPTIONAL MODEL SIDECAR</span><strong>模型可以回应玩家、重选少量合法方向，并自主表达已发生的说话，但不能直接写入世界</strong><p>三条第一人称路径共用由人物 ID、baseline HEXACO 与控制 / 地位敏感度确定性重建的只读 Soul；它稳定口吻并影响行动取舍，但不提供新事实、创造候选或绕过规则。主动对话使用 agent-interaction-v2：动态状态、记忆、证据与经本地门禁筛选的合法选项只进每轮 localContext，历史携带旧选择及真实结果。界面不区分聊天与建议；同一轮模型按语义判断纯问答、犹豫、拒绝或接受，只有人物确实按 Soul 和处境定下合法 choice 时才进入行动链。choice 在同轮选定后仍要经最新状态本地重验，只有命中才产生带对话来源的 DecisionFact。</p></div>
      </aside>
    </section>

    <section class="rules-section source-section" id="ruleSources" aria-labelledby="ruleSourcesTitle">
      <div class="section-heading compact-heading">
        <div><span class="section-no">04</span><div><span class="section-kicker">SOURCE MAP</span><h2 id="ruleSourcesTitle">这张图对应哪些当前源码</h2></div></div>
        <p>解释当前行为时以可执行代码为准；设计文档用于说明边界与意图。</p>
      </div>
      <div class="source-grid">
        <article><strong>月度主循环</strong><code>application/monthly-simulation.ts</code><span>15 tick、执行顺序、月初 / 月末结算与文明终局判定</span></article>
        <article><strong>人物选项</strong><code>application/action-options.ts</code><span>局部感知与合法可供性候选</span></article>
        <article><strong>因子森林</strong><code>application/decision-factor-forest.ts · domain/social-repetition.ts</code><span>九棵可解释因果树、来源与同分裁决</span></article>
        <article><strong>人格学习</strong><code>domain/personality.ts</code><span>HEXACO 初始化、行动证据、跨情境整合与慢速变化</span></article>
        <article><strong>人物 Soul</strong><code>domain/person-soul.ts</code><span>baseline 人格与稳定身份到第一人称内在声音的确定性只读派生值</span></article>
        <article><strong>生命周期</strong><code>domain/life-stage.ts · application/age-planning.ts</code><span>年龄门禁、受限劳动与婴儿移动归属</span></article>
        <article><strong>纪元预言</strong><code>domain/era-prediction.ts</code><span>历史估计、可信听众与休眠唤醒边界</span></article>
        <article><strong>人口承载</strong><code>domain/population-capacity.ts</code><span>受孕概率衰减与超载资源竞争</span></article>
        <article><strong>本地排序</strong><code>application/rule-planner.ts</code><span>硬优先级、正向阈值、继续 / 中断 / 改计划</span></article>
        <article><strong>模型重选</strong><code>server/backend-decider.ts · model-decision-gateway.ts</code><span>关键上下文筛选、协议请求、候选 ID 归一化与失败回退</span></article>
        <article><strong>人物主动对话</strong><code>server/agent-interaction-gateway.ts · application/player-interaction-choice.ts · PersonConversation.tsx</code><span>统一自然对话、来源约束的语义事实、Soul 判断、同轮合法 choice 与结果追踪</span></article>
        <article><strong>实时台词</strong><code>projection/live-speech.ts · server/live-speech-service.ts</code><span>结构化 speechAct 草稿、共用 Soul 与动态语境、speech-only 批处理；规则不提供可见或隐藏原话模板</span></article>
        <article><strong>持续项目</strong><code>application/project-options.ts</code><span>压力、材料、物流、试验、协作与完成</span></article>
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
  const initialRulesHash = /^#(?:rule|decisionTree|authorityBoundary)/.test(window.location.hash);
  selectPage(initialRecipeHash || initialRecipesPage ? 'recipes' : initialDocsHash ? 'docs' : initialRulesHash ? 'rules' : 'assets');
  if (initialAssetHash) requestAnimationFrame(() => selectAsset(window.location.hash.slice(7)));
  if (initialRecipeHash) requestAnimationFrame(() => recipeLibrary?.selectRecipe(window.location.hash.slice(8), false));
  if (initialRulesHash) {
    markRuleNav(window.location.hash);
    requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView({ block: 'start' }));
  }
}
