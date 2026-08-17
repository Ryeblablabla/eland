import type {
  ActionFact,
  EnvironmentFact,
  MilestoneObservation,
  MilestonePhase,
  MilestoneValence,
  SimulationState,
  WorldEvent,
} from '../domain/model';
import { Material, materialHas } from '../domain/material';
import { isAlive, type PersonId } from '../domain/person';
import { cellX, cellY, neighbors4 } from '../world/grid';

export const CAPABILITY_MILESTONE_DEFINITION_VERSION = 'capability-causal-v2';

export type CapabilitySupport = 'strict' | 'guarded';
export type CapabilityCatalogKind = 'map' | 'world-specific';

export interface CapabilityStageCriteria {
  minEpisodes: number;
  minDistinctMonths: number;
  minDistinctActors: number;
  minEvidenceEvents: number;
  evidenceEpisodeLimit: number;
}

type DetectorKey =
  | 'birth' | 'conception' | 'dependent-care' | 'dependent-protection' | 'kinship' | 'illness' | 'care' | 'repeated-care'
  | 'herbal-care' | 'end-of-life-care' | 'aging' | 'death'
  | 'gather-food' | 'food-identification' | 'infant-feeding' | 'food-storage' | 'gift' | 'hunt' | 'tool-hunt' | 'migration' | 'disaster-response'
  | 'tool-craft' | 'spear-craft' | 'rope-craft' | 'container-practice' | 'fire-making'
  | 'fire-practice' | 'cooking' | 'clothing' | 'shelter' | 'settlement' | 'communication' | 'direct-communication'
  | 'gesture-communication' | 'natural-observation' | 'tested-hypothesis' | 'trial-learning'
  | 'fulfilled-assist' | 'teaching' | 'craft-teaching' | 'stable-teaching' | 'cross-generation-teaching'
  | 'collective' | 'cultivation' | 'storage'
  | 'shared-storage' | 'water-assistance' | 'famine' | 'permission' | 'permission-use' | 'road'
  | 'exchange' | 'repeated-exchange' | 'agreement' | 'agreement-rejection' | 'companion'
  | 'relationship-rejection' | 'membership-belonging' | 'membership-admission' | 'membership-rejection' | 'writing'
  | 'shared-record' | 'physical-record' | 'memory' | 'observation' | 'instrument-observation' | 'experiment'
  | 'decision-rule' | 'mandate' | 'exercised-mandate' | 'returned-mandate'
  | 'prediction' | 'correct-prediction' | 'incorrect-prediction' | 'prediction-practice'
  | 'project' | 'inquiry-project' | 'joint-project' | 'project-logistics' | 'project-breakdown' | 'project-recovery' | 'knowledge-preservation'
  | 'forest-harvest' | 'mutual-aid' | 'permission-revoked'
  | 'theft-attempt' | 'theft-success' | 'violence' | 'lethal-violence' | 'restraint' | 'release-restraint'
  | 'breach' | 'collective-withdrawal' | 'collective-collapse' | 'collective-recovery'
  | 'technique-loss' | 'technique-recovery' | 'animal-attack' | 'wildlife-knowledge'
  | 'weather' | 'era-cycle' | 'guarded';

export interface CapabilityMilestoneDefinition {
  id: string;
  catalogKind: CapabilityCatalogKind;
  capabilityId?: number;
  mapLabel?: string;
  label: string;
  domain: string;
  valence: MilestoneValence;
  phase: MilestonePhase;
  support: CapabilitySupport;
  detector: DetectorKey;
  causalConditions: readonly string[];
  stageCriteria: Readonly<CapabilityStageCriteria>;
  definitionVersion: typeof CAPABILITY_MILESTONE_DEFINITION_VERSION;
}

interface Episode {
  evidenceEventIds: string[];
  participantIds: PersonId[];
  affectedPersonIds: PersonId[];
  observedAtMonth: number;
}

interface ObserverIndex {
  byId: Map<string, WorldEvent>;
  events: WorldEvent[];
  actions: ActionFact[];
  completedActions: ActionFact[];
  environments: EnvironmentFact[];
  peopleById: Map<PersonId, SimulationState['people'][number]>;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function indexState(state: SimulationState): ObserverIndex {
  const events = state.world.past;
  const actions = events.filter((event): event is ActionFact => event.kind === 'action');
  return {
    byId: new Map(events.map((event) => [event.id, event])),
    events,
    actions,
    completedActions: actions.filter((event) => event.status === 'completed'),
    environments: events.filter((event): event is EnvironmentFact => event.kind === 'environment'),
    peopleById: new Map(state.people.map((person) => [person.id, person])),
  };
}

function episode(events: WorldEvent[], participantIds: PersonId[] = [], affectedPersonIds: PersonId[] = []): Episode | null {
  if (!events.length) return null;
  const ordered = [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((left, right) => left.atMonth - right.atMonth || left.orderInMonth - right.orderInMonth || left.id.localeCompare(right.id));
  return {
    evidenceEventIds: ordered.map((event) => event.id),
    participantIds: unique(participantIds),
    affectedPersonIds: unique(affectedPersonIds),
    observedAtMonth: ordered.at(-1)?.atMonth ?? 0,
  };
}

function eventEpisodes<T extends WorldEvent>(events: T[], participants: (event: T) => PersonId[] = () => []): Episode[] {
  return events.flatMap((event) => episode([event], participants(event)) ?? []);
}

function resolvedEvents(index: ObserverIndex, ids: string[]): WorldEvent[] {
  return unique(ids).flatMap((id) => index.byId.get(id) ?? []);
}

function actionTargetPerson(event: ActionFact): PersonId | null {
  if (event.action.kind === 'act') {
    const target = event.action.targets.find((item) => item.kind === 'person');
    return target?.kind === 'person' ? target.personId : null;
  }
  if (event.action.kind === 'attend' && event.action.target.kind === 'person') return event.action.target.personId;
  return null;
}

function transferPeople(event: ActionFact): PersonId[] {
  if (event.action.kind !== 'transfer') return [];
  return unique([
    event.who,
    ...(event.action.from.kind === 'person' ? [event.action.from.personId] : []),
    ...(event.action.to.kind === 'person' ? [event.action.to.personId] : []),
  ]);
}

function grouped<T>(items: T[], keyFor: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function materialOutput(event: ActionFact): number {
  return Number(event.diff.outputMaterialId);
}

function completedAct(index: ObserverIndex, operation?: string): ActionFact[] {
  return index.completedActions.filter((event) => event.action.kind === 'act'
    && (!operation || event.action.operation === operation));
}

function compareWorldEvents(left: WorldEvent, right: WorldEvent): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id);
}

function cellDistance(left: number, right: number): number {
  return Math.abs(cellX(left) - cellX(right)) + Math.abs(cellY(left) - cellY(right));
}

function continuousMovementChunks(events: ActionFact[], maxGapMonths: number): ActionFact[][] {
  const chunks: ActionFact[][] = [];
  for (const event of [...events].sort(compareWorldEvents)) {
    const current = chunks.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || event.atMonth - previous.atMonth > maxGapMonths) chunks.push([event]);
    else current.push(event);
  }
  return chunks;
}

function migrationResidenceAfter(
  index: ObserverIndex,
  personId: PersonId,
  arrival: ActionFact,
): ActionFact | null {
  const destination = arrival.toCellId;
  const latestResidenceMonth = arrival.atMonth + 3;
  const later = index.completedActions.filter((event) => event.who === personId
    && compareWorldEvents(event, arrival) > 0
    && event.atMonth <= latestResidenceMonth)
    .sort(compareWorldEvents);
  let cursor = 0;
  for (let residenceMonth = arrival.atMonth + 1; residenceMonth <= latestResidenceMonth; residenceMonth += 1) {
    let residenceEvent: ActionFact | null = null;
    while (cursor < later.length && (later[cursor]?.atMonth ?? Number.POSITIVE_INFINITY) <= residenceMonth) {
      const event = later[cursor];
      cursor += 1;
      if (!event) continue;
      const occupiedCells = event.action.kind === 'move' ? event.pathSegment : [event.fromCellId, event.toCellId];
      if (occupiedCells.some((cellId) => cellDistance(cellId, destination) > 2)) return null;
      if (event.atMonth === residenceMonth) residenceEvent = event;
    }
    if (residenceEvent) return residenceEvent;
  }
  return null;
}

function detectorConditions(): Record<DetectorKey, readonly string[]> {
  return {
    birth: ['月度身体结算生成 bornPersonId 与父母 ID', '新人物的 geneticParents 与出生事实一致'],
    conception: ['双方先形成有效的生殖同意约定', 'reproduce 原语完成且 conceived=true'],
    'dependent-care': ['照护者与未独立儿童存在亲子或真实照护关系', '携带、转移物资或协助脱水产生可解析动作事实'],
    'dependent-protection': ['儿童处于依赖年龄且与照护者有亲子或真实照护关系', '乱纪元危险中 completed 动作明确保存 assistedDependentId 或 carriedPersonIds'],
    kinship: ['出生事实保存父母与新生儿 ID', '人物状态保存同一 geneticParents 关系'],
    illness: ['身体结算写入 illness 条件', '条件事实保存患者与发生月份'],
    care: ['目标已有伤口或疾病来源', '材料被消耗且 caredPersonId/阶段变化被记录'],
    'repeated-care': ['同一受照护者至少有两次真实照护', '照护跨越不同月份或由不同人物完成'],
    'herbal-care': ['草药由真实生产链产生并被持有', '草药被消耗于具体伤病且身体状态改变'],
    'end-of-life-care': ['人物获得真实照护动作', '同一人物随后在有限时间内出现死亡事实'],
    aging: ['人物年龄达到衰老压力区间', '月度结算写入 aging 条件事实'],
    death: ['人物身体或寿命结算达到死亡条件', '死亡事实保存 personId、原因与来源'],
    'gather-food': ['可食物资来自地面掉落物', 'completed transfer 把同一物资交给具体人物'],
    'food-identification': ['人物先从地面取得带 edible 性质的具体物资', '同一人物随后摄入同一材料并产生身体后果'],
    'infant-feeding': ['completed transfer 把可食材料交给未独立儿童', '行动者是儿童父母或动作保存明确照护来源'],
    'food-storage': ['completed transfer 把可食材料放入实体容器', '容器与材料、数量和行动者均可由同一事实解析'],
    gift: ['物资来自赠与者自己的私人背包', 'completed transfer 把物资交给另一人且不引用交换、许可或授权'],
    hunt: ['hunt 原语指向真实动物 ID', '动作完成并记录 killed=true 与动物产物'],
    'tool-hunt': ['hunt 原语指向真实动物并引用人物持有的 toolStackId', '动作完成且保存捕猎后果与动物产物'],
    migration: ['同一人物按同一 intent/project 在合理月间隔内持续远移并跨过路径与净位移门槛', '跨门槛后至少隔月仍在目的地邻域活动，episode 证据包含该跨门槛 move'],
    'disaster-response': ['先出现乱纪元、恶劣天气或冷热身体压力', '随后出现脱水休眠、迁移、取水或避护行动'],
    'tool-craft': ['combine 使用真实输入材料', 'completed diff 产生工具类 outputMaterialId'],
    'spear-craft': ['石刃、木材和连接材料参与真实 combine 链', 'completed diff 明确产生 Spear'],
    'rope-craft': ['纤维等真实输入材料参与 combine', 'completed diff 明确产生 Rope'],
    'container-practice': ['combine 先产生带 containerId 的实体容器', '后续 transfer 对同一 containerId 完成真实存取'],
    'fire-making': ['exert 使用真实工具与燃料目标', 'completed diff 产生 Fire 体素'],
    'fire-practice': ['火种在至少两个不同月份被制造或使用', '相关动作共享火材料输入或输出'],
    cooking: ['生食与真实火体素参与 expose', 'completed diff 产生 CookedFood'],
    clothing: ['纤维或兽皮参与 combine', 'completed diff 产生衣物或兽皮衣'],
    shelter: ['多次建造动作形成有来源体素结构', '结构具有内部空间、容量和防护且标记 complete'],
    settlement: ['存在完整功能住所或多个功能据点', '存活人物持续使用相关格子或设施'],
    communication: ['communicate 保存结构化表达与发送者', '至少一名不同人物处于实际 audience'],
    'direct-communication': ['communicate 通过 voice 或 gesture 发送结构化表达', '至少一名不同人物处于实际 audience'],
    'gesture-communication': ['communicate 明确使用 gesture 渠道', '至少一名不同人物处于实际 audience'],
    'natural-observation': ['人物完成 attend 并指向动物、体素或自然掉落物', '观察事实保存人物和真实世界对象'],
    'tested-hypothesis': ['可靠技术知识引用至少一次真实物质试验', '同一知识来源还包含 understood/verified 的主动核验'],
    'trial-learning': ['可靠技术知识引用至少两次真实物质试验', '试验来源跨越阶段门槛要求的月份'],
    'fulfilled-assist': ['求助提议被目标人物接受', '后续物资或行动履行同一 agreementId'],
    teaching: ['持有者传播有来源的 technique/claim', '另一人物的知识来源包含同一沟通事实'],
    'craft-teaching': ['沟通内容引用 technique 知识 ID', '另一人物的 technique 知识来源包含同一沟通事实'],
    'stable-teaching': ['同一知识被至少两名人物持有', '来源包含跨人物教学或跨代传播事实'],
    'cross-generation-teaching': ['同一可靠技术由不同 generation 的人物持有', '知识来源包含可解析教学、试验或实体记录事实'],
    collective: ['共同体提议得到所需成员接受', 'CollectiveState 与 memberships 保存同一来源链'],
    cultivation: ['种子与肥沃地表结合生成作物', '自然生长后由 separate 产生真实收获'],
    storage: ['实体容器有体素位置与来源', 'completed transfer 把物资放入或取出同一容器'],
    'shared-storage': ['同一真实容器被操作', '至少两名不同人物完成过容器转移'],
    'water-assistance': ['饮水或找水需要形成有来源行动/求助', '人物完成取水、引路或饮水后果'],
    famine: ['身体事实记录 nutrition 进入严重伤害区', '至少两名人物在同一短时间窗内受到营养伤害'],
    permission: ['共同体成员提出具体物资许可', '所需当事人接受并生成 ResourcePermission'],
    'permission-use': ['许可仍有效且指明双方、物资和数量', 'completed transfer 通过 authorizationRef 行使许可'],
    road: ['真实动作使地表发生 PackedSoil materialChanges', '至少四个水平相邻格由可解析动作形成连续通行带'],
    exchange: ['双方接受带物资与数量条款的 exchange', '双方真实转移并使同一约定 fulfilled'],
    'repeated-exchange': ['同一双方至少完成两次交换约定', '交换发生在不同月份并有各自履约转移'],
    agreement: ['结构化 offer/request 指定双方与期限', '所需回应者明确接受并建立 active/fulfilled 约定'],
    'agreement-rejection': ['存在面向具体回应者的结构化提议', '回应者明确 reject 且 agreement 状态为 rejected'],
    companion: ['一方向具体人物提出 companion 关系', '对方接受且双方在约定期真实共同停留'],
    'relationship-rejection': ['存在 companion 或 reproduce 关系提议', '目标人物明确 reject，未形成 active 关系约定'],
    'membership-belonging': ['候选人先主动请求加入指定共同体，且请求进入同一接纳来源链', '现有成员随后提议、所需审批者接受，并生成仍 active 的 membership'],
    'membership-admission': ['active collective 的现有成员提议指定候选人和全体审批者', '候选人与所需成员接受后生成 active membership，候选人主动请求的 episode 由归属探针独占'],
    'membership-rejection': ['active collective 的成员提议指定具体候选人', '候选人或现有成员明确 reject，候选人未成为 active member'],
    writing: ['知识写入带 recordPayloadId 的实体载体', '另一人物取得并读懂同一 payload'],
    'shared-record': ['同一实体记录 payload 可解析', '至少两名不同人物写入或读懂该 payload'],
    'physical-record': ['completed record 写入为 RecordPayload 提供真实创作来源', '至少 12 个月后，当前背包、地面或容器仍存在同一 recordPayloadId 载体'],
    memory: ['人物记忆保存具体 sourceEventIds', '来源事实能解析到亲历、对话、承诺或失败事件'],
    observation: ['attend 指向真实世界对象', 'completed diff 保存理解、核验或观察后果'],
    'instrument-observation': ['attend 明确引用人物持有的 instrumentStackId', 'completed 观察事实保存仪器与对象的同一行动链'],
    experiment: ['技术来源含成功物质操作', '重复试验或主动 attend 核验提升技术可信度'],
    'decision-rule': ['共同体成员提出具体范围的 unanimous 规则', '全体现有成员接受并生成 active DecisionRule'],
    mandate: ['全体同意规则先成为 DecisionRule', '成员随后按规则接受限时 Mandate'],
    'exercised-mandate': ['限时授权保存持有人与物资范围', '成员真实贡献且协调者真实分配同一种物资'],
    'returned-mandate': ['授权曾被成员真实行使', '期限到达或成员关系结束后 mandate 转为 expired/ended'],
    prediction: ['人物向真实 audience 作出带时间窗的纪元预言', 'EraPrediction 保存预测者、目标纪元与来源'],
    'correct-prediction': ['预言先于目标纪元变化提出', '结算事实记录 correct=true 与误差月份'],
    'incorrect-prediction': ['预言先于截止月提出', '结算事实记录 correct=false 与误差月份'],
    'prediction-practice': ['同一预测者至少有两次已结算预言', '每次预言保存独立来源与正确/错误后果'],
    project: ['局部需要与触发事实生成 ProjectState', '项目保存真实行动或完成/阻塞后果'],
    'inquiry-project': ['项目 kind=inquiry 且由局部知识问题触发', '项目保存试验/记录动作与完成或失败后果'],
    'joint-project': ['项目行动由至少两名 contributor 完成', '项目 completionEventIds 闭合目标功能'],
    'project-logistics': ['项目缺料生成有边界的 search/drop episode', '动作来源被记录并使物流事件 fulfilled 或 exhausted'],
    'project-breakdown': ['项目曾有真实触发事实和行动历史', '项目转为 blocked 或物流事件 exhausted/invalidated 并保存失败来源'],
    'project-recovery': ['同一项目先出现阻塞或物流失败事实', '后续真实行动使项目完成或恢复推进'],
    'knowledge-preservation': ['知识保存项目由已有知识与中断风险触发', '实体记录被制作且项目完成'],
    'forest-harvest': ['separate 指向真实木材、树叶或植物体素', 'completed diff 记录来源材料与取得物'],
    'mutual-aid': ['至少两项 assist agreement 被真实履行', '援助涉及重复人物网络或不同月份'],
    'permission-revoked': ['许可先由共同体约定形成并可被行使', '授权者 communicate revoke 后 permission 状态为 revoked'],
    'theft-attempt': ['person→person 转移未经授权', '动作 blocked 且 attempted=true/resistedBy，物资未转手'],
    'theft-success': ['person→person 转移未经授权', '动作 completed 且 authorized=false，保存来源、去向、物资与数量'],
    violence: ['exert 指向不同人物', 'completed diff 保存 victimId、正伤害与伤口来源'],
    'lethal-violence': ['人际施力产生同一受害者的伤口来源', '死亡 sourceEventIds 追溯到该施力事实；不推断主观故意'],
    restraint: ['绳作为真实库存材料被消耗', 'completed diff 与 restrained 条件保存同一人物和来源'],
    'release-restraint': ['目标先有带来源 restrained 条件', 'separate 完成并保存 releasedPersonId/sourceConditionId'],
    breach: ['约定已被所需回应者接受并进入 active', '超期未履行后显式产生 agreement:breached；只保留提议、接受和违约结果证据'],
    'collective-withdrawal': ['人物先拥有 active membership', '本人 communicate withdraw 并使 membership 状态变为 withdrawn'],
    'collective-collapse': ['共同体曾有至少两名真实成员', '主动退出链使状态转为 dormant/dissolved；单纯死亡另记衰退'],
    'collective-recovery': ['共同体或其前身先经历成员退出/休眠', '随后新成员接受加入并恢复 active 规模'],
    'technique-loss': ['历史上至少一名人物持有已核验技术且每名持有者均有死亡事实', '最后持有者死亡后无活着可靠持有者且无同 payload 的实体记录载体'],
    'technique-recovery': ['技术曾出现失传窗口或知识保存项目阻塞', '后续试验/教学再次产生活着的可靠持有者'],
    'animal-attack': ['环境事实保存 attack-human 与真实 victimId', 'damage 为正且受害者伤口来源包含该事实'],
    'wildlife-knowledge': ['人物 attend 或 hunt 指向真实 animalId', '同一物种在跨月行动中被再次观察或利用'],
    weather: ['环境结算生成结构化 weather/climate 事实', '事实保存种类、强度或纪元序号'],
    'era-cycle': ['至少两次 eraTransition 事实可解析', '恒纪元与乱纪元均在历史中真实出现'],
    guarded: ['当前结构化事实不足以证明完整语义', '观察器仅保留防误报定义，不产生 achieved 结果'],
  };
}

const CONDITIONS = detectorConditions();

function detect(key: DetectorKey, state: SimulationState, index: ObserverIndex): Episode[] {
  const completed = index.completedActions;
  const environments = index.environments;
  const actionEvents = (predicate: (event: ActionFact) => boolean) => eventEpisodes(completed.filter(predicate), (event) => event.kind === 'action' ? [event.who] : []);
  switch (key) {
    case 'birth': {
      return environments.flatMap((event) => {
        const childId = typeof event.diff.bornPersonId === 'string' ? event.diff.bornPersonId : null;
        const parents = strings(event.diff.parents);
        const child = childId ? index.peopleById.get(childId) : undefined;
        return child && parents.length >= 2 && parents.every((id) => child.geneticParents.includes(id))
          ? episode([event], parents, [child.id]) ?? [] : [];
      });
    }
    case 'conception':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'reproduce' && event.diff.conceived === true);
    case 'dependent-care': {
      const events = completed.filter((event) => {
        const caredId = typeof event.diff.assistedDependentId === 'string' ? event.diff.assistedDependentId
          : event.action.kind === 'transfer' && event.action.to.kind === 'person' ? event.action.to.personId
            : null;
        const child = caredId ? index.peopleById.get(caredId) : undefined;
        return Boolean(child && event.atMonth - child.bornAtMonth < 12 * 12
          && (child.geneticParents.includes(event.who) || typeof event.diff.assistedDependentId === 'string'));
      });
      return events.flatMap((event) => {
        const affected = typeof event.diff.assistedDependentId === 'string' ? event.diff.assistedDependentId
          : event.action.kind === 'transfer' && event.action.to.kind === 'person' ? event.action.to.personId : event.who;
        return episode([event], [event.who], [affected]) ?? [];
      });
    }
    case 'dependent-protection':
      return completed.flatMap((event) => {
        const assistedId = typeof event.diff.assistedDependentId === 'string' ? event.diff.assistedDependentId : null;
        const carriedIds = strings(event.diff.carriedPersonIds);
        const dependentIds = unique([...(assistedId ? [assistedId] : []), ...carriedIds]).filter((personId) => {
          const child = index.peopleById.get(personId);
          return Boolean(child && event.atMonth - child.bornAtMonth < 12 * 12
            && (child.geneticParents.includes(event.who) || assistedId === personId));
        });
        return dependentIds.length ? episode([event], [event.who], dependentIds) ?? [] : [];
      });
    case 'kinship':
      return detect('birth', state, index);
    case 'illness':
      return eventEpisodes(environments.filter((event) => event.change === 'condition' && event.diff.condition === 'illness' && event.diff.exited !== true), (event) => event.who ? [event.who] : []);
    case 'care':
      return completed.flatMap((event) => typeof event.diff.caredPersonId === 'string'
        ? episode([event], [event.who], [event.diff.caredPersonId]) ?? [] : []);
    case 'repeated-care': {
      const careEvents = completed.filter((event) => typeof event.diff.caredPersonId === 'string');
      return [...grouped(careEvents, (event) => String(event.diff.caredPersonId)).entries()].flatMap(([personId, events]) => {
        const months = new Set(events.map((event) => event.atMonth));
        const carers = new Set(events.map((event) => event.who));
        return events.length >= 2 && (months.size >= 2 || carers.size >= 2)
          ? episode(events, [...carers], [personId]) ?? [] : [];
      });
    }
    case 'herbal-care':
      return completed.flatMap((event) => Number(event.diff.careMaterialId) === Material.HerbalMedicine && typeof event.diff.caredPersonId === 'string'
        ? episode([event], [event.who], [event.diff.caredPersonId]) ?? [] : []);
    case 'end-of-life-care': {
      const deaths = environments.filter((event) => event.change === 'death' && typeof event.diff.personId === 'string');
      const careEvents = completed.filter((event) => typeof event.diff.caredPersonId === 'string');
      return deaths.flatMap((death) => {
        const personId = String(death.diff.personId);
        const recent = careEvents.filter((event) => event.diff.caredPersonId === personId && event.atMonth <= death.atMonth && death.atMonth - event.atMonth <= 12);
        return recent.length ? episode([...recent, death], recent.map((event) => event.who), [personId]) ?? [] : [];
      });
    }
    case 'aging':
      return eventEpisodes(environments.filter((event) => event.change === 'condition' && event.diff.condition === 'aging'), (event) => event.who ? [event.who] : []);
    case 'death':
      return eventEpisodes(environments.filter((event) => event.change === 'death' && typeof event.diff.personId === 'string'), (event) => typeof event.diff.personId === 'string' ? [event.diff.personId] : []);
    case 'gather-food':
      return actionEvents((event) => event.action.kind === 'transfer' && event.action.from.kind === 'ground'
        && event.status === 'completed' && materialHas(event.action.materialId, 'edible'));
    case 'food-identification': {
      const gathered = completed.filter((event) => event.action.kind === 'transfer' && event.action.from.kind === 'ground'
        && event.action.to.kind === 'person' && materialHas(event.action.materialId, 'edible'));
      const ingested = completed.filter((event) => event.action.kind === 'act' && event.action.operation === 'ingest'
        && materialHas(Number(event.diff.materialId), 'edible'));
      return gathered.flatMap((start) => {
        if (start.action.kind !== 'transfer' || start.action.to.kind !== 'person') return [];
        const eaterId = start.action.to.personId;
        const materialId = start.action.materialId;
        const end = ingested.find((event) => event.who === eaterId
          && Number(event.diff.materialId) === materialId && event.atMonth >= start.atMonth);
        return end ? episode([start, end], unique([start.who, end.who]), [end.who]) ?? [] : [];
      });
    }
    case 'infant-feeding':
      return completed.flatMap((event) => {
        if (event.action.kind !== 'transfer' || event.action.to.kind !== 'person'
          || !materialHas(event.action.materialId, 'edible')) return [];
        const child = index.peopleById.get(event.action.to.personId);
        if (!child || event.atMonth - child.bornAtMonth >= 12 * 12
          || (!child.geneticParents.includes(event.who) && event.diff.assistedDependentId !== child.id)) return [];
        return episode([event], [event.who], [child.id]) ?? [];
      });
    case 'food-storage':
      return completed.flatMap((event) => event.action.kind === 'transfer'
        && event.action.to.kind === 'container' && materialHas(event.action.materialId, 'edible')
        ? episode([event], transferPeople(event)) ?? [] : []);
    case 'gift':
      return completed.flatMap((event) => event.action.kind === 'transfer'
        && event.action.from.kind === 'person' && event.action.from.personId === event.who
        && event.action.to.kind === 'person' && event.action.to.personId !== event.who
        && !event.action.authorizationRef && event.diff.authorized === true
        ? episode([event], transferPeople(event), [event.action.to.personId]) ?? [] : []);
    case 'hunt':
      return completed.flatMap((event) => event.action.kind === 'act' && event.action.operation === 'hunt'
        && event.diff.killed === true && typeof event.diff.animalId === 'string'
        ? episode([event], [event.who], []) ?? [] : []);
    case 'tool-hunt':
      return completed.flatMap((event) => event.action.kind === 'act' && event.action.operation === 'hunt'
        && typeof event.action.toolStackId === 'string' && event.diff.killed === true && typeof event.diff.animalId === 'string'
        ? episode([event], [event.who]) ?? [] : []);
    case 'migration': {
      const moves = completed.filter((event) => event.action.kind === 'move' && event.pathSegment.length > 1);
      const intentsById = new Map(state.intents.map((intent) => [intent.id, intent]));
      return [...grouped(moves, (event) => {
        if (!event.intentId) return null;
        const projectId = intentsById.get(event.intentId)?.projectId;
        return `${event.who}|${projectId ? `project:${projectId}` : `intent:${event.intentId}`}`;
      }).values()].flatMap((sameBasisMoves) => continuousMovementChunks(sameBasisMoves, 2).flatMap((chunk) => {
        const first = chunk[0];
        if (!first) return [];
        const cells = new Set<number>();
        const months = new Set<number>();
        for (let indexInChunk = 0; indexInChunk < chunk.length; indexInChunk += 1) {
          const move = chunk[indexInChunk];
          if (!move) continue;
          move.pathSegment.forEach((cellId) => cells.add(cellId));
          months.add(move.atMonth);
          const crossedThreshold = indexInChunk + 1 >= 3
            && cells.size >= 12
            && months.size >= 2
            && cellDistance(first.fromCellId, move.toCellId) >= 10;
          if (!crossedThreshold) continue;
          const residence = migrationResidenceAfter(index, move.who, move);
          if (!residence) continue;
          return episode([...chunk.slice(0, indexInChunk + 1), residence], [move.who]) ?? [];
        }
        return [];
      }));
    }
    case 'disaster-response': {
      const pressures = environments.filter((event) => (event.change === 'climate' && (event.diff.epoch === 'chaotic' || Number(event.diff.severity) >= 5))
        || (event.change === 'weather' && event.diff.kind !== 'clear' && Number(event.diff.intensity) >= 2)
        || (event.change === 'condition' && (event.diff.condition === 'cold' || event.diff.condition === 'heat')));
      const responses = completed.filter((event) => event.action.kind === 'move'
        || (event.action.kind === 'act' && ['dehydrate', 'rehydrate', 'ingest'].includes(event.action.operation)));
      return responses.flatMap((response) => {
        const pressure = [...pressures].reverse().find((event) => event.atMonth <= response.atMonth && response.atMonth - event.atMonth <= 3
          && (!event.who || event.who === response.who));
        return pressure ? episode([pressure, response], [response.who], [response.who]) ?? [] : [];
      });
    }
    case 'tool-craft':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'combine'
        && materialHas(materialOutput(event), 'tool'));
    case 'spear-craft':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'combine'
        && materialOutput(event) === Material.Spear);
    case 'rope-craft':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'combine'
        && materialOutput(event) === Material.Rope);
    case 'container-practice': {
      const creations = completed.filter((event) => event.action.kind === 'act' && event.action.operation === 'combine'
        && materialOutput(event) === Material.Container && typeof event.diff.containerId === 'string');
      const transfers = completed.filter((event) => event.action.kind === 'transfer'
        && (event.action.from.kind === 'container' || event.action.to.kind === 'container'));
      return creations.flatMap((creation) => {
        const containerId = String(creation.diff.containerId);
        const use = transfers.find((event) => event.atMonth >= creation.atMonth && event.action.kind === 'transfer'
          && ((event.action.from.kind === 'container' && event.action.from.containerId === containerId)
            || (event.action.to.kind === 'container' && event.action.to.containerId === containerId)));
        return use ? episode([creation, use], unique([creation.who, use.who])) ?? [] : [];
      });
    }
    case 'fire-making':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'exert' && materialOutput(event) === Material.Fire);
    case 'fire-practice': {
      const fire = completed.filter((event) => event.action.kind === 'act'
        && (materialOutput(event) === Material.Fire || Number(event.diff.sourceMaterialId) === Material.Fire));
      return [...grouped(fire, (event) => event.who).entries()].flatMap(([personId, events]) => new Set(events.map((event) => event.atMonth)).size >= 2
        ? episode(events, [personId]) ?? [] : []);
    }
    case 'cooking':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'expose' && materialOutput(event) === Material.CookedFood);
    case 'clothing':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'combine'
        && ([Material.Clothing, Material.LeatherClothing] as number[]).includes(materialOutput(event)));
    case 'shelter':
      return state.derived.structures.filter((structure) => structure.complete && structure.capacity > 0)
        .flatMap((structure) => episode(resolvedEvents(index, structure.sourceEventIds), [], []) ?? []);
    case 'settlement': {
      const complete = state.derived.structures.filter((structure) => structure.complete && structure.capacity > 0);
      return complete.flatMap((structure) => {
        const residents = state.people.filter(isAlive).filter((person) => structure.occupiedCells.includes(person.position.cellId));
        const sources = resolvedEvents(index, structure.sourceEventIds);
        const firstBuiltAt = sources.length ? Math.min(...sources.map((event) => event.atMonth)) : Number.POSITIVE_INFINITY;
        return residents.length && sources.length && state.clock.elapsedMonths - firstBuiltAt >= 12
          ? episode(sources, residents.map((person) => person.id)) ?? [] : [];
      });
    }
    case 'communication':
      return completed.flatMap((event) => event.action.kind === 'communicate'
        && event.action.audience.some((id) => id !== event.who)
        ? episode([event], [event.who, ...event.action.audience]) ?? [] : []);
    case 'direct-communication':
      return completed.flatMap((event) => event.action.kind === 'communicate'
        && (event.action.channel === 'voice' || event.action.channel === 'gesture')
        && event.action.audience.some((id) => id !== event.who)
        ? episode([event], [event.who, ...event.action.audience]) ?? [] : []);
    case 'gesture-communication':
      return completed.flatMap((event) => event.action.kind === 'communicate'
        && event.action.channel === 'gesture' && event.action.audience.some((id) => id !== event.who)
        ? episode([event], [event.who, ...event.action.audience]) ?? [] : []);
    case 'natural-observation':
      return actionEvents((event) => event.action.kind === 'attend'
        && (event.action.target.kind === 'animal' || event.action.target.kind === 'voxel' || event.action.target.kind === 'drop'));
    case 'fulfilled-assist':
      return state.agreements.filter((agreement) => agreement.proposal.kind === 'assist' && agreement.status === 'fulfilled')
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds, [agreement.proposerId]) ?? []);
    case 'teaching': {
      const teaching = completed.filter((event) => event.action.kind === 'communicate'
        && event.action.content.kind === 'claim' && Boolean(event.action.content.factId));
      return teaching.flatMap((event) => {
        if (event.action.kind !== 'communicate' || event.action.content.kind !== 'claim' || !event.action.content.factId) return [];
        const factId = event.action.content.factId;
        const learners = state.people.filter((person) => person.id !== event.who
          && person.knowledge.some((fact) => fact.id === factId && fact.sourceEventIds.includes(event.id)));
        return learners.length ? episode([event], [event.who, ...learners.map((person) => person.id)], learners.map((person) => person.id)) ?? [] : [];
      });
    }
    case 'craft-teaching': {
      const teaching = completed.filter((event) => event.action.kind === 'communicate'
        && event.action.content.kind === 'claim' && event.action.content.factId?.startsWith('technique:'));
      return teaching.flatMap((event) => {
        if (event.action.kind !== 'communicate' || event.action.content.kind !== 'claim' || !event.action.content.factId) return [];
        const factId = event.action.content.factId;
        const learners = state.people.filter((person) => person.id !== event.who
          && person.knowledge.some((fact) => fact.kind === 'technique' && fact.id === factId && fact.sourceEventIds.includes(event.id)));
        return learners.length ? episode([event], [event.who, ...learners.map((person) => person.id)], learners.map((person) => person.id)) ?? [] : [];
      });
    }
    case 'stable-teaching': {
      const techniques = new Map<string, SimulationState['people']>();
      for (const person of state.people) for (const fact of person.knowledge.filter((item) => item.confidence >= 55)) {
        const holders = techniques.get(fact.id) ?? [];
        holders.push(person);
        techniques.set(fact.id, holders);
      }
      return [...techniques.entries()].flatMap(([, holders]) => {
        if (holders.length < 2) return [];
        const sources = resolvedEvents(index, holders.flatMap((person) => person.knowledge.flatMap((fact) => fact.sourceEventIds)));
        const crossGeneration = new Set(holders.map((person) => person.generation)).size >= 2;
        const communication = sources.some((event) => event.kind === 'action' && event.action.kind === 'communicate');
        return communication || crossGeneration ? episode(sources.slice(-24), holders.map((person) => person.id), holders.map((person) => person.id)) ?? [] : [];
      });
    }
    case 'cross-generation-teaching': {
      const byTechnique = new Map<string, SimulationState['people']>();
      for (const person of state.people) for (const fact of person.knowledge.filter((item) => item.kind === 'technique' && item.confidence >= 55)) {
        const holders = byTechnique.get(fact.id) ?? [];
        holders.push(person);
        byTechnique.set(fact.id, holders);
      }
      return [...byTechnique.values()].flatMap((holders) => {
        if (new Set(holders.map((person) => person.generation)).size < 2) return [];
        const sources = resolvedEvents(index, holders.flatMap((person) => person.knowledge.flatMap((fact) => fact.sourceEventIds)));
        return sources.length ? episode(sources.slice(-32), holders.map((person) => person.id), holders.map((person) => person.id)) ?? [] : [];
      });
    }
    case 'collective':
      return state.collectives.flatMap((collective) => episode(resolvedEvents(index, collective.sourceEventIds), collective.memberships.map((item) => item.personId)) ?? []);
    case 'cultivation': {
      const planting = completedAct(index, 'combine').filter((event) => materialOutput(event) === Material.CropSprout);
      const harvest = completedAct(index, 'separate').filter((event) => Number(event.diff.sourceMaterialId) === Material.CropMature);
      return planting.flatMap((start) => {
        const end = harvest.find((event) => event.atMonth >= start.atMonth && (event.cellId === start.cellId || event.who === start.who));
        return end ? episode([start, end], unique([start.who, end.who])) ?? [] : [];
      });
    }
    case 'storage':
      return completed.flatMap((event) => event.action.kind === 'transfer'
        && (event.action.from.kind === 'container' || event.action.to.kind === 'container')
        ? episode([event], transferPeople(event)) ?? [] : []);
    case 'shared-storage': {
      const transfers = completed.filter((event) => event.action.kind === 'transfer'
        && (event.action.from.kind === 'container' || event.action.to.kind === 'container'));
      const byContainer = grouped(transfers, (event) => event.action.kind === 'transfer'
        ? event.action.from.kind === 'container' ? event.action.from.containerId
          : event.action.to.kind === 'container' ? event.action.to.containerId : null : null);
      return [...byContainer.values()].flatMap((events) => {
        const users = unique(events.map((event) => event.who));
        return users.length >= 2 ? episode(events, users) ?? [] : [];
      });
    }
    case 'water-assistance': {
      const fulfilled = state.agreements.filter((agreement) => agreement.proposal.kind === 'assist'
        && agreement.proposal.need === 'water' && agreement.status === 'fulfilled');
      const drinking = completed.filter((event) => event.action.kind === 'act' && event.action.operation === 'ingest'
        && materialHas(Number(event.diff.materialId), 'drinkable'));
      return [
        ...fulfilled.flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds, [agreement.proposerId]) ?? []),
        ...drinking.flatMap((event) => episode([event], [event.who], [event.who]) ?? []),
      ];
    }
    case 'famine': {
      const hunger = environments.filter((event) => event.change === 'body' && Number(event.diff.nutrition) < 10
        && typeof event.who === 'string').sort((left, right) => left.atMonth - right.atMonth || left.orderInMonth - right.orderInMonth);
      for (const start of hunger) {
        const window = hunger.filter((event) => event.atMonth >= start.atMonth && event.atMonth - start.atMonth <= 2);
        const affected = unique(window.flatMap((event) => event.who ?? []));
        if (affected.length >= 2) return episode(window, affected, affected) ? [episode(window, affected, affected) as Episode] : [];
      }
      return [];
    }
    case 'permission':
      return state.permissions.flatMap((permission) => episode(resolvedEvents(index, permission.sourceEventIds), [permission.grantorId, permission.granteeId]) ?? []);
    case 'permission-use':
      return state.permissions.filter((permission) => permission.useEventIds.length > 0)
        .flatMap((permission) => episode(resolvedEvents(index, [...permission.sourceEventIds, ...permission.useEventIds]), [permission.grantorId, permission.granteeId]) ?? []);
    case 'road': {
      const roadActions = completed.filter((event) => Array.isArray(event.diff.materialChanges)
        && event.diff.materialChanges.some((change) => change && typeof change === 'object' && Number((change as { to?: unknown }).to) === Material.PackedSoil));
      const cells = new Set<number>();
      const evidence: ActionFact[] = [];
      for (const action of roadActions) {
        const changed = (eventChanges(action)).filter((change) => Number(change.to) === Material.PackedSoil && Number.isInteger(Number(change.cellId)));
        if (!changed.length) continue;
        changed.forEach((change) => cells.add(Number(change.cellId)));
        evidence.push(action);
        if (largestConnectedCellCount(cells) >= 4) {
          const observed = episode(evidence, unique(evidence.map((event) => event.who)));
          return observed ? [observed] : [];
        }
      }
      return [];
    }
    case 'exchange':
      return state.agreements.filter((agreement) => agreement.proposal.kind === 'exchange' && agreement.status === 'fulfilled')
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds) ?? []);
    case 'repeated-exchange': {
      const exchanges = state.agreements.filter((agreement) => agreement.proposal.kind === 'exchange' && agreement.status === 'fulfilled');
      return [...grouped(exchanges, (agreement) => [...agreement.partyIds].sort().join('|')).values()].flatMap((agreements) => {
        const months = new Set(agreements.map((agreement) => agreement.resolvedAtMonth));
        return agreements.length >= 2 && months.size >= 2
          ? episode(resolvedEvents(index, agreements.flatMap((agreement) => agreement.sourceEventIds)), unique(agreements.flatMap((agreement) => agreement.partyIds))) ?? [] : [];
      });
    }
    case 'agreement':
      return state.agreements.filter((agreement) => ['active', 'fulfilled'].includes(agreement.status) && agreement.acceptedByPersonIds.length >= 2)
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds) ?? []);
    case 'agreement-rejection':
      return state.agreements.filter((agreement) => agreement.status === 'rejected' && agreement.rejectedByPersonIds.length > 0)
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds, agreement.rejectedByPersonIds) ?? []);
    case 'companion':
      return state.agreements.filter((agreement) => agreement.proposal.kind === 'companion' && agreement.status === 'fulfilled')
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds) ?? []);
    case 'relationship-rejection':
      return state.agreements.filter((agreement) => (agreement.proposal.kind === 'companion' || agreement.proposal.kind === 'reproduce')
        && agreement.status === 'rejected')
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds, agreement.rejectedByPersonIds) ?? []);
    case 'membership-belonging':
    case 'membership-admission': {
      const candidateDriven = key === 'membership-belonging';
      return state.collectives.filter((collective) => collective.status === 'active').flatMap((collective) => collective.memberships
        .filter((membership) => membership.status === 'active' && membership.joinedAtMonth > collective.foundedAtMonth)
        .flatMap((membership) => {
          const admission = state.agreements.find((agreement) => agreement.status === 'fulfilled'
            && agreement.proposal.kind === 'membership'
            && agreement.proposal.collectiveId === collective.id
            && agreement.proposal.candidateId === membership.personId
            && agreement.resolvedAtMonth === membership.joinedAtMonth);
          if (!admission || admission.proposal.kind !== 'membership') return [];
          const proposalEvent = index.byId.get(admission.proposalEventId);
          if (!proposalEvent || proposalEvent.kind !== 'action' || proposalEvent.status !== 'completed'
            || proposalEvent.who !== admission.proposerId
            || proposalEvent.action.kind !== 'communicate'
            || proposalEvent.action.content.kind !== 'offer'
            || proposalEvent.action.content.id !== admission.id
            || proposalEvent.action.content.proposal?.kind !== 'membership'
            || proposalEvent.action.content.proposal.collectiveId !== collective.id
            || proposalEvent.action.content.proposal.candidateId !== membership.personId) return [];
          const proposerMembership = collective.memberships.find((item) => item.personId === admission.proposerId
            && item.personId !== membership.personId
            && item.joinedAtMonth <= proposalEvent.atMonth
            && (item.endedAtMonth === undefined || item.endedAtMonth >= proposalEvent.atMonth));
          if (!proposerMembership) return [];

          const sourceEvents = resolvedEvents(index, unique([...membership.sourceEventIds, ...admission.sourceEventIds]));
          const requiredResponderIds = unique(admission.requiredResponderIds);
          if (!requiredResponderIds.includes(membership.personId)
            || !requiredResponderIds.every((personId) => admission.acceptedByPersonIds.includes(personId))) return [];
          const acceptances = sourceEvents.filter((event): event is ActionFact => event.kind === 'action'
            && event.status === 'completed'
            && event.action.kind === 'communicate'
            && event.action.content.kind === 'accept'
            && event.action.content.referenceId === admission.id
            && requiredResponderIds.includes(event.who));
          const acceptingPeople = new Set(acceptances.map((event) => event.who));
          if (!requiredResponderIds.every((personId) => acceptingPeople.has(personId))) return [];

          const candidateRequests = sourceEvents.filter((event): event is ActionFact => event.kind === 'action'
            && event.status === 'completed'
            && event.who === membership.personId
            && event.action.kind === 'communicate'
            && event.action.content.kind === 'request'
            && event.action.content.proposal?.kind === 'membership'
            && event.action.content.proposal.proposerId === membership.personId
            && event.action.content.proposal.candidateId === membership.personId
            && event.action.content.proposal.collectiveId === collective.id);
          if (candidateDriven !== (candidateRequests.length > 0)) return [];
          const evidence = candidateDriven
            ? [candidateRequests.at(-1) as ActionFact, proposalEvent, ...acceptances]
            : [proposalEvent, ...acceptances];
          return episode(evidence, admission.partyIds, [membership.personId]) ?? [];
        }));
    }
    case 'membership-rejection':
      return state.agreements.filter((agreement) => agreement.proposal.kind === 'membership' && agreement.status === 'rejected')
        .flatMap((agreement) => episode(resolvedEvents(index, agreement.sourceEventIds), agreement.partyIds, agreement.proposal.kind === 'membership' ? [agreement.proposal.candidateId] : []) ?? []);
    case 'writing': {
      const writes = completed.filter((event) => event.action.kind === 'communicate' && event.action.channel === 'record'
        && typeof event.diff.recordPayloadId === 'string');
      const reads = completed.filter((event) => event.action.kind === 'attend' && typeof event.diff.recordPayloadId === 'string' && event.diff.understood === true);
      return writes.flatMap((write) => {
        const read = reads.find((candidate) => candidate.who !== write.who && candidate.diff.recordPayloadId === write.diff.recordPayloadId);
        return read ? episode([write, read], [write.who, read.who], [read.who]) ?? [] : [];
      });
    }
    case 'shared-record': {
      const recordActions = completed.filter((event) => typeof event.diff.recordPayloadId === 'string'
        && ((event.action.kind === 'communicate' && event.action.channel === 'record')
          || (event.action.kind === 'attend' && event.diff.understood === true)));
      return [...grouped(recordActions, (event) => String(event.diff.recordPayloadId)).values()].flatMap((events) => {
        const users = unique(events.map((event) => event.who));
        return users.length >= 2 ? episode(events, users) ?? [] : [];
      });
    }
    case 'physical-record': {
      const carriers = [
        ...state.people.flatMap((person) => person.inventory.filter((stack) => stack.quantity > 0 && stack.recordPayloadId)
          .map((stack) => ({ payloadId: stack.recordPayloadId as string, sourceEventIds: stack.sourceEventIds, participantIds: [person.id] }))),
        ...state.world.drops.filter((drop) => drop.quantity > 0 && drop.recordPayloadId)
          .map((drop) => ({ payloadId: drop.recordPayloadId as string, sourceEventIds: drop.sourceEventIds, participantIds: [] as PersonId[] })),
        ...state.containers.flatMap((container) => container.inventory.filter((stack) => stack.quantity > 0 && stack.recordPayloadId)
          .map((stack) => ({ payloadId: stack.recordPayloadId as string, sourceEventIds: stack.sourceEventIds, participantIds: [] as PersonId[] }))),
      ];
      return state.records.filter((record) => state.clock.elapsedMonths - record.createdAtMonth >= 12).flatMap((record) => {
        const currentCarriers = carriers.filter((carrier) => carrier.payloadId === record.id);
        if (!currentCarriers.length) return [];
        const creationEvents = resolvedEvents(index, record.sourceEventIds).filter((event): event is ActionFact => event.kind === 'action'
          && event.status === 'completed'
          && event.who === record.authorId
          && event.action.kind === 'communicate'
          && event.action.channel === 'record'
          && event.diff.recordPayloadId === record.id);
        if (!creationEvents.length) return [];
        const carrierEvents = resolvedEvents(index, currentCarriers.flatMap((carrier) => carrier.sourceEventIds))
          .filter((event) => event.kind === 'action' && event.diff.recordPayloadId === record.id);
        const retained = episode([...creationEvents, ...carrierEvents], unique([
          record.authorId,
          ...currentCarriers.flatMap((carrier) => carrier.participantIds),
        ]));
        return retained ? [{ ...retained, observedAtMonth: state.clock.elapsedMonths }] : [];
      });
    }
    case 'memory':
      return state.people.flatMap((person) => person.memories.flatMap((memory) => {
        const sources = resolvedEvents(index, memory.sourceEventIds);
        return sources.length ? episode(sources, [person.id, ...memory.personIds], [person.id]) ?? [] : [];
      }));
    case 'observation':
      return actionEvents((event) => event.action.kind === 'attend');
    case 'instrument-observation':
      return actionEvents((event) => event.action.kind === 'attend' && typeof event.action.instrumentStackId === 'string');
    case 'tested-hypothesis':
    case 'trial-learning': {
      const facts = state.people.flatMap((person) => person.knowledge
        .filter((fact) => fact.kind === 'technique' && fact.confidence >= 55)
        .map((fact) => ({ person, fact })));
      return facts.flatMap(({ person, fact }) => {
        const sources = resolvedEvents(index, fact.sourceEventIds);
        const trials = sources.filter((event): event is ActionFact => event.kind === 'action'
          && event.status === 'completed' && event.action.kind === 'act'
          && ['combine', 'exert', 'expose', 'separate', 'hunt'].includes(event.action.operation));
        if (key === 'trial-learning') {
          return trials.length >= 2 ? episode(trials.slice(0, 16), [person.id], [person.id]) ?? [] : [];
        }
        const verification = sources.find((event): event is ActionFact => event.kind === 'action'
          && event.status === 'completed' && event.action.kind === 'attend'
          && event.diff.verifiedTechnique === true && event.diff.factId === fact.id);
        return trials.length && verification
          ? episode([trials[0], verification], [person.id], [person.id]) ?? [] : [];
      });
    }
    case 'experiment': {
      const facts = state.people.flatMap((person) => person.knowledge.filter((fact) => fact.kind === 'technique' && fact.confidence >= 55));
      return facts.flatMap((fact) => {
        const sources = resolvedEvents(index, fact.sourceEventIds);
        const trials = sources.filter((event) => event.kind === 'action' && event.status === 'completed' && event.action.kind === 'act');
        const verification = sources.some((event) => event.kind === 'action' && event.status === 'completed' && event.action.kind === 'attend' && event.diff.verifiedTechnique === true);
        return trials.length >= 2 || (trials.length >= 1 && verification) ? episode(sources) ?? [] : [];
      });
    }
    case 'mandate':
      return state.collectives.flatMap((collective) => collective.mandates.flatMap((mandate) => episode(resolvedEvents(index, mandate.sourceEventIds), collective.memberships.map((item) => item.personId), [mandate.holderId]) ?? []));
    case 'decision-rule':
      return state.collectives.flatMap((collective) => collective.decisionRules.flatMap((rule) => episode(resolvedEvents(index, rule.sourceEventIds), collective.memberships.map((item) => item.personId)) ?? []));
    case 'exercised-mandate':
      return state.collectives.flatMap((collective) => collective.mandates.filter((mandate) => mandate.contributionEventIds.length > 0 && mandate.distributionEventIds.length > 0)
        .flatMap((mandate) => episode(resolvedEvents(index, [
          ...mandate.sourceEventIds,
          ...mandate.contributionEventIds,
          ...mandate.distributionEventIds,
        ]), collective.memberships.map((item) => item.personId), [mandate.holderId]) ?? []));
    case 'returned-mandate':
      return state.collectives.flatMap((collective) => collective.mandates.filter((mandate) => mandate.status !== 'active'
        && (mandate.contributionEventIds.length > 0 || mandate.distributionEventIds.length > 0))
        .flatMap((mandate) => episode(resolvedEvents(index, [
          ...mandate.sourceEventIds,
          ...mandate.contributionEventIds,
          ...mandate.distributionEventIds,
        ]), collective.memberships.map((item) => item.personId), [mandate.holderId]) ?? []));
    case 'prediction':
      return state.eraPredictions.flatMap((prediction) => episode(resolvedEvents(index, prediction.sourceEventIds), [prediction.predictorId, ...prediction.audienceIds]) ?? []);
    case 'correct-prediction':
      return state.eraPredictions.filter((prediction) => prediction.status === 'correct')
        .flatMap((prediction) => episode(resolvedEvents(index, prediction.sourceEventIds), [prediction.predictorId, ...prediction.audienceIds]) ?? []);
    case 'incorrect-prediction':
      return state.eraPredictions.filter((prediction) => prediction.status === 'incorrect')
        .flatMap((prediction) => episode(resolvedEvents(index, prediction.sourceEventIds), [prediction.predictorId, ...prediction.audienceIds]) ?? []);
    case 'prediction-practice':
      return [...grouped(state.eraPredictions.filter((prediction) => prediction.status !== 'pending'), (prediction) => prediction.predictorId).values()]
        .flatMap((predictions) => predictions.length >= 2
          ? episode(resolvedEvents(index, predictions.flatMap((prediction) => prediction.sourceEventIds)), unique(predictions.flatMap((prediction) => [prediction.predictorId, ...prediction.audienceIds]))) ?? [] : []);
    case 'project':
      return state.projects.filter((project) => project.actionEventIds.length > 0 || project.completionEventIds.length > 0 || project.failureEventIds.length > 0)
        .flatMap((project) => episode(resolvedEvents(index, [...project.triggerFactIds, ...project.actionEventIds, ...project.completionEventIds, ...project.failureEventIds]), project.contributorIds, project.beneficiaryIds) ?? []);
    case 'inquiry-project':
      return state.projects.filter((project) => project.kind === 'inquiry'
        && (project.actionEventIds.length > 0 || project.completionEventIds.length > 0 || project.failureEventIds.length > 0))
        .flatMap((project) => episode(resolvedEvents(index, [...project.triggerFactIds, ...project.actionEventIds, ...project.completionEventIds, ...project.failureEventIds]), project.contributorIds, project.beneficiaryIds) ?? []);
    case 'joint-project':
      return state.projects.filter((project) => project.status === 'completed' && project.contributorIds.length >= 2 && project.completionEventIds.length > 0)
        .flatMap((project) => episode(resolvedEvents(index, [...project.triggerFactIds, ...project.actionEventIds, ...project.completionEventIds]), project.contributorIds, project.beneficiaryIds) ?? []);
    case 'project-logistics':
      return state.projects.flatMap((project) => (project.logisticsEpisodes ?? []).filter((item) => item.status === 'fulfilled' || item.status === 'exhausted')
        .flatMap((item) => episode(resolvedEvents(index, [...item.sourceEventIds, ...item.actionEventIds]), [item.actorId], project.beneficiaryIds) ?? []));
    case 'project-breakdown':
      return state.projects.filter((project) => project.status === 'blocked'
        || (project.logisticsEpisodes ?? []).some((item) => item.status === 'exhausted' || item.status === 'invalidated'))
        .flatMap((project) => {
          const failedLogistics = (project.logisticsEpisodes ?? []).filter((item) => item.status === 'exhausted' || item.status === 'invalidated');
          const failureIds = unique([
            ...project.failureEventIds,
            ...failedLogistics.flatMap((item) => [...item.sourceEventIds, ...item.actionEventIds]),
          ]);
          return failureIds.length
            ? episode(resolvedEvents(index, [...project.triggerFactIds, ...failureIds]), project.contributorIds, project.beneficiaryIds) ?? []
            : [];
        });
    case 'project-recovery':
      return state.projects.filter((project) => project.status === 'completed' && project.completionEventIds.length > 0
        && (project.failureEventIds.length > 0 || (project.logisticsEpisodes ?? []).some((item) => item.status === 'exhausted' || item.status === 'invalidated')))
        .flatMap((project) => {
          const failedLogistics = (project.logisticsEpisodes ?? []).filter((item) => item.status === 'exhausted' || item.status === 'invalidated');
          const failureIds = unique([
            ...project.failureEventIds,
            ...failedLogistics.flatMap((item) => [...item.sourceEventIds, ...item.actionEventIds]),
          ]);
          return failureIds.length
            ? episode(resolvedEvents(index, [...failureIds, ...project.completionEventIds]), project.contributorIds, project.beneficiaryIds) ?? []
            : [];
        });
    case 'knowledge-preservation':
      return state.projects.filter((project) => project.need === 'knowledge-preservation' && project.status === 'completed')
        .flatMap((project) => episode(resolvedEvents(index, [...project.triggerFactIds, ...project.actionEventIds, ...project.completionEventIds]), project.contributorIds, project.beneficiaryIds) ?? []);
    case 'forest-harvest':
      return actionEvents((event) => event.action.kind === 'act' && event.action.operation === 'separate'
        && ([Material.Wood, Material.Leaves, Material.Grass, Material.Shrub] as number[]).includes(Number(event.diff.sourceMaterialId)));
    case 'mutual-aid': {
      const assistance = state.agreements.filter((agreement) => agreement.proposal.kind === 'assist' && agreement.status === 'fulfilled');
      if (assistance.length < 2) return [];
      const participants = unique(assistance.flatMap((agreement) => agreement.partyIds));
      const months = new Set(assistance.map((agreement) => agreement.resolvedAtMonth));
      return participants.length >= 2 && months.size >= 2
        ? [episode(resolvedEvents(index, assistance.flatMap((agreement) => agreement.sourceEventIds)), participants, participants) as Episode] : [];
    }
    case 'permission-revoked':
      return state.permissions.filter((permission) => permission.status === 'revoked')
        .flatMap((permission) => episode(resolvedEvents(index, permission.sourceEventIds), [permission.grantorId, permission.granteeId], [permission.granteeId]) ?? []);
    case 'theft-attempt':
      return index.actions.flatMap((event) => event.action.kind === 'transfer' && event.action.from.kind === 'person'
        && event.action.to.kind === 'person' && event.status === 'blocked' && event.diff.authorized === false
        && event.diff.attempted === true && typeof event.diff.resistedBy === 'string'
        ? episode([event], transferPeople(event), [event.diff.resistedBy]) ?? [] : []);
    case 'theft-success':
      return completed.flatMap((event) => event.action.kind === 'transfer' && event.action.from.kind === 'person'
        && event.action.to.kind === 'person' && event.diff.authorized === false && Number(event.diff.quantity) > 0
        ? episode([event], transferPeople(event), [event.action.from.personId]) ?? [] : []);
    case 'violence':
      return completed.flatMap((event) => event.action.kind === 'act' && event.action.operation === 'exert'
        && typeof event.diff.victimId === 'string' && Number(event.diff.damage) > 0
        && actionTargetPerson(event) === event.diff.victimId
        ? episode([event], [event.who], [event.diff.victimId]) ?? [] : []);
    case 'lethal-violence': {
      const attacks = completed.filter((event) => event.action.kind === 'act' && event.action.operation === 'exert'
        && typeof event.diff.victimId === 'string' && Number(event.diff.damage) > 0 && actionTargetPerson(event) === event.diff.victimId);
      const deaths = environments.filter((event) => event.change === 'death' && typeof event.diff.personId === 'string');
      return deaths.flatMap((death) => {
        const sources = new Set(strings(death.diff.sourceEventIds));
        const attack = attacks.find((candidate) => candidate.diff.victimId === death.diff.personId && sources.has(candidate.id));
        return attack ? episode([attack, death], [attack.who], [String(death.diff.personId)]) ?? [] : [];
      });
    }
    case 'restraint':
      return completed.flatMap((event) => typeof event.diff.restrainedPersonId === 'string'
        && typeof event.diff.conditionId === 'string' && Number(event.diff.materialId) === Material.Rope
        ? episode([event], [event.who], [event.diff.restrainedPersonId]) ?? [] : []);
    case 'release-restraint':
      return completed.flatMap((event) => typeof event.diff.releasedPersonId === 'string' && typeof event.diff.sourceConditionId === 'string'
        ? episode([event], [event.who], [event.diff.releasedPersonId]) ?? [] : []);
    case 'breach':
      return index.events.flatMap((event) => event.kind === 'agreement' && event.change === 'breached'
        ? (() => {
            const agreement = state.agreements.find((item) => item.id === event.agreementId && item.acceptedAtMonth !== undefined);
            if (!agreement) return [];
            const sources = resolvedEvents(index, agreement.sourceEventIds);
            const proposal = sources.find((source) => source.kind === 'action' && source.status === 'completed'
              && source.action.kind === 'communicate'
              && (source.action.content.kind === 'offer' || source.action.content.kind === 'request')
              && source.action.content.id === agreement.id);
            const acceptance = sources.find((source) => source.kind === 'action' && source.status === 'completed'
              && source.action.kind === 'communicate' && source.action.content.kind === 'accept'
              && source.action.content.referenceId === agreement.id);
            return proposal && acceptance && sources.some((source) => source.id === event.id)
              ? episode([proposal, acceptance, event], agreement.partyIds, agreement.partyIds) ?? [] : [];
          })() : []);
    case 'collective-withdrawal':
      return state.collectives.flatMap((collective) => collective.memberships.filter((membership) => membership.status === 'withdrawn')
        .flatMap((membership) => episode(resolvedEvents(index, membership.sourceEventIds), [membership.personId], [membership.personId]) ?? []));
    case 'collective-collapse':
      return state.collectives.filter((collective) => collective.status !== 'active'
        && collective.memberships.some((membership) => membership.status === 'withdrawn'))
        .flatMap((collective) => episode(resolvedEvents(index, collective.sourceEventIds), collective.memberships.map((membership) => membership.personId), collective.memberships.filter((membership) => membership.status === 'withdrawn').map((membership) => membership.personId)) ?? []);
    case 'collective-recovery':
      return state.collectives.filter((collective) => collective.status === 'active'
        && collective.memberships.some((membership) => membership.status === 'withdrawn')
        && collective.memberships.some((membership) => membership.status === 'active' && membership.joinedAtMonth > collective.foundedAtMonth))
        .flatMap((collective) => episode(resolvedEvents(index, collective.sourceEventIds), collective.memberships.map((membership) => membership.personId)) ?? []);
    case 'technique-loss': {
      const historical = new Map<string, { holderIds: PersonId[]; sourceIds: string[] }>();
      for (const person of state.people) for (const fact of person.knowledge.filter((item) => item.kind === 'technique' && item.confidence >= 55)) {
        const current = historical.get(fact.id) ?? { holderIds: [], sourceIds: [] };
        historical.set(fact.id, {
          holderIds: unique([...current.holderIds, person.id]),
          sourceIds: unique([...current.sourceIds, ...fact.sourceEventIds]),
        });
      }
      const livingTechniques = new Set(state.people.filter(isAlive).flatMap((person) => person.knowledge
        .filter((fact) => fact.kind === 'technique' && fact.confidence >= 55).map((fact) => fact.id)));
      const physicalRecordIds = new Set([
        ...state.people.flatMap((person) => person.inventory.flatMap((stack) => stack.recordPayloadId ?? [])),
        ...state.world.drops.flatMap((drop) => drop.recordPayloadId ?? []),
        ...state.containers.flatMap((container) => container.inventory.flatMap((stack) => stack.recordPayloadId ?? [])),
      ]);
      const recordedTechniques = new Set(state.records.filter((record) => physicalRecordIds.has(record.id) && record.kind === 'technique').map((record) => record.knowledgeId));
      const deathByPerson = new Map<PersonId, EnvironmentFact>(environments
        .filter((event) => event.change === 'death' && typeof event.diff.personId === 'string')
        .map((event) => [String(event.diff.personId), event]));
      return [...historical.entries()].flatMap(([techniqueId, history]) => {
        if (livingTechniques.has(techniqueId) || recordedTechniques.has(techniqueId)) return [];
        const holderDeaths = history.holderIds.flatMap((personId) => deathByPerson.get(personId) ?? []);
        if (holderDeaths.length !== history.holderIds.length) return [];
        return episode(resolvedEvents(index, history.sourceIds).concat(holderDeaths), history.holderIds, history.holderIds) ?? [];
      });
    }
    case 'technique-recovery': {
      const lost = detect('technique-loss', state, index);
      if (!lost.length) return [];
      const recent = state.people.filter(isAlive).flatMap((person) => person.knowledge.filter((fact) => fact.kind === 'technique' && fact.confidence >= 55)
        .flatMap((fact) => episode(resolvedEvents(index, fact.sourceEventIds), [person.id], [person.id]) ?? []));
      return recent.filter((item) => item.observedAtMonth > Math.min(...lost.map((entry) => entry.observedAtMonth)));
    }
    case 'animal-attack':
      return environments.flatMap((event) => event.change === 'animal' && event.diff.process === 'attack-human'
        && typeof event.diff.victimId === 'string' && Number(event.diff.damage) > 0
        ? episode([event], [], [event.diff.victimId]) ?? [] : []);
    case 'wildlife-knowledge': {
      const wildlifeActions = completed.filter((event) => (event.action.kind === 'attend' && event.action.target.kind === 'animal')
        || (event.action.kind === 'act' && event.action.operation === 'hunt' && event.action.targets.some((target) => target.kind === 'animal')));
      const speciesByAnimal = new Map(state.world.animals.map((animal) => [animal.id, animal.speciesId]));
      return [...grouped(wildlifeActions, (event) => {
        const animalId = event.action.kind === 'attend' && event.action.target.kind === 'animal' ? event.action.target.animalId
          : event.action.kind === 'act' ? event.action.targets.find((target) => target.kind === 'animal')?.animalId : undefined;
        return animalId ? speciesByAnimal.get(animalId) ?? animalId : null;
      }).values()].flatMap((events) => new Set(events.map((event) => event.atMonth)).size >= 2
        ? episode(events, unique(events.map((event) => event.who))) ?? [] : []);
    }
    case 'weather':
      return eventEpisodes(environments.filter((event) => event.change === 'weather' || event.change === 'climate'));
    case 'era-cycle': {
      const transitions = environments.filter((event) => event.change === 'climate' && event.diff.eraTransition === true);
      return transitions.length >= 2 && new Set(transitions.map((event) => event.diff.epoch)).size >= 2 ? [episode(transitions) as Episode] : [];
    }
    case 'guarded':
      return [];
  }
}

function eventChanges(event: ActionFact): Array<{ cellId?: unknown; to?: unknown }> {
  return Array.isArray(event.diff.materialChanges)
    ? event.diff.materialChanges.filter((item): item is { cellId?: unknown; to?: unknown } => Boolean(item && typeof item === 'object'))
    : [];
}

function largestConnectedCellCount(cells: ReadonlySet<number>): number {
  const unseen = new Set(cells);
  let largest = 0;
  while (unseen.size) {
    const start = unseen.values().next().value as number;
    const frontier = [start];
    unseen.delete(start);
    let size = 0;
    while (frontier.length) {
      const current = frontier.pop() as number;
      size += 1;
      for (const neighbor of neighbors4(current)) if (unseen.delete(neighbor)) frontier.push(neighbor);
    }
    largest = Math.max(largest, size);
  }
  return largest;
}

type MapCatalogEntry = readonly [capabilityId: number, mapLabel: string];

const MAP_CATALOG = [
  [1, '诞生'],
  [2, '繁衍后代'],
  [3, '养育幼儿'],
  [4, '结成家庭与亲族'],
  [5, '生病'],
  [6, '医治伤病'],
  [7, '照料弱者'],
  [8, '衰老'],
  [9, '死亡'],
  [11, '采集食物'],
  [12, '捕猎动物'],
  [13, '分享资源'],
  [14, '迁徙远方'],
  [15, '应对自然灾害'],
  [16, '制造工具'],
  [17, '掌控火种'],
  [18, '烹饪食物'],
  [19, '制作衣物'],
  [20, '建造住所'],
  [21, '创造语言'],
  [22, '协同行动'],
  [23, '教育下一代'],
  [24, '讲述并传承往事'],
  [29, '结成友谊与联盟'],
  [32, '栽培作物'],
  [33, '定居村落'],
  [34, '储藏剩余粮食'],
  [35, '管理水源'],
  [36, '遭遇饥荒'],
  [37, '划定土地与财产'],
  [38, '实行专业分工'],
  [42, '开辟道路'],
  [45, '交换货物'],
  [48, '订立契约'],
  [51, '创造文字'],
  [58, '观察自然现象'],
  [59, '用实验检验猜想'],
  [61, '选举领袖'],
  [101, '识别疼痛与身体异常'],
  [103, '处理伤口并止血'],
  [106, '使用草药与经验性药物'],
  [108, '照护慢性病患者'],
  [113, '比较疗法并淘汰无效做法'],
  [119, '提供临终照护'],
  [121, '辨认可食与有毒之物'],
  [122, '寻找并净化饮水'],
  [126, '研磨、切割与混合食材'],
  [131, '喂养婴幼儿'],
  [132, '为病弱者准备特殊饮食'],
  [134, '交换食谱与烹饪技术'],
  [141, '选择安全的居住地点'],
  [143, '取暖、降温与通风'],
  [147, '修补住所'],
  [148, '维护炉灶与火源'],
  [149, '防范盗窃与侵入'],
  [150, '与邻居共享设施'],
  [160, '在住所毁坏后重建日常生活'],
  [161, '表达爱慕与建立伴侣关系'],
  [162, '拒绝或结束亲密关系'],
  [165, '确认或争议亲子身份'],
  [168, '分配父母与照护责任'],
  [169, '保护儿童免受伤害'],
  [171, '防止或制止家庭暴力'],
  [184, '寻求归属与被接纳'],
  [201, '用手势传达意图'],
  [222, '通过试错掌握技能'],
  [239, '让知识在代际传递中改变'],
  [240, '在学校或知识体系崩解后恢复教学'],
  [241, '记住个人经历'],
  [244, '形成集体记忆'],
  [248, '保存信件、器物与影像'],
  [252, '隐瞒、销毁或篡改记录'],
  [321, '选择适合用途的材料'],
  [322, '切割、打磨与钻孔'],
  [324, '编织、缝合与制绳'],
  [325, '制作陶器与容器'],
  [335, '保守或分享工艺秘密'],
  [337, '检查产品质量'],
  [341, '选择和保存种子'],
  [354, '管理森林采伐'],
  [384, '规划路线与行程'],
  [390, '装卸、仓储与分拣货物'],
  [392, '协调跨地域供应链'],
  [393, '应对道路阻断与运输延误'],
  [400, '在运输系统崩溃后恢复流通'],
  [401, '分派临时任务'],
  [405, '协调团队工作流程'],
  [420, '在组织解体后保存关键技能'],
  [421, '议价并形成交换比率'],
  [425, '形成品牌与商业信誉'],
  [461, '区分个人、家庭与共同财产'],
  [462, '赠与财物'],
  [466, '囤积稀缺物资'],
  [472, '救济无力维生者'],
  [486, '成立互助会'],
  [488, '欢迎新成员进入社区'],
  [499, '社区分裂与成员出走'],
  [500, '在迁移或灾害后重建社区网络'],
  [503, '制定组织章程'],
  [504, '选出或任命负责人'],
  [524, '通过协商形成共识'],
  [530, '记录并执行集体决定'],
  [551, '实施罚款、限制或监禁'],
  [553, '赦免或减轻处罚'],
  [604, '确认亲密关系中的同意'],
  [641, '防范盗窃与抢劫'],
  [642, '识别欺骗与诈骗'],
  [705, '因战争、迫害或灾害逃亡'],
  [736, '规划步行、自行车与公共交通'],
  [799, '恢复失传技术'],
  [802, '设计算法处理重复任务'],
  [805, '加密通信与保存信息'],
  [808, '进行电子支付与线上交易'],
  [824, '限制狩猎、采集与捕捞'],
  [841, '识别自然与人为危险'],
  [881, '识别无法依靠自身维生者'],
  [903, '因违约失去信任'],
  [931, '查明暴力发生的事实'],
  [949, '档案和专业知识散失'],
  [956, '重建交换和可信承诺'],
] as const satisfies readonly MapCatalogEntry[];

type StageCriteriaOverrides = Partial<CapabilityStageCriteria>;

type StrictMapSpec = readonly [
  capabilityId: number,
  domain: string,
  valence: MilestoneValence,
  phase: MilestonePhase,
  detector: DetectorKey,
  criteria?: StageCriteriaOverrides,
];

const STABLE_AGGREGATE = {
  minEpisodes: 1,
  minDistinctMonths: 2,
  minDistinctActors: 1,
  minEvidenceEvents: 2,
} as const;

const STRICT_MAP_SPECS = [
  [1, 'life', 'ambivalent', 'emergence', 'birth'],
  [2, 'life', 'ambivalent', 'emergence', 'conception'],
  [3, 'life', 'constructive', 'stable', 'dependent-care'],
  [5, 'health', 'harmful', 'emergence', 'illness'],
  [6, 'health', 'constructive', 'response', 'care'],
  [7, 'health', 'constructive', 'stable', 'repeated-care', STABLE_AGGREGATE],
  [8, 'life', 'ambivalent', 'decline', 'aging'],
  [9, 'life', 'ambivalent', 'collapse', 'death'],
  [11, 'subsistence', 'constructive', 'practice', 'gather-food'],
  [12, 'subsistence', 'ambivalent', 'practice', 'hunt'],
  [13, 'subsistence', 'constructive', 'practice', 'gift'],
  [14, 'mobility', 'ambivalent', 'practice', 'migration'],
  [16, 'craft', 'constructive', 'practice', 'tool-craft'],
  [17, 'craft', 'constructive', 'practice', 'fire-making'],
  [18, 'food', 'constructive', 'practice', 'cooking'],
  [19, 'craft', 'constructive', 'practice', 'clothing'],
  [20, 'home', 'constructive', 'emergence', 'shelter'],
  [22, 'coordination', 'constructive', 'stable', 'joint-project', {
    minEpisodes: 1, minDistinctMonths: 2, minDistinctActors: 2, minEvidenceEvents: 2,
  }],
  [32, 'agriculture', 'constructive', 'practice', 'cultivation'],
  [36, 'subsistence', 'harmful', 'harm', 'famine'],
  [42, 'mobility', 'constructive', 'practice', 'road'],
  [45, 'exchange', 'constructive', 'practice', 'exchange'],
  [48, 'norms', 'ambivalent', 'emergence', 'agreement'],
  [51, 'recording', 'constructive', 'emergence', 'writing'],
  [58, 'knowledge', 'constructive', 'practice', 'natural-observation'],
  [59, 'knowledge', 'constructive', 'practice', 'tested-hypothesis'],
  [106, 'health', 'constructive', 'practice', 'herbal-care'],
  [131, 'food', 'constructive', 'practice', 'infant-feeding'],
  [148, 'home', 'constructive', 'stable', 'fire-practice', STABLE_AGGREGATE],
  [149, 'home', 'constructive', 'response', 'theft-attempt'],
  [161, 'kinship', 'constructive', 'stable', 'companion', {
    minEpisodes: 1, minDistinctMonths: 2, minDistinctActors: 2, minEvidenceEvents: 2,
  }],
  [162, 'kinship', 'ambivalent', 'decline', 'relationship-rejection'],
  [169, 'kinship', 'constructive', 'response', 'dependent-protection'],
  [184, 'community', 'constructive', 'emergence', 'membership-belonging'],
  [201, 'communication', 'constructive', 'practice', 'gesture-communication'],
  [222, 'learning', 'constructive', 'stable', 'trial-learning', STABLE_AGGREGATE],
  [241, 'memory', 'ambivalent', 'practice', 'memory'],
  [244, 'memory', 'constructive', 'stable', 'shared-record', {
    minEpisodes: 1, minDistinctMonths: 2, minDistinctActors: 2, minEvidenceEvents: 2,
  }],
  [248, 'memory', 'constructive', 'practice', 'physical-record'],
  [324, 'craft', 'constructive', 'practice', 'rope-craft'],
  [325, 'craft', 'constructive', 'practice', 'container-practice'],
  [390, 'logistics', 'constructive', 'practice', 'storage'],
  [405, 'labor', 'constructive', 'stable', 'joint-project', {
    minEpisodes: 2, minDistinctMonths: 3, minDistinctActors: 2, minEvidenceEvents: 3,
  }],
  [462, 'property', 'constructive', 'practice', 'gift'],
  [488, 'community', 'constructive', 'emergence', 'membership-admission'],
  [499, 'community', 'harmful', 'collapse', 'collective-collapse'],
  [504, 'organization', 'ambivalent', 'practice', 'mandate'],
  [524, 'governance', 'constructive', 'stable', 'decision-rule', {
    minEpisodes: 1, minDistinctMonths: 1, minDistinctActors: 2, minEvidenceEvents: 2,
  }],
  [530, 'governance', 'constructive', 'practice', 'exercised-mandate'],
  [641, 'crime', 'constructive', 'response', 'theft-attempt'],
  [949, 'crisis', 'harmful', 'collapse', 'technique-loss'],
] as const satisfies readonly StrictMapSpec[];

type WorldSpecificSpec = readonly [
  key: string,
  label: string,
  domain: string,
  valence: MilestoneValence,
  phase: MilestonePhase,
  detector: DetectorKey,
  criteria?: StageCriteriaOverrides,
];

const WORLD_SPECIFIC_SPECS = [
  ['era-prediction', '人物提出恒乱纪元预言', 'three-body', 'ambivalent', 'emergence', 'prediction'],
  ['correct-era-prediction', '恒乱纪元预言应验', 'three-body', 'constructive', 'response', 'correct-prediction'],
  ['incorrect-era-prediction', '恒乱纪元预言未应验', 'three-body', 'ambivalent', 'decline', 'incorrect-prediction'],
  ['era-prediction-practice', '人物跨次检验恒乱纪元预言', 'three-body', 'constructive', 'stable', 'prediction-practice', STABLE_AGGREGATE],
  ['weather-change', '天气或气候变化发生', 'three-body', 'ambivalent', 'emergence', 'weather'],
  ['era-cycle', '恒纪元与乱纪元交替发生', 'three-body', 'ambivalent', 'stable', 'era-cycle', {
    minEpisodes: 1, minDistinctMonths: 2, minDistinctActors: 0, minEvidenceEvents: 2,
  }],
  ['theft-success', '未授权取物实际得手', 'world-event', 'harmful', 'harm', 'theft-success'],
  ['interpersonal-violence', '人际暴力造成伤害', 'world-event', 'harmful', 'harm', 'violence'],
  ['lethal-interpersonal-violence', '人际暴力导致死亡', 'world-event', 'harmful', 'collapse', 'lethal-violence'],
  ['restraint', '人物被绳索持续拘束', 'world-event', 'harmful', 'harm', 'restraint'],
  ['release-restraint', '人物的持续拘束被解除', 'world-event', 'constructive', 'recovery', 'release-restraint'],
  ['agreement-breach', '已接受的约定逾期未履行', 'world-event', 'harmful', 'harm', 'breach'],
  ['collective-withdrawal', '共同体成员主动退出', 'world-event', 'ambivalent', 'decline', 'collective-withdrawal'],
  ['collective-recovery', '共同体在成员退出后恢复活跃', 'world-event', 'constructive', 'recovery', 'collective-recovery'],
  ['project-breakdown', '项目因有来源的供给失败而阻塞', 'world-event', 'harmful', 'collapse', 'project-breakdown'],
  ['project-recovery', '项目在有来源失败后恢复并完成', 'world-event', 'constructive', 'recovery', 'project-recovery'],
  ['animal-attack', '野生动物袭击人物发生', 'world-event', 'harmful', 'harm', 'animal-attack'],
] as const satisfies readonly WorldSpecificSpec[];

function stageCriteriaFor(phase: MilestonePhase, overrides: StageCriteriaOverrides = {}): CapabilityStageCriteria {
  const defaults: CapabilityStageCriteria = phase === 'stable'
    ? { minEpisodes: 2, minDistinctMonths: 2, minDistinctActors: 1, minEvidenceEvents: 2, evidenceEpisodeLimit: 8 }
    : { minEpisodes: 1, minDistinctMonths: 1, minDistinctActors: 0, minEvidenceEvents: 1, evidenceEpisodeLimit: 1 };
  const criteria = { ...defaults, ...overrides };
  criteria.evidenceEpisodeLimit = Math.max(criteria.minEpisodes, criteria.evidenceEpisodeLimit);
  return criteria;
}

const strictMapByCapability = new Map<number, StrictMapSpec>(
  STRICT_MAP_SPECS.map((spec) => [spec[0], spec]),
);

function mapDefinition(entry: MapCatalogEntry): CapabilityMilestoneDefinition {
  const [capabilityId, mapLabel] = entry;
  const strict = strictMapByCapability.get(capabilityId);
  const domain = strict?.[1] ?? 'unsupported';
  const valence = strict?.[2] ?? 'ambivalent';
  const phase = strict?.[3] ?? 'emergence';
  const detector = strict?.[4] ?? 'guarded';
  return {
    id: 'capability:' + capabilityId + ':' + phase + ':' + detector + ':v2',
    catalogKind: 'map',
    capabilityId,
    mapLabel,
    label: mapLabel,
    domain,
    valence,
    phase,
    support: strict ? 'strict' : 'guarded',
    detector,
    causalConditions: CONDITIONS[detector],
    stageCriteria: stageCriteriaFor(phase, strict?.[5]),
    definitionVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
  };
}

function worldSpecificDefinition(spec: WorldSpecificSpec): CapabilityMilestoneDefinition {
  const [key, label, domain, valence, phase, detector, criteria] = spec;
  return {
    id: 'world:' + key + ':' + phase + ':' + detector + ':v2',
    catalogKind: 'world-specific',
    label,
    domain,
    valence,
    phase,
    support: 'strict',
    detector,
    causalConditions: CONDITIONS[detector],
    stageCriteria: stageCriteriaFor(phase, criteria),
    definitionVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
  };
}

export const CAPABILITY_MILESTONE_DEFINITIONS: readonly CapabilityMilestoneDefinition[] = Object.freeze([
  ...MAP_CATALOG.map(mapDefinition),
  ...WORLD_SPECIFIC_SPECS.map(worldSpecificDefinition),
]);

const MAX_REPLAYABLE_EVIDENCE_EVENTS = 64;

function meetsStageCriteria(
  episodes: Episode[],
  criteria: CapabilityStageCriteria,
  index: ObserverIndex,
): boolean {
  const evidenceIds = unique(episodes.flatMap((item) => item.evidenceEventIds));
  const months = new Set(evidenceIds.flatMap((eventId) => index.byId.get(eventId)?.atMonth ?? []));
  const actors = new Set(episodes.flatMap((item) => item.participantIds));
  return episodes.length >= criteria.minEpisodes
    && months.size >= criteria.minDistinctMonths
    && actors.size >= criteria.minDistinctActors
    && evidenceIds.length >= criteria.minEvidenceEvents;
}

function replayableEpisodesFor(
  candidates: Episode[],
  definition: CapabilityMilestoneDefinition,
  index: ObserverIndex,
): Episode[] {
  const selected: Episode[] = [];
  const evidenceIds = new Set<string>();
  const signatures = new Set<string>();
  const ordered = [...candidates].sort((left, right) => left.observedAtMonth - right.observedAtMonth
    || left.evidenceEventIds.join('|').localeCompare(right.evidenceEventIds.join('|')));
  for (const candidate of ordered) {
    const signature = [...candidate.evidenceEventIds].sort().join('|');
    if (signatures.has(signature)) continue;
    const newEvidenceIds = candidate.evidenceEventIds.filter((eventId) => !evidenceIds.has(eventId));
    if (!newEvidenceIds.length || evidenceIds.size + newEvidenceIds.length > MAX_REPLAYABLE_EVIDENCE_EVENTS) continue;
    signatures.add(signature);
    selected.push(candidate);
    newEvidenceIds.forEach((eventId) => evidenceIds.add(eventId));
    if (selected.length >= definition.stageCriteria.evidenceEpisodeLimit) break;
  }
  return meetsStageCriteria(selected, definition.stageCriteria, index) ? selected : [];
}

/**
 * Pure, replayable observer. Definitions are never exposed to planners and the
 * observer never mutates authoritative state.
 */
export function observeCapabilityMilestones(state: SimulationState): MilestoneObservation[] {
  const index = indexState(state);
  const cache = new Map<DetectorKey, Episode[]>();
  const episodesFor = (key: DetectorKey) => {
    const cached = cache.get(key);
    if (cached) return cached;
    const observed = detect(key, state, index).filter((item) => item.evidenceEventIds.length > 0
      && item.evidenceEventIds.every((eventId) => index.byId.has(eventId)));
    cache.set(key, observed);
    return observed;
  };

  const observations = CAPABILITY_MILESTONE_DEFINITIONS.flatMap((definition) => {
    if (definition.support !== 'strict') return [];
    const episodes = replayableEpisodesFor(episodesFor(definition.detector), definition, index);
    if (!episodes.length) return [];
    const observedAtMonth = Math.max(...episodes.map((item) => item.observedAtMonth));
    const evidenceEventIds = unique(episodes.flatMap((item) => item.evidenceEventIds));
    return [{
      id: definition.id,
      ...(definition.capabilityId === undefined ? {} : { capabilityId: definition.capabilityId }),
      catalogKind: definition.catalogKind,
      ...(definition.mapLabel === undefined ? {} : { mapLabel: definition.mapLabel }),
      label: definition.label,
      domain: definition.domain,
      valence: definition.valence,
      phase: definition.phase,
      observedAtMonth,
      participantIds: unique(episodes.flatMap((item) => item.participantIds)),
      affectedPersonIds: unique(episodes.flatMap((item) => item.affectedPersonIds)),
      occurrenceCount: episodes.length,
      evidenceEventIds,
      definitionVersion: definition.definitionVersion,
      note: `${definition.causalConditions.join('；')}。阶段门槛已验证，保留 ${episodes.length} 条完整可回放因果链。`,
    } satisfies MilestoneObservation];
  });

  return observations.sort((left, right) => (left.observedAtMonth ?? 0) - (right.observedAtMonth ?? 0)
    || (left.capabilityId ?? 0) - (right.capabilityId ?? 0)
    || left.id.localeCompare(right.id));
}
