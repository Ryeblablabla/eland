import type { ActionFact, MilestoneObservation, SimulationState, WorldEvent } from '../domain/model';
import { Material } from '../domain/material';

function actions(state: SimulationState): ActionFact[] {
  return state.world.past.filter((event): event is ActionFact => event.kind === 'action' && event.status === 'completed');
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
  const environment = state.world.past.filter((event) => event.kind === 'environment');

  const births = environment.filter((event) => typeof event.diff.bornPersonId === 'string');
  add(result, '1', '诞生', births, '妊娠过程经过月度结算后产生了有父母来源的新人物。');

  const conceptions = completed.filter((event) => event.action.kind === 'act' && event.action.operation === 'reproduce' && event.diff.conceived === true);
  add(result, '2', '繁衍后代', conceptions, '双方同意后的生殖原语实际进入了妊娠过程。');

  const illnesses = environment.filter((event) => event.change === 'condition' && event.diff.condition === 'illness' && event.diff.exited !== true);
  add(result, '5', '生病', illnesses, '身体状态结算产生了有来源的疾病状态。');

  const care = completed.filter((event) => typeof event.diff.caredPersonId === 'string');
  add(result, '6', '医治伤病', care, '人物把具体材料作用于另一人的伤病，并改变了身体状态。');
  add(result, '7', '照料弱者', care, '人物对受伤或患病者实施了真实的近身照护。');

  const deaths = environment.filter((event) => event.change === 'death');
  add(result, '9', '死亡', deaths, '人物因身体耗尽或寿命终结而死亡，并留下私有物品。');

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
    return state.world.past.some((candidate) => candidate.kind === 'action'
      && sources.has(candidate.id)
      && candidate.action.kind === 'communicate'
      && candidate.action.content.kind === 'request'
      && candidate.action.content.proposal?.kind === 'assist');
  });
  add(result, '22', '协同行动', fulfilledAssistance, '求助、接受和后续物质转移共同形成了跨人物行动链。');

  const famine = environment.filter((event) => event.change === 'body' && Number(event.diff.nutrition) < 10);
  add(result, '36', '遭遇饥荒', famine, '至少一人的营养储备跌入持续伤害区间。');

  const drinking = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'ingest'
    && event.action.targets.some((target) => target.kind === 'voxel')
    && Number(event.diff.materialId) === Material.Water);
  add(result, '122', '寻找并饮用水源', drinking, '人物移动到可达水岸，并从真实水体摄入水分。');

  const experiments = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'combine'
    && typeof event.diff.outputMaterialId === 'number');
  add(result, '59', '用实验检验物质组合', experiments, '人物执行局部物质组合并从实际结果形成 Technique。');

  const violence = completed.filter((event) => event.action.kind === 'act'
    && event.action.operation === 'exert'
    && typeof event.diff.victimId === 'string'
    && Number(event.diff.damage) > 0);
  add(result, '921', '发生利益或生存冲突', violence, '人物对另一人施力造成伤害，现场见证者形成关系证据。');

  return result;
}
