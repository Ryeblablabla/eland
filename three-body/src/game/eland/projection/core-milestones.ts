import type { ActionFact, MilestoneObservation, SimulationState, WorldEvent } from '../domain/model';
import { Material } from '../domain/material';
import { completedActionFacts, environmentFacts, worldEventById } from '../domain/event-index';

function actions(state: SimulationState): ActionFact[] {
  return [...completedActionFacts(state)];
}

function add(
  result: MilestoneObservation[],
  id: string,
  label: string,
  evidence: WorldEvent[],
  note: string,
): void {
  if (!evidence.length || result.some((milestone) => milestone.id === id)) return;
  result.push({ id, label, evidenceEventIds: evidence.map((event) => event.id), note });
}

/** Pure, replayable observers. These facts never feed back into agent decisions. */
export function observeCoreMilestones(state: SimulationState): MilestoneObservation[] {
  const result: MilestoneObservation[] = [];
  const completed = actions(state);
  const environment = [...environmentFacts(state)];

  const births = environment.filter((event) => typeof event.diff.bornPersonId === 'string');
  add(result, '1', '诞生', births, '妊娠过程经过月度结算后产生了有父母来源的新人物。');

  const dependentCare = completed.filter((event) => {
    if (event.action.kind === 'move' && Array.isArray(event.diff.carriedPersonIds)) {
      return event.diff.carriedPersonIds.some((id) => typeof id === 'string' && state.people.some((child) => child.id === id && child.geneticParents.includes(event.who) && event.atMonth - child.bornAtMonth < 12 * 12));
    }
    if (event.action.kind !== 'transfer' || event.action.to.kind !== 'person') return false;
    const childId = event.action.to.personId;
    const child = state.people.find((candidate) => candidate.id === childId);
    return Boolean(child && child.geneticParents.includes(event.who) && event.atMonth - child.bornAtMonth < 12 * 12);
  });
  const careKinds = new Set(dependentCare.map((event) => event.action.kind));
  add(result, '3', '养育幼儿', careKinds.has('move') && careKinds.has('transfer') ? dependentCare : [], '亲生父母既携带年幼孩子移动，也把真实物质转交给孩子满足生存需要。');

  const conceptions = completed.filter((event) => event.action.kind === 'act' && event.action.operation === 'reproduce' && event.diff.conceived === true);
  add(result, '2', '繁衍后代', conceptions, '双方同意后的生殖原语实际进入了妊娠过程。');

  const illnesses = environment.filter((event) => event.change === 'condition' && event.diff.condition === 'illness' && event.diff.exited !== true);
  add(result, '5', '生病', illnesses, '身体状态结算产生了有来源的疾病状态。');

  const care = completed.filter((event) => typeof event.diff.caredPersonId === 'string');
  add(result, '6', '医治伤病', care, '人物把具体材料作用于另一人的伤病，并改变了身体状态。');
  add(result, '7', '照料弱者', care, '人物对受伤或患病者实施了真实的近身照护。');

  const deaths = environment.filter((event) => event.change === 'death');
  add(result, '9', '死亡', deaths, '人物因身体耗尽或寿命终结而死亡，并留下私有物品。');

  const aging = environment.filter((event) => event.change === 'condition' && event.diff.condition === 'aging');
  add(result, '8', '衰老', aging, '年龄压力经过月度概率结算，使人物进入不可逆的衰老阶段。');

  const gifts = completed.filter((event) => event.action.kind === 'transfer'
    && event.action.from.kind === 'person'
    && event.action.to.kind === 'person'
    && event.action.from.personId !== event.action.to.personId
    && event.diff.authorized === true
    && !event.action.authorizationRef);
  add(result, '13', '分享资源', gifts, '持有者主动把私人背包中的物质转移给另一人。');

  const fulfilledAssistance = completed.filter((event) => {
    if (event.action.kind !== 'transfer' || event.action.to.kind !== 'person' || !event.intentId) return false;
    const intent = state.intents.find((candidate) => candidate.id === event.intentId);
    if (!intent) return false;
    const sources = new Set(intent.sourceFactIds ?? []);
    return [...sources].some((sourceId) => {
      const candidate = worldEventById(state, sourceId);
      return candidate?.kind === 'action'
      && candidate.action.kind === 'communicate'
      && candidate.action.content.kind === 'request'
      && candidate.action.content.proposal?.kind === 'assist';
    });
  });
  add(result, '22', '协同行动', fulfilledAssistance, '求助、接受和后续物质转移共同形成了跨人物行动链。');

  const famine = environment.filter((event) => event.change === 'body' && Number(event.diff.nutrition) < 10);
  add(result, '36', '遭遇饥荒', famine, '至少一人的营养储备跌入持续伤害区间。');

  const tools = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'combine'
    && ([Material.StoneTool, Material.BoneTool, Material.Spear] as number[]).includes(Number(event.diff.outputMaterialId)));
  add(result, '16', '制造工具', tools, '人物把真实材料结合为能改变后续操作或捕猎效果的私人工具。');

  const ignitions = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'exert'
    && Number(event.diff.outputMaterialId) === Material.Fire);
  add(result, '17', '掌控火种', ignitions, '人物用已有施力原语让工具和引火物发生物质响应，产生了真实火体素。');

  const cookedFood = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'expose'
    && Number(event.diff.outputMaterialId) === Material.CookedFood);
  add(result, '18', '烹饪食物', cookedFood, '人物让可食物质暴露于真实火体素，并取得可私有持有和摄入的熟食。');

  const clothing = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'combine'
    && ([Material.Clothing, Material.LeatherClothing] as number[]).includes(Number(event.diff.outputMaterialId)));
  add(result, '19', '制作衣物', clothing, '人物把真实纤维或兽皮与连接材料结合成私人持有的隔热衣物。');

  const herbalCare = completed.filter((event) => Number(event.diff.careMaterialId) === Material.HerbalMedicine);
  add(result, '106', '使用草药与经验性药物', herbalCare, '人物先制作草药，再把它用于具体伤病并改变身体状态。');

  const writtenRecords = completed.filter((event) => event.action.kind === 'communicate'
    && event.action.channel === 'record'
    && typeof event.diff.recordPayloadId === 'string');
  const recordReading = completed.filter((event) => event.action.kind === 'attend'
    && typeof event.diff.recordPayloadId === 'string'
    && event.diff.understood === true
    && writtenRecords.some((written) => written.who !== event.who && written.diff.recordPayloadId === event.diff.recordPayloadId));
  add(result, '51', '创造文字', recordReading.length ? [...writtenRecords, ...recordReading] : [], '一人把有来源的知识写入实体载体，并通过对话建立共同编码；另一人取得并读懂同一载体。');

  const collectiveEvidence = state.collectives.flatMap((collective) => collective.sourceEventIds)
    .flatMap((id) => worldEventById(state, id) ?? []);
  add(result, '29', '结成友谊与联盟', collectiveEvidence, '至少两人基于已有合作与事实信任，自愿接受持续共同体成员关系；身份可在以后退出或因死亡终止。');

  const consensusRules = state.collectives.flatMap((collective) => collective.decisionRules)
    .filter((rule) => rule.method === 'unanimous')
    .flatMap((rule) => rule.sourceEventIds)
    .flatMap((id) => worldEventById(state, id) ?? []);
  add(result, '524', '通过协商形成共识', consensusRules, '共同体成员分别接受了一项全体同意规则；该规则成为可持续产生后续授权的领域事实。');

  const exercisedMandates = state.collectives.flatMap((collective) => collective.mandates)
    .filter((mandate) => mandate.contributionEventIds.length > 0 && mandate.distributionEventIds.length > 0);
  const mandateEvidence = exercisedMandates.flatMap((mandate) => mandate.sourceEventIds)
    .flatMap((id) => worldEventById(state, id) ?? []);
  add(result, '61', '选出临时协调者', mandateEvidence, '成员按共同接受的规则授权一位具体成员，并由成员自愿交付、协调者再实际分配同一种物质。');

  const fireWarming = environment.filter((event) => event.change === 'condition'
    && event.diff.condition === 'cold'
    && event.diff.exited === true
    && event.diff.protectedByFire === true);
  add(result, '143', '取暖、降温与通风', fireWarming, '邻近火体素改变寒冷负荷，并使人物退出寒冷状态。');

  const verifiedTechniques = state.people.flatMap((person) => person.knowledge.filter((fact) => {
    if (fact.kind !== 'technique' || fact.confidence < 55) return false;
    const evidence = fact.sourceEventIds.flatMap((id) => worldEventById(state, id) ?? []);
    const successfulTrials = evidence.filter((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.action.kind === 'act'
      && (event.action.operation === 'combine' || event.action.operation === 'exert' || event.action.operation === 'expose' || event.action.operation === 'separate'));
    const activeVerification = evidence.some((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.action.kind === 'attend'
      && event.diff.verifiedTechnique === true);
    return successfulTrials.length >= 2 || (successfulTrials.length >= 1 && activeVerification);
  }));
  const experimentEvidence = [...new Set(verifiedTechniques.flatMap((fact) => fact.sourceEventIds))]
    .flatMap((id) => worldEventById(state, id) ?? []);
  add(result, '59', '用实验检验猜想', experimentEvidence, '人物通过复现实验，或观察核验一次试验产物，把暂定经验提升为可传播技术。');

  return result;
}
