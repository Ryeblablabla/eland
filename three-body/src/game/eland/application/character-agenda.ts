import type { ActionOption, Intent, PrimitiveAction, WorldRef } from '../domain/action';
import {
  bindCharacterAgendaIntent,
  canReconsiderCharacterAgendaApproach,
  characterAgendaStateOf,
  reconcileCharacterAgendaApproach,
  transitionCharacterAgenda,
  upsertCharacterAgenda,
  type CharacterAgendaApproach,
  type CharacterAgendaApproachDisposition,
  type CharacterAgendaDecisionEvidence,
  type CharacterAgendaItem,
  type CharacterAgendaProbe,
  type CharacterAgendaProposal,
  type CharacterAgendaUpdate,
  type CharacterAgendaUpsertOutcome,
} from '../domain/character-agenda';
import { animalSpecies } from '../domain/animal';
import { cognitiveOutcomeBasisKey } from '../domain/cognition';
import { containerById } from '../domain/container';
import { materialDefinition } from '../domain/material';
import type { ActionFact, DecisionContext, SimulationState, WorldEvent } from '../domain/model';
import type { PersonState } from '../domain/person';
import { actionOptionSemantics, classifyActionOption } from '../domain/action-option-semantics';
import { intentById, personById, projectById } from '../domain/state-index';
import { agendaMemorySignals } from '../domain/agent-memory';
import { cellId, findStandingPath, voxelAt } from '../world/grid';

const MAX_AGENDA_EVIDENCE_SOURCES = 24;

export interface CompiledCharacterAgendaProposal {
  proposal: CharacterAgendaProposal;
  compilerDisposition: CharacterAgendaDecisionEvidence['compilerDisposition'];
  groundedProbe: boolean;
}

export interface AcceptedCharacterAgendaProposal {
  evidence: CharacterAgendaDecisionEvidence;
  item?: CharacterAgendaItem;
  approach?: CharacterAgendaApproach;
}

export interface AcceptedCharacterAgendaUpdate extends AcceptedCharacterAgendaProposal {
  operation: CharacterAgendaUpdate['kind'];
}

function coalesceMissingAffordance(
  items: readonly CharacterAgendaItem[],
  proposal: CharacterAgendaProposal,
): CharacterAgendaProposal {
  if (proposal.approach.disposition !== 'missing-affordance') return proposal;
  const proposalTopic = agendaTopic(`${proposal.aim}；${proposal.approach.summary}`);
  if (!proposalTopic) return proposal;
  const existing = [...items].reverse().find((item) => (
    item.theme === proposal.theme
      && item.status !== 'fulfilled'
      && item.status !== 'abandoned'
      && agendaTopic(`${item.aim}；${item.approaches.map((approach) => approach.summary).join('；')}`) === proposalTopic
      && item.approaches.some((approach) => approach.disposition === 'missing-affordance')
  ));
  const approach = [...(existing?.approaches ?? [])].reverse().find((candidate) => (
    candidate.disposition === 'missing-affordance'
  ));
  return existing && approach ? {
    ...proposal,
    basisKey: existing.basisKey,
    approach: {
      ...proposal.approach,
      basisKey: approach.basisKey,
    },
  } : proposal;
}

function agendaTopic(value: string): string | undefined {
  if (/住所|庇护|遮蔽|挡风|遮雨|挡雨|屋顶|顶棚|地基/u.test(value)) return 'shelter';
  if (/饮水|水源|取水|储水|蓄水|存水|留住水|水流|水洼|引水|挖沟|缺水/u.test(value)) return 'water';
  if (/食物|进食|生肉|熟食|烹饪|饥饿/u.test(value)) return 'food';
  if (/受伤|伤口|治疗|照护|疾病|恢复/u.test(value)) return 'care';
  if (/捕猎|狩猎|猛兽|狼|兔|鹿/u.test(value)) return 'hunting';
  if (/记录|知识|保存|教学|学习/u.test(value)) return 'knowledge';
  if (/储藏|仓库|库存|容器/u.test(value)) return 'storage';
  if (/高温|火|燃烧|烧制|冶炼/u.test(value)) return 'heat';
  if (/铜|锡|青铜|合金/u.test(value)) return 'copper-alloy';
  if (/铁|钢/u.test(value)) return 'iron';
  if (/动力|水轮|传动|供电|电力/u.test(value)) return 'power';
  if (/测量|比较重量|质量/u.test(value)) return 'measurement';
  if (/同伴|陪伴|交谈|关系|共同体/u.test(value)) return 'social';
  return undefined;
}

function relatedOpenAgenda(
  items: readonly CharacterAgendaItem[],
  aim: string,
  approachSummary: string,
): CharacterAgendaItem | undefined {
  const topic = agendaTopic(`${aim}；${approachSummary}`);
  if (!topic) return undefined;
  return [...items].reverse().find((item) => (
    item.status !== 'fulfilled'
      && item.status !== 'abandoned'
      && agendaTopic(`${item.aim}；${item.approaches.map((approach) => approach.summary).join('；')}`) === topic
  ));
}

function uniqueIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))]
    .slice(-MAX_AGENDA_EVIDENCE_SOURCES);
}

function boundedText(value: unknown, maximum: number): string {
  return (typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '').slice(0, maximum);
}

function probeEntitySourceFactIds(context: DecisionContext, probe: CharacterAgendaProbe | undefined): string[] {
  if (!probe) return [];
  if (probe.kind === 'world-interaction') {
    return uniqueIds(probe.adjudication.targets.flatMap((target) => {
      if (target.kind === 'inventory-stack' && target.personId === context.person.id) {
        return context.person.inventory.find((stack) => stack.id === target.stackId)?.sourceEventIds ?? [];
      }
      if (target.kind === 'drop') {
        return context.visibleDrops.find((drop) => drop.id === target.dropId)?.sourceEventIds ?? [];
      }
      if (target.kind === 'container') return containerById(context.state, target.containerId)?.sourceEventIds ?? [];
      if (target.kind === 'remains') {
        return (context.visibleRemains ?? []).find((remains) => remains.id === target.remainsId)?.sourceEventIds ?? [];
      }
      if (target.kind === 'person') {
        return [
          ...(context.person.relations.find((relation) => relation.personId === target.personId)?.sourceEventIds ?? []),
          ...context.person.memories.filter((memory) => memory.personIds.includes(target.personId)).flatMap((memory) => memory.sourceEventIds),
        ];
      }
      return [];
    }));
  }
  if (probe.kind === 'combine') {
    return uniqueIds(probe.ownStackIds.flatMap((stackId) => (
      context.person.inventory.find((stack) => stack.id === stackId)?.sourceEventIds ?? []
    )));
  }
  if (probe.kind === 'expose') {
    return uniqueIds(context.person.inventory.find((stack) => stack.id === probe.inputStackId)?.sourceEventIds ?? []);
  }
  if (probe.kind === 'exert') {
    return uniqueIds([
      ...(context.person.inventory.find((stack) => stack.id === probe.toolStackId)?.sourceEventIds ?? []),
      ...(context.person.inventory.find((stack) => stack.id === probe.inputStackId)?.sourceEventIds ?? []),
    ]);
  }
  if (probe.kind === 'move') return [];
  const target = probe.target;
  if (target.kind === 'own-inventory-stack') {
    return uniqueIds(context.person.inventory.find((stack) => stack.id === target.stackId)?.sourceEventIds ?? []);
  }
  if (target.kind === 'drop') {
    return uniqueIds(context.visibleDrops.find((drop) => drop.id === target.dropId)?.sourceEventIds ?? []);
  }
  if (target.kind === 'container') {
    return uniqueIds(containerById(context.state, target.containerId)?.sourceEventIds ?? []);
  }
  if (target.kind === 'remains') {
    return uniqueIds((context.visibleRemains ?? []).find((remains) => remains.id === target.remainsId)?.sourceEventIds ?? []);
  }
  if (target.kind === 'person') {
    const relationSources = context.person.relations.find((relation) => relation.personId === target.personId)?.sourceEventIds ?? [];
    const memorySources = context.person.memories
      .filter((memory) => memory.personIds.includes(target.personId))
      .flatMap((memory) => memory.sourceEventIds);
    return uniqueIds([...relationSources, ...memorySources]);
  }
  return [];
}

function stablePersonGroundingSourceIds(context: DecisionContext): string[] {
  const foundingOrOwnFact = context.state.world.past.find((event) => (
    (event.kind === 'environment'
      && event.change === 'founding'
      && Array.isArray(event.diff.participantIds)
      && event.diff.participantIds.includes(context.person.id))
      || ('who' in event && event.who === context.person.id)
  ));
  return uniqueIds([
    ...(context.person.origin?.sourceEventIds ?? []),
    ...(context.person.traits ?? []).flatMap((trait) => trait.sourceEventIds),
    ...context.person.memories.slice(-4).flatMap((memory) => memory.sourceEventIds),
    ...context.person.knowledge.slice(-4).flatMap((fact) => fact.sourceEventIds),
    ...(foundingOrOwnFact ? [foundingOrOwnFact.id] : []),
  ]);
}

function visibleVoxel(context: DecisionContext, position: { x: number; y: number; z: number }): boolean {
  const grid = context.state.world.grid;
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y) || !Number.isInteger(position.z)) return false;
  if (position.x < 0 || position.x >= grid.width || position.y < 0 || position.y >= grid.depth) return false;
  if (position.z < 0 || position.z >= grid.levels) return false;
  return context.visibleCells.includes(cellId(position.x, position.y));
}

function groundedObservationTarget(
  context: DecisionContext,
  target: Extract<CharacterAgendaProbe, { kind: 'observe' }>['target'],
): Extract<CharacterAgendaProbe, { kind: 'observe' }>['target'] | undefined {
  const visible = target.kind === 'voxel'
    ? visibleVoxel(context, target.position)
    : target.kind === 'own-inventory-stack'
      ? context.person.inventory.some((stack) => stack.id === target.stackId && stack.quantity > 0)
      : target.kind === 'drop'
        ? context.visibleDrops.some((drop) => drop.id === target.dropId && drop.quantity > 0)
        : target.kind === 'person'
          ? context.visiblePeople.some((person) => person.id === target.personId)
          : target.kind === 'animal'
            ? context.visibleAnimals.some((animal) => animal.id === target.animalId && animal.diedAtMonth === undefined)
            : target.kind === 'remains'
              ? (context.visibleRemains ?? []).some((remains) => remains.id === target.remainsId)
              : Boolean(containerById(context.state, target.containerId)
                && context.visibleCells.includes(cellId(
                  containerById(context.state, target.containerId)!.position.x,
                  containerById(context.state, target.containerId)!.position.y,
                )));
  return visible ? structuredClone(target) : undefined;
}

function groundedWorldRef(context: DecisionContext, target: WorldRef): boolean {
  if (target.kind === 'inventory-stack') {
    return target.personId === context.person.id
      && context.person.inventory.some((stack) => stack.id === target.stackId && stack.quantity > 0);
  }
  if (target.kind === 'voxel') return visibleVoxel(context, target.position);
  if (target.kind === 'drop') return context.visibleDrops.some((drop) => drop.id === target.dropId && drop.quantity > 0);
  if (target.kind === 'person') return target.personId === context.person.id
    || context.visiblePeople.some((person) => person.id === target.personId);
  if (target.kind === 'animal') {
    return context.visibleAnimals.some((animal) => animal.id === target.animalId && animal.diedAtMonth === undefined);
  }
  if (target.kind === 'remains') return (context.visibleRemains ?? []).some((remains) => remains.id === target.remainsId);
  const container = containerById(context.state, target.containerId);
  return Boolean(container && context.visibleCells.includes(cellId(container.position.x, container.position.y)));
}

function groundedProbe(context: DecisionContext, probe: CharacterAgendaProbe | undefined): CharacterAgendaProbe | undefined {
  if (!probe) return undefined;
  if (probe.kind === 'world-interaction') {
    const adjudication = probe.adjudication;
    if (adjudication.version !== 'world-adjudicated-interaction-v1'
      || !adjudication.request.trim()
      || !adjudication.result.trim()
      || adjudication.targets.length > 8
      || adjudication.targets.some((target) => !groundedWorldRef(context, target))) return undefined;
    const requested = new Set(adjudication.targets.map((target) => JSON.stringify(target)));
    const effectTargets = adjudication.effects.flatMap((effect) => (
      'target' in effect ? [effect.target] : []
    ));
    if (effectTargets.some((target) => !requested.has(JSON.stringify(target)))) return undefined;
    return structuredClone(probe);
  }
  if (probe.kind === 'combine') {
    const stackIds = [...new Set(probe.ownStackIds)];
    if (stackIds.length < 2 || stackIds.length > 3) return undefined;
    if (stackIds.some((stackId) => !context.person.inventory.some((stack) => stack.id === stackId && stack.quantity > 0))) return undefined;
    return stackIds.length === 2
      ? { kind: 'combine', ownStackIds: [stackIds[0], stackIds[1]] }
      : { kind: 'combine', ownStackIds: [stackIds[0], stackIds[1], stackIds[2]] };
  }
  if (probe.kind === 'expose') {
    return context.person.inventory.some((stack) => stack.id === probe.inputStackId && stack.quantity > 0)
      && visibleVoxel(context, probe.target.position)
      ? structuredClone(probe)
      : undefined;
  }
  if (probe.kind === 'exert') {
    return probe.toolStackId !== probe.inputStackId
      && context.person.inventory.some((stack) => stack.id === probe.toolStackId && stack.quantity > 0)
      && context.person.inventory.some((stack) => stack.id === probe.inputStackId && stack.quantity > 0)
      && visibleVoxel(context, probe.target.position)
      ? structuredClone(probe)
      : undefined;
  }
  if (probe.kind === 'move') {
    const destination = {
      cellId: cellId(probe.target.position.x, probe.target.position.y),
      z: probe.target.position.z + 1,
    };
    return visibleVoxel(context, probe.target.position)
      && findStandingPath(context.state.world.grid, context.person.position, destination).length > 0
      ? structuredClone(probe)
      : undefined;
  }
  return groundedObservationTarget(context, probe.target) ? structuredClone(probe) : undefined;
}

function containsForbiddenAuthorityClaim(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(materialId|output|outputMaterialId|expectedOutput|recipe|recipeId|rule|ruleId|knowledgeId|authorizationRef|mandateId|agreementId|civilizationIndex|stage)$/u.test(key)) {
      return true;
    }
    if (containsForbiddenAuthorityClaim(child, depth + 1)) return true;
  }
  return false;
}

function localDisposition(probe: CharacterAgendaProbe | undefined): CharacterAgendaApproachDisposition {
  if (!probe) return 'missing-affordance';
  return probe.kind === 'observe' ? 'observation-needed' : 'bounded-experiment';
}

function probeTargetLabel(
  context: DecisionContext,
  target: Extract<CharacterAgendaProbe, { kind: 'observe' }>['target'],
): string {
  if (target.kind === 'voxel') {
    return materialDefinition(voxelAt(
      context.state.world.grid,
      target.position.x,
      target.position.y,
      target.position.z,
    )).name;
  }
  if (target.kind === 'own-inventory-stack') {
    const materialId = context.person.inventory.find((stack) => stack.id === target.stackId)?.materialId;
    return materialId === undefined ? '手中物件' : materialDefinition(materialId).name;
  }
  if (target.kind === 'drop') {
    const materialId = context.visibleDrops.find((drop) => drop.id === target.dropId)?.materialId;
    return materialId === undefined ? '眼前地面物件' : materialDefinition(materialId).name;
  }
  if (target.kind === 'person') return context.visiblePeople.find((person) => person.id === target.personId)?.name ?? '眼前人物';
  if (target.kind === 'animal') {
    const speciesId = context.visibleAnimals.find((animal) => animal.id === target.animalId)?.speciesId;
    return speciesId ? animalSpecies(speciesId).name : '眼前动物';
  }
  if (target.kind === 'remains') {
    const remains = (context.visibleRemains ?? []).find((candidate) => candidate.id === target.remainsId);
    return remains ? `${personById(context.state, remains.personId)?.name ?? '死者'}的遗体` : '眼前遗体';
  }
  return '眼前容器';
}

function probeStackMaterialName(context: DecisionContext, stackId: string): string {
  const materialId = context.person.inventory.find((stack) => stack.id === stackId)?.materialId;
  return materialId === undefined ? '手中物件' : materialDefinition(materialId).name;
}

function canonicalProbeSummary(context: DecisionContext, probe: CharacterAgendaProbe): string {
  if (probe.kind === 'observe') return `观察${probeTargetLabel(context, probe.target)}，记录眼前实际状态`;
  if (probe.kind === 'world-interaction') return probe.adjudication.request;
  if (probe.kind === 'move') return `走向${probeTargetLabel(context, probe.target)}附近，看看沿途和抵达后会遇见什么`;
  if (probe.kind === 'combine') {
    return `把${probe.ownStackIds.map((stackId) => probeStackMaterialName(context, stackId)).join('与')}做一次小规模结合，记录是否发生变化`;
  }
  if (probe.kind === 'expose') {
    return `让${probeStackMaterialName(context, probe.inputStackId)}接触${probeTargetLabel(context, probe.target)}，记录是否发生变化`;
  }
  return `用${probeStackMaterialName(context, probe.toolStackId)}对${probeStackMaterialName(context, probe.inputStackId)}和${probeTargetLabel(context, probe.target)}施力，记录实际结果`;
}

/**
 * Turns imaginative text into a subjective, sourced concern. Only a currently
 * held or visible opaque ref survives as a physical probe; world facts and
 * expected outcomes are never accepted from the proposal.
 */
export function compileCharacterAgendaProposal(
  context: DecisionContext,
  raw: CharacterAgendaProposal,
  selectedOption?: ActionOption,
  allowExistingAction = false,
): CompiledCharacterAgendaProposal | null {
  const aim = boundedText(raw?.aim, 240);
  const theme = boundedText(raw?.theme, 80) || 'personal';
  const summary = boundedText(raw?.approach?.summary, 240);
  if (!aim || !summary) return null;
  const forbiddenAuthorityClaim = containsForbiddenAuthorityClaim(raw);
  const probe = forbiddenAuthorityClaim ? undefined : groundedProbe(context, raw.approach?.probe);
  const currentAgenda = characterAgendaStateOf(context.person, context.state.clock.elapsedMonths);
  const selectedProjectId = selectedOption?.projectId ?? selectedOption?.projectProposal?.id;
  const explicitAgendaItem = raw.basisKey
    ? currentAgenda.items.find((item) => item.basisKey === raw.basisKey)
    : undefined;
  const projectAgendaItem = !explicitAgendaItem && selectedProjectId
    ? [...currentAgenda.items].reverse().find((item) => (
        item.status !== 'fulfilled'
          && item.status !== 'abandoned'
          && item.projectIds.includes(selectedProjectId)
      ))
    : undefined;
  const relatedAgendaItem = explicitAgendaItem ?? (!raw.basisKey
    ? projectAgendaItem ?? relatedOpenAgenda(currentAgenda.items, aim, summary)
    : undefined);
  const existingAgendaItem = explicitAgendaItem ?? relatedAgendaItem;
  const effectiveBasisKey = raw.basisKey ?? relatedAgendaItem?.basisKey;
  const selectedActionContinuesExistingAgenda = existingAgendaItem
    ? selectedOption?.characterAgendaItemId === existingAgendaItem.id
      || Boolean(selectedProjectId && existingAgendaItem.projectIds.includes(selectedProjectId))
      || Boolean(relatedAgendaItem && selectedOption && optionDeservesDurableAgenda(selectedOption))
    : !selectedOption?.characterAgendaItemId;
  const selectedActionCanGroundDurableAgenda = Boolean(
    existingAgendaItem || (selectedOption && optionDeservesDurableAgenda(selectedOption)),
  );
  const selectedActionIsApproach = !forbiddenAuthorityClaim
    && !raw.approach?.probe
    && raw.approach?.disposition === 'executable-now'
    && Boolean(selectedOption)
    && selectedActionContinuesExistingAgenda
    && selectedActionCanGroundDurableAgenda;
  const disposition = forbiddenAuthorityClaim
    ? 'contradicted-approach'
    : (allowExistingAction || selectedActionIsApproach) && !raw.approach?.probe
      ? 'executable-now'
      : localDisposition(probe);
  const allowedMemorySourceIds = new Set(agendaMemorySignals(
    context.state,
    context.person,
    context.state.clock.elapsedMonths + 1,
  ).flatMap((memory) => memory.sourceEventIds));
  const sourceFactIds = uniqueIds([
    ...(raw.sourceFactIds ?? []).filter((sourceFactId) => allowedMemorySourceIds.has(sourceFactId)),
    ...(selectedOption?.sourceFactIds ?? []),
    ...probeEntitySourceFactIds(context, probe),
    ...stablePersonGroundingSourceIds(context),
  ]);
  if (!sourceFactIds.length) return null;
  return {
    proposal: {
      ...(effectiveBasisKey ? { basisKey: effectiveBasisKey } : {}),
      aim,
      theme,
      importance: Math.max(0, Math.min(100, Math.round(Number(raw.importance) || 50))),
      // A CharacterAgenda is specifically a durable concern. Shorter choices
      // belong to ordinary Intent; six months also leaves room for one factual
      // attempt plus the bounded three-month reconsideration window.
      horizonMonths: Math.max(6, Math.min(240, Math.round(Number(raw.horizonMonths) || 12))),
      sourceFactIds,
      approach: {
        ...(typeof raw.approach?.basisKey === 'string' && raw.approach.basisKey.trim()
          ? { basisKey: raw.approach.basisKey.trim() }
          : {}),
        // Imaginative strategy text remains a MentalAct, but an approach
        // classified as executable must name the exact locally selected
        // affordance. This prevents prose such as “接触久一点” from borrowing
        // an unrelated legal action and becoming operational state.
        summary: probe
          ? canonicalProbeSummary(context, probe)
          : disposition === 'executable-now' && selectedOption
            ? selectedOption.summary
            : summary,
        disposition,
        sourceFactIds,
        ...(probe ? { probe } : {}),
      },
    },
    compilerDisposition: forbiddenAuthorityClaim
      ? 'rejected-authority-claim'
      : disposition === 'executable-now'
        ? 'accepted-existing-action'
      : probe
        ? probe.kind === 'observe' ? 'accepted-observation' : 'accepted-experiment'
        : 'deferred-missing-affordance',
    groundedProbe: Boolean(probe),
  };
}

function evidenceFromResult(
  result: CharacterAgendaUpsertOutcome,
  compiled: CompiledCharacterAgendaProposal,
  source: 'model-proposal' | 'local-deliberation',
  item?: CharacterAgendaItem,
  approach?: CharacterAgendaApproach,
  operation?: CharacterAgendaUpdate['kind'],
): CharacterAgendaDecisionEvidence {
  return {
    version: 'character-agenda-decision-v1',
    source,
    outcome: result,
    compilerDisposition: compiled.compilerDisposition,
    aim: compiled.proposal.aim,
    sourceFactIds: [...(compiled.proposal.sourceFactIds ?? [])],
    ...(operation ? { operation } : {}),
    ...(item ? { agendaItemId: item.id } : {}),
    ...(approach ? { approachId: approach.id, approachDisposition: approach.disposition } : {}),
  };
}

export function acceptCharacterAgendaProposal(
  person: PersonState,
  context: DecisionContext,
  raw: CharacterAgendaProposal,
  selectedOption: ActionOption | undefined,
  atMonth: number,
  source: 'model-proposal' | 'local-deliberation',
): AcceptedCharacterAgendaProposal | null {
  const compiled = compileCharacterAgendaProposal(context, raw, selectedOption, source === 'local-deliberation');
  if (!compiled) return null;
  const current = characterAgendaStateOf(person, atMonth);
  const result = upsertCharacterAgenda(
    current,
    coalesceMissingAffordance(current.items, compiled.proposal),
    atMonth,
    source,
  );
  person.characterAgenda = result.state;
  return {
    evidence: evidenceFromResult(result.outcome, compiled, source, result.item, result.approach),
    ...(result.item ? { item: result.item } : {}),
    ...(result.approach ? { approach: result.approach } : {}),
  };
}

/**
 * Accepts an explicit subjective update. An upsert may remain incubating when
 * no local affordance compiles; lifecycle transitions only alter the person's
 * own durable concern and are still recorded against locally visible facts.
 */
export function acceptCharacterAgendaUpdate(
  person: PersonState,
  context: DecisionContext,
  update: CharacterAgendaUpdate,
  selectedOption: ActionOption | undefined,
  atMonth: number,
): AcceptedCharacterAgendaUpdate | null {
  if (update.kind === 'create' || update.kind === 'revise') {
    const compiled = compileCharacterAgendaProposal(context, update.proposal, selectedOption, false);
    if (!compiled) return null;
    const current = characterAgendaStateOf(person, atMonth);
    const result = upsertCharacterAgenda(
      current,
      coalesceMissingAffordance(current.items, compiled.proposal),
      atMonth,
      'model-proposal',
    );
    person.characterAgenda = result.state;
    return {
      operation: update.kind,
      evidence: evidenceFromResult(
        result.outcome,
        compiled,
        'model-proposal',
        result.item,
        result.approach,
        update.kind,
      ),
      ...(result.item ? { item: result.item } : {}),
      ...(result.approach ? { approach: result.approach } : {}),
    };
  }

  const current = characterAgendaStateOf(person, atMonth);
  const existing = current.items.find((item) => item.basisKey === update.basisKey);
  const sourceFactIds = uniqueIds([
    ...(existing?.sourceFactIds ?? []),
    ...stablePersonGroundingSourceIds(context),
  ]);
  const result = transitionCharacterAgenda(
    current,
    update.basisKey,
    update.kind,
    atMonth,
    sourceFactIds,
  );
  person.characterAgenda = result.state;
  const item = result.item ?? existing;
  return {
    operation: update.kind,
    evidence: {
      version: 'character-agenda-decision-v1',
      source: 'model-proposal',
      outcome: result.outcome,
      compilerDisposition: 'accepted-subjective-transition',
      operation: update.kind,
      aim: item?.aim ?? '未找到要调整的长期关切',
      sourceFactIds,
      ...(result.item ? { agendaItemId: result.item.id } : {}),
    },
    ...(result.item ? { item: result.item } : {}),
  };
}

function durationMonths(option: ActionOption): number {
  if (option.completionPolicy) return option.completionPolicy.durationMonths;
  if (option.estimatedMonths !== undefined) return option.estimatedMonths;
  if (option.estimatedDuration === 'long') return 24;
  if (option.estimatedDuration === 'several-months') return 6;
  return 1;
}

export function optionDeservesDurableAgenda(option: ActionOption): boolean {
  const purpose = actionOptionSemantics(option).purpose;
  return Boolean(
    option.projectId
    || option.projectProposal
    || option.recordUseBasis
    || purpose === 'mortuary-care'
    || option.estimatedDuration === 'long'
    || (option.estimatedMonths ?? 0) >= 6
    || (option.completionPolicy?.durationMonths ?? 0) >= 3
  );
}

export function localAgendaProposalForOption(option: ActionOption): CharacterAgendaProposal {
  const semantics = actionOptionSemantics(option);
  const projectKey = option.projectId ?? option.projectProposal?.id;
  const semanticBasis = cognitiveOutcomeBasisKey(option.completionAction ?? option.nextAction, option.goal);
  const horizonMonths = Math.max(2, Math.min(120, durationMonths(option)));
  return {
    basisKey: projectKey ? `local-project|${projectKey}` : `local-intent|${semanticBasis}`,
    aim: option.projectProposal?.summary ?? option.summary,
    theme: semantics.purpose,
    importance: semantics.obligation === 'commitment-action' ? 78 : option.projectId || option.projectProposal ? 68 : 58,
    horizonMonths,
    sourceFactIds: [...option.sourceFactIds],
    approach: {
      basisKey: `execute|${semanticBasis}`,
      summary: option.summary,
      disposition: 'executable-now',
      sourceFactIds: [...option.sourceFactIds],
    },
  };
}

export function bindAcceptedAgendaToIntent(
  person: PersonState,
  item: CharacterAgendaItem,
  approach: CharacterAgendaApproach,
  intent: Intent,
): boolean {
  const result = bindCharacterAgendaIntent(
    characterAgendaStateOf(person, intent.createdAtMonth),
    item.id,
    approach.id,
    intent.id,
    intent.projectId,
  );
  person.characterAgenda = result.state;
  if (!result.accepted) return false;
  intent.characterAgendaItemId = item.id;
  intent.characterAgendaApproachId = approach.id;
  return true;
}

function worldRefForObservation(person: PersonState, probe: Extract<CharacterAgendaProbe, { kind: 'observe' }>): WorldRef {
  const target = probe.target;
  return target.kind === 'own-inventory-stack'
    ? { kind: 'inventory-stack', personId: person.id, stackId: target.stackId }
    : structuredClone(target);
}

function observationFactId(context: DecisionContext, target: WorldRef): string {
  if (target.kind === 'voxel') return `material:${voxelAt(context.state.world.grid, target.position.x, target.position.y, target.position.z)}`;
  if (target.kind === 'inventory-stack') {
    const materialId = context.person.inventory.find((stack) => stack.id === target.stackId)?.materialId;
    return materialId === undefined ? `target:${JSON.stringify(target)}` : `material:${materialId}`;
  }
  if (target.kind === 'drop') {
    const materialId = context.visibleDrops.find((drop) => drop.id === target.dropId)?.materialId;
    return materialId === undefined ? `target:${JSON.stringify(target)}` : `target:${JSON.stringify(target)}`;
  }
  if (target.kind === 'animal') {
    const speciesId = context.visibleAnimals.find((animal) => animal.id === target.animalId)?.speciesId;
    return speciesId ? `animal:${animalSpecies(speciesId).id}` : `target:${JSON.stringify(target)}`;
  }
  return `target:${JSON.stringify(target)}`;
}

function actionForProbe(person: PersonState, probe: CharacterAgendaProbe): { action: PrimitiveAction; target?: WorldRef } {
  if (probe.kind === 'observe') {
    const target = worldRefForObservation(person, probe);
    return { action: { kind: 'attend', target }, target };
  }
  if (probe.kind === 'world-interaction') {
    return {
      action: { kind: 'world-interact', adjudication: structuredClone(probe.adjudication) },
      ...(probe.adjudication.targets[0] ? { target: structuredClone(probe.adjudication.targets[0]) } : {}),
    };
  }
  if (probe.kind === 'move') {
    const target: WorldRef = structuredClone(probe.target);
    return {
      action: {
        kind: 'move',
        toCellId: cellId(probe.target.position.x, probe.target.position.y),
        toZ: probe.target.position.z + 1,
      },
      target,
    };
  }
  if (probe.kind === 'combine') return {
    action: {
      kind: 'act',
      operation: 'combine',
      targets: probe.ownStackIds.map((stackId) => ({ kind: 'inventory-stack' as const, personId: person.id, stackId })),
    },
  };
  if (probe.kind === 'expose') return {
    action: {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: probe.inputStackId },
        structuredClone(probe.target),
      ],
    },
    target: structuredClone(probe.target),
  };
  return {
    action: {
      kind: 'act',
      operation: 'exert',
      toolStackId: probe.toolStackId,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: probe.inputStackId },
        structuredClone(probe.target),
      ],
    },
    target: structuredClone(probe.target),
  };
}

/** Compile a validated model tool call directly; one-turn experiments are not durable agenda items. */
export function buildImmediateCharacterProbeOption(
  context: DecisionContext,
  probeInput: CharacterAgendaProbe,
  optionId: string,
): ActionOption | undefined {
  const probe = groundedProbe(context, probeInput);
  if (!probe) return undefined;
  const compiled = actionForProbe(context.person, probe);
  const target = compiled.target;
  return classifyActionOption({
    id: optionId,
    summary: canonicalProbeSummary(context, probe),
    reason: '这是人物本轮选择的一次有界试验；结果只由真实世界响应决定',
    goal: probe.kind === 'observe'
      ? { kind: 'knowledge', factId: observationFactId(context, worldRefForObservation(context.person, probe)) }
      : probe.kind === 'move'
        ? { kind: 'at-cell', cellId: cellId(probe.target.position.x, probe.target.position.y) }
      : { kind: 'knowledge', factId: `attempt:${optionId}` },
    nextAction: compiled.action,
    ...(target ? { target } : {}),
    estimatedDuration: 'one-month',
    sourceFactIds: probeEntitySourceFactIds(context, probe),
    domain: 'strategic',
  });
}

export function buildCharacterAgendaOptions(context: DecisionContext, atMonth: number): ActionOption[] {
  const agenda = characterAgendaStateOf(context.person, atMonth);
  const options: ActionOption[] = [];
  for (const item of agenda.items) {
    if (item.status === 'fulfilled' || item.status === 'abandoned' || item.status === 'suspended') continue;
    for (const approach of item.approaches) {
      if (!approach.probe || !canReconsiderCharacterAgendaApproach(approach)) continue;
      if (approach.attemptIntentIds.length > approach.evaluations.length) continue;
      const probe = groundedProbe(context, approach.probe);
      if (!probe) continue;
      const compiled = actionForProbe(context.person, probe);
      const attemptOrdinal = approach.evaluations.length + 1;
      const target = compiled.target;
      options.push({
        id: `character-agenda:${item.id}:${approach.id}:${attemptOrdinal}`,
        summary: approach.summary,
        reason: `这次有限尝试服务于仍未解决的长期关切“${item.aim}”；结果由真实世界响应决定`,
        goal: probe.kind === 'observe'
          ? { kind: 'knowledge', factId: observationFactId(context, worldRefForObservation(context.person, probe)) }
          : probe.kind === 'move'
            ? { kind: 'at-cell', cellId: cellId(probe.target.position.x, probe.target.position.y) }
          : { kind: 'knowledge', factId: `attempt:${approach.id}:${attemptOrdinal}` },
        nextAction: compiled.action,
        ...(target ? { target } : {}),
        estimatedDuration: 'one-month',
        sourceFactIds: uniqueIds([...item.sourceFactIds, ...approach.sourceFactIds]),
        domain: 'strategic',
        characterAgendaItemId: item.id,
        characterAgendaApproachId: approach.id,
      });
    }
  }
  return options;
}

function samePosition(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function sameWorldRef(left: WorldRef, right: WorldRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'voxel' && right.kind === 'voxel') return samePosition(left.position, right.position);
  if (left.kind === 'drop' && right.kind === 'drop') return left.dropId === right.dropId;
  if (left.kind === 'container' && right.kind === 'container') return left.containerId === right.containerId;
  if (left.kind === 'inventory-stack' && right.kind === 'inventory-stack') return left.personId === right.personId && left.stackId === right.stackId;
  if (left.kind === 'animal' && right.kind === 'animal') return left.animalId === right.animalId;
  if (left.kind === 'remains' && right.kind === 'remains') return left.remainsId === right.remainsId;
  return left.kind === 'person' && right.kind === 'person' && left.personId === right.personId;
}

function actionMatchesProbe(person: PersonState, fact: ActionFact, probe: CharacterAgendaProbe): boolean {
  const expected = actionForProbe(person, probe).action;
  if (expected.kind !== fact.action.kind) return false;
  if (expected.kind === 'world-interact' && fact.action.kind === 'world-interact') {
    return expected.adjudication.request === fact.action.adjudication.request
      && expected.adjudication.targets.length === fact.action.adjudication.targets.length
      && expected.adjudication.targets.every((target, index) => (
        sameWorldRef(target, fact.action.kind === 'world-interact'
          ? fact.action.adjudication.targets[index]!
          : target)
      ));
  }
  if (expected.kind === 'attend' && fact.action.kind === 'attend') return sameWorldRef(expected.target, fact.action.target);
  if (expected.kind === 'move' && fact.action.kind === 'move') {
    return expected.toCellId === fact.action.toCellId && expected.toZ === fact.action.toZ;
  }
  if (expected.kind !== 'act' || fact.action.kind !== 'act' || expected.operation !== fact.action.operation) return false;
  if (expected.toolStackId !== fact.action.toolStackId) return false;
  return expected.targets.length === fact.action.targets.length
    && expected.targets.every((target) => fact.action.kind === 'act' && fact.action.targets.some((candidate) => sameWorldRef(target, candidate)));
}

function isInformationBearingNoResponse(fact: ActionFact): boolean {
  if (fact.status !== 'blocked' || fact.action.kind !== 'act') return false;
  if (fact.action.operation === 'combine') {
    return Array.isArray(fact.diff.inputMaterialIds)
      && fact.diff.inputMaterialIds.filter((value) => Number.isInteger(Number(value))).length >= 2;
  }
  if (fact.action.operation === 'expose') {
    return Number.isInteger(Number(fact.diff.inputMaterialId))
      && Number.isInteger(Number(fact.diff.targetMaterialId));
  }
  if (fact.action.operation === 'exert') {
    return Number.isInteger(Number(fact.diff.toolMaterialId))
      && Number.isInteger(Number(fact.diff.inputMaterialId))
      && Number.isInteger(Number(fact.diff.targetMaterialId));
  }
  return false;
}

function outcomeForFact(
  fact: ActionFact,
  probe: CharacterAgendaProbe,
): 'supported' | 'refuted' | 'blocked' | 'parked' | undefined {
  // Attention yields one grounded observation, not a causal conclusion. The
  // model must interpret that evidence in a later bounded review before a new
  // method can be called supported.
  if (fact.status === 'completed') return probe.kind === 'observe' ? 'parked' : 'supported';
  if (isInformationBearingNoResponse(fact)) return 'refuted';
  if (fact.status === 'blocked' || fact.status === 'failed') return 'blocked';
  return undefined;
}

function intentIsTerminal(intent: Intent): boolean {
  return intent.status === 'completed'
    || intent.status === 'blocked'
    || intent.status === 'failed'
    || intent.status === 'abandoned'
    || (intent.status === 'suspended' && intent.waitingFor === 'world-change');
}

function agendaAimWasObjectivelyFulfilled(
  item: CharacterAgendaItem | undefined,
  approach: CharacterAgendaApproach | undefined,
  intent: Intent,
): boolean {
  if (intent.goalOutcome?.kind !== 'achieved') return false;
  // Legacy local agendas used the executable option itself as their aim. A
  // model agenda may close only when it was bound to an already legal durable
  // option; a free-form probe merely validates or refutes one fallible method.
  return item?.origin === 'local-deliberation' || !approach?.probe;
}

function terminalIntentAgendaOutcome(intent: Intent): 'supported' | 'blocked' | 'parked' {
  if (intent.goalOutcome?.kind === 'achieved') return 'supported';
  if (intent.goalOutcome?.kind === 'attempted-unmet'
    || intent.status === 'blocked'
    || intent.status === 'failed') return 'blocked';
  return 'parked';
}

function normalizeApproachSummary(text: string): string {
  return text.replace(/[\s，。、；：？！""''（）《》〈〉—…·,.;:?!'"()[\]<>-]/gu, '');
}

/**
 * Conservative textual match between an incubating approach and a completed
 * free intent: exact equality after normalization, or the approach fully
 * contained in the intent phrasing ("取得石" inside "取得石并带回营地").
 * Short fragments under three characters never match.
 */
export function approachSummaryMatchesIntent(approachSummary: string, intentSummary: string): boolean {
  const approach = normalizeApproachSummary(approachSummary);
  const intent = normalizeApproachSummary(intentSummary);
  if (approach.length < 3 || !intent) return false;
  return approach === intent || intent.includes(approach);
}

/**
 * Runs before month facts commit so the committed ActionFact itself carries the
 * accepted agenda outcome. Action outcomes may expose frozen diff receipts, so
 * annotate by replacing the pending event rather than mutating a domain fact.
 * A failed approach changes the approach, never the aim.
 */
export function reconcileCharacterAgendasForMonth(
  state: SimulationState,
  events: WorldEvent[],
  atMonth: number,
): void {
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event.kind !== 'action' || !event.intentId) continue;
    const intent = intentById(state, event.intentId);
    if (!intent) continue;
    if (!intent.characterAgendaItemId || !intent.characterAgendaApproachId) {
      // A free model decision can demonstrably execute a means that an
      // incubating concern still labels "missing-affordance" (civilization 371:
      // Joan gathered stones twice while her "取得石" approach stayed frozen).
      // Retro-match the terminal intent to the semantically identical approach
      // so real success reopens the concern instead of leaving it incubating.
      const person = state.people.find((candidate) => candidate.id === event.who);
      if (!person || !intentIsTerminal(intent) || intent.actionEventIds.at(-1) !== event.id) continue;
      const terminalOutcome = terminalIntentAgendaOutcome(intent);
      if (terminalOutcome !== 'supported') continue;
      const agenda = characterAgendaStateOf(person, atMonth);
      const matched = agenda.items
        .filter((item) => item.status !== 'fulfilled' && item.status !== 'abandoned')
        .flatMap((item) => item.approaches
          .filter((approach) => approach.disposition === 'missing-affordance'
            || approach.disposition === 'waiting-for-evidence'
            || approach.disposition === 'observation-needed')
          .map((approach) => ({ item, approach })))
        .find(({ approach }) => approachSummaryMatchesIntent(approach.summary, intent.summary));
      if (!matched) continue;
      // A successful attend action proves that attention happened, not that
      // the larger concern or its causal story was supported. Even when an
      // older/unbound intent is retro-matched, park it after this one sample.
      const outcome = matched.approach.probe?.kind === 'observe' || event.action?.kind === 'attend'
        ? 'parked'
        : terminalOutcome;
      const evidence = intent.goalOutcome?.sourceEventIds?.length
        ? intent.goalOutcome.sourceEventIds
        : [event.id];
      const reconciled = reconcileCharacterAgendaApproach(
        agenda,
        matched.item.id,
        matched.approach.id,
        outcome,
        evidence,
        atMonth,
        `本人以独立意图完成了同一办法：${intent.summary}`,
      );
      person.characterAgenda = reconciled.state;
      if (reconciled.accepted) {
        events[eventIndex] = {
          ...event,
          diff: {
            ...event.diff,
            characterAgendaItemId: matched.item.id,
            characterAgendaApproachId: matched.approach.id,
            characterAgendaOutcome: outcome,
          },
        };
      }
      continue;
    }
    const currentAgenda = characterAgendaStateOf(state.people.find((person) => person.id === event.who) ?? { characterAgenda: undefined }, atMonth);
    const item = currentAgenda.items.find((candidate) => candidate.id === intent.characterAgendaItemId);
    const approach = item?.approaches.find((candidate) => candidate.id === intent.characterAgendaApproachId);
    const person = state.people.find((candidate) => candidate.id === event.who);
    if (!person || !item || !approach) continue;
    const annotatedEvent: ActionFact = {
      ...event,
      diff: {
        ...event.diff,
        characterAgendaItemId: item.id,
        characterAgendaApproachId: approach.id,
      },
    };
    events[eventIndex] = annotatedEvent;
    const terminalWithoutProbe = !approach.probe
      && intentIsTerminal(intent)
      && intent.actionEventIds.at(-1) === event.id;
    if (approach.probe && !actionMatchesProbe(person, event, approach.probe)) continue;
    if (!approach.probe && !terminalWithoutProbe) continue;
    const outcome = approach.probe
      ? outcomeForFact(event, approach.probe)
      : terminalWithoutProbe
        ? event.action.kind === 'attend' ? 'parked' : terminalIntentAgendaOutcome(intent)
        : undefined;
    if (!outcome) continue;
    const reconciled = reconcileCharacterAgendaApproach(
      currentAgenda,
      item.id,
      approach.id,
      outcome,
      [event.id],
      atMonth,
      event.result,
    );
    person.characterAgenda = reconciled.state;
    if (!reconciled.accepted) continue;
    if (agendaAimWasObjectivelyFulfilled(reconciled.item, reconciled.approach, intent)) {
      const fulfilled = person.characterAgenda.items.find((candidate) => candidate.id === item.id);
      if (fulfilled) fulfilled.status = 'fulfilled';
    }
    events[eventIndex] = {
      ...annotatedEvent,
      diff: { ...annotatedEvent.diff, characterAgendaOutcome: outcome },
    };
  }

  // Intents can terminate before emitting an ActionFact (for example because
  // a project is already blocked, its goal is already satisfied, or another
  // choice replaces it). Close that executable episode without erasing the
  // durable aim, otherwise a stale activeIntentId permanently suppresses the
  // next evidence-bearing approach.
  for (const person of state.people) {
    let agenda = characterAgendaStateOf(person, atMonth);
    for (const itemId of agenda.items.map((item) => item.id)) {
      const item = agenda.items.find((candidate) => candidate.id === itemId);
      if (!item) continue;
      if (!item.activeIntentId) continue;
      const intent = intentById(state, item.activeIntentId);
      if (!intent) {
        delete item.activeIntentId;
        delete item.activeApproachId;
        continue;
      }
      if (!intentIsTerminal(intent)) continue;
      const approach = item.activeApproachId
        ? item.approaches.find((candidate) => candidate.id === item.activeApproachId)
        : undefined;
      if (!approach) {
        delete item.activeIntentId;
        delete item.activeApproachId;
        continue;
      }
      // A bounded probe is evidence-bearing only when its matching ActionFact
      // was actually emitted and handled in the loop above. An already-known
      // goal can make an Intent complete immediately with only a DecisionFact;
      // that is not observation or experimental evidence and must never be
      // written back as support for the approach.
      const desiredOutcome = approach.probe ? 'parked' : terminalIntentAgendaOutcome(intent);
      const evidence = approach.probe ? [] : intent.goalOutcome?.sourceEventIds ?? [];
      const outcome = desiredOutcome !== 'parked' && evidence.length === 0 ? 'parked' : desiredOutcome;
      const reconciled = reconcileCharacterAgendaApproach(
        agenda,
        item.id,
        approach.id,
        outcome,
        evidence,
        atMonth,
        `可执行意图在没有新动作事实时以 ${intent.status} 结束`,
      );
      agenda = reconciled.state;
      if (agendaAimWasObjectivelyFulfilled(reconciled.item, reconciled.approach, intent)) {
        const fulfilled = agenda.items.find((candidate) => candidate.id === item.id);
        if (fulfilled) fulfilled.status = 'fulfilled';
      }
    }
    for (const item of agenda.items) {
      if (item.status === 'fulfilled' || item.status === 'abandoned' || item.status === 'suspended') continue;
      if (item.activeIntentId || atMonth <= item.targetAtMonth) continue;
      item.status = 'suspended';
      delete item.activeApproachId;
      item.lastReviewedAtMonth = atMonth;
    }
    person.characterAgenda = agenda;
  }
}

export function bindExistingAgendaIntent(person: PersonState, intent: Intent): boolean {
  if (!intent.characterAgendaItemId || !intent.characterAgendaApproachId) return false;
  const agenda = characterAgendaStateOf(person, intent.createdAtMonth);
  const item = agenda.items.find((candidate) => candidate.id === intent.characterAgendaItemId);
  const approach = item?.approaches.find((candidate) => candidate.id === intent.characterAgendaApproachId);
  return Boolean(item && approach && bindAcceptedAgendaToIntent(person, item, approach, intent));
}

export function activeAgendaProjectPressure(state: SimulationState, item: CharacterAgendaItem): number {
  return Math.max(0, ...item.projectIds.map((projectId) => projectById(state, projectId)?.pressure ?? 0));
}
