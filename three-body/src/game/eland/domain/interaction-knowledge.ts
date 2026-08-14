import type { ActionFact, SimulationState } from './model';
import { materialDefinition, type MaterialId } from './material';
import type { PersonState } from './person';

const RELIABLE_NO_RESPONSE_CONFIDENCE = 55;

function sortedMaterialKey(materialIds: MaterialId[]): string {
  return [...materialIds].sort((a, b) => a - b).join('+');
}

export function inventoryNoResponseFactId(materialIds: MaterialId[]): string {
  return `observation:no-response:combine-inventory:${sortedMaterialKey(materialIds)}`;
}

export function voxelNoResponseFactId(
  operation: 'combine' | 'exert' | 'expose',
  inputMaterialId: MaterialId,
  targetMaterialId: MaterialId,
  toolMaterialId?: MaterialId,
): string {
  return `observation:no-response:${operation}:${toolMaterialId === undefined ? '' : `${toolMaterialId}:`}${inputMaterialId}:${targetMaterialId}`;
}

export function knowsReliableNoResponse(person: PersonState, factId: string): boolean {
  return person.knowledge.some((fact) => fact.id === factId && fact.confidence >= RELIABLE_NO_RESPONSE_CONFIDENCE);
}

function interactionFailure(fact: ActionFact): { id: string; summary: string } | null {
  if (fact.status !== 'blocked' || fact.action.kind !== 'act') return null;
  const materialIds = Array.isArray(fact.diff.inputMaterialIds)
    ? fact.diff.inputMaterialIds.filter((value): value is MaterialId => typeof value === 'number')
    : [];
  if (fact.action.operation === 'combine' && materialIds.length >= 2) return {
    id: inventoryNoResponseFactId(materialIds),
    summary: `观察到${materialIds.map((id) => materialDefinition(id).name).join('与')}结合时没有产生物质变化`,
  };
  const inputMaterialId = Number(fact.diff.inputMaterialId);
  const targetMaterialId = Number(fact.diff.targetMaterialId);
  if (!Number.isInteger(inputMaterialId) || !Number.isInteger(targetMaterialId)) return null;
  if (fact.action.operation === 'combine') return {
    id: voxelNoResponseFactId('combine', inputMaterialId, targetMaterialId),
    summary: `观察到${materialDefinition(inputMaterialId).name}与${materialDefinition(targetMaterialId).name}接触时没有产生物质变化`,
  };
  if (fact.action.operation === 'expose') return {
    id: voxelNoResponseFactId('expose', inputMaterialId, targetMaterialId),
    summary: `${materialDefinition(inputMaterialId).name}暴露于${materialDefinition(targetMaterialId).name}时没有产生物质变化`,
  };
  const toolMaterialId = Number(fact.diff.toolMaterialId);
  if (fact.action.operation !== 'exert' || !Number.isInteger(toolMaterialId)) return null;
  return {
    id: voxelNoResponseFactId('exert', inputMaterialId, targetMaterialId, toolMaterialId),
    summary: `用${materialDefinition(toolMaterialId).name}向${materialDefinition(inputMaterialId).name}施力时，${materialDefinition(targetMaterialId).name}没有产生物质变化`,
  };
}

/** 只有材料与距离前提已经满足、但不存在物质响应时，失败才成为可复用经验。 */
export function recordInteractionFailureKnowledge(state: SimulationState, fact: ActionFact): void {
  const failure = interactionFailure(fact);
  if (!failure) return;
  const person = state.people.find((candidate) => candidate.id === fact.who);
  if (!person) return;
  const known = person.knowledge.find((item) => item.id === failure.id);
  if (known) {
    known.confidence = Math.min(100, known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, fact.id])].slice(-24);
    return;
  }
  person.knowledge.push({
    id: failure.id,
    kind: 'observation',
    summary: failure.summary,
    confidence: 46,
    learnedAtMonth: fact.atMonth,
    sourceEventIds: [fact.id],
  });
}
