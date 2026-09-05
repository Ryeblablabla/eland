import type { DecisionRequestContext } from './decision-context';
import {
  buildDecisionProbeHandleMap,
  decisionVoxelKey,
  diverseOpenGroundingFacts,
  type DecisionProbeHandleMap,
} from './capability-handles';
import type { RecentDialogueContextLine } from './recent-dialogue';
import { buildCharacterTurnNote } from '../../domain/person-soul';

export interface CompactDecisionRequestContext {
  schemaVersion: 'decision-context-compact-v2';
  person: Record<string, unknown>;
  situation: Record<string, unknown>;
  recentDialogue: RecentDialogueContextLine[];
  commitments: Record<string, unknown>;
  options: Array<Record<string, unknown> & { id: string }>;
  followUpOptions: Array<Record<string, unknown> & { id: string }>;
  visible: Record<string, unknown>;
}

function agendaHandleForOption(
  context: DecisionRequestContext,
  option: DecisionRequestContext['options'][number],
  handles: DecisionProbeHandleMap,
): string | undefined {
  const agenda = (context.person.characterAgenda ?? []).find((item) => (
    item.id === option.characterAgendaItemId
    || Boolean(option.projectId && item.projectIds?.includes(option.projectId))
  ));
  return agenda
    ? handles.agendas.find((candidate) => candidate.itemId === agenda.id)?.handle
    : undefined;
}

function relevantPersonIds(options: readonly DecisionRequestContext['options'][number][]): Set<string> {
  const result = new Set<string>();
  for (const option of options) {
    if (option.target?.kind === 'person') result.add(option.target.personId);
    for (const personId of option.semantics.socialContext?.counterpartIds ?? []) result.add(personId);
  }
  return result;
}

function activatedSoulFacet(context: DecisionRequestContext) {
  const facets = context.person.soul.sceneFacets;
  const find = (id: typeof facets[number]['id']) => facets.find((facet) => facet.id === id) ?? facets[0];
  const needKinds = new Set(context.options.flatMap((option) => option.semantics.needKinds));
  const purposes = new Set(context.options.map((option) => option.semantics.purpose));
  if (context.activePressures.length || needKinds.has('safety') || needKinds.has('care') || needKinds.has('bereavement')) {
    return find('danger-and-loss');
  }
  if (context.options.some((option) => option.semantics.obligation === 'required-response'
    || option.semantics.reproduction?.phase === 'proposal'
    || option.semantics.reproduction?.phase === 'response')) {
    return find('autonomy-and-proposals');
  }
  if (context.activeIntent || context.activeProject || needKinds.has('commitment')
    || context.options.some((option) => option.semantics.obligation === 'commitment-action')) {
    return find('commitment-and-work');
  }
  if (needKinds.has('inquiry') || needKinds.has('capability') || purposes.has('inquiry')) {
    return find('uncertainty-and-change');
  }
  return find('trust-and-closeness');
}

function compactSpeechAct(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSpeechAct);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'version'
      && key !== 'basisKey'
      && key !== 'sourceFactIds'
      && key !== 'sourceEventIds'
      && key !== 'referenceEventId')
    .map(([key, item]) => [key, compactSpeechAct(item)]));
}

function compactTarget(
  target: DecisionRequestContext['options'][number]['target'],
  handles: DecisionProbeHandleMap,
): unknown {
  if (!target) return undefined;
  if (target.kind === 'voxel') {
    const handle = handles.voxels.find((item) => decisionVoxelKey(item.position) === decisionVoxelKey(target.position))?.handle;
    return handle ? { kind: 'voxel', handle } : { kind: 'voxel' };
  }
  if (target.kind === 'inventory-stack') {
    const handle = handles.held.find((item) => item.stackId === target.stackId)?.handle;
    return handle ? { kind: 'own-inventory-stack', handle } : { kind: 'inventory-stack' };
  }
  const visible = handles.visible.find((item) => (
    (target.kind === 'drop' && item.kind === 'drop' && item.dropId === target.dropId)
    || (target.kind === 'person' && item.kind === 'person' && item.personId === target.personId)
    || (target.kind === 'animal' && item.kind === 'animal' && item.animalId === target.animalId)
    || (target.kind === 'work' && item.kind === 'work' && item.workId === target.workId)
    || (target.kind === 'container' && item.kind === 'container' && item.containerId === target.containerId)
  ));
  if (visible) return { kind: target.kind, handle: visible.handle };
  return { kind: target.kind };
}

function compactSocialContext(
  value: NonNullable<DecisionRequestContext['options'][number]['semantics']['socialContext']>,
  personHandleById: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    cooperationKind: value.cooperationKind,
    phase: value.phase,
    counterparts: value.counterpartIds
      .map((personId) => personHandleById.get(personId))
      .filter((handle): handle is string => Boolean(handle)),
    ...(value.assistNeed ? { assistNeed: value.assistNeed } : {}),
    ...(value.conversationTopic ? { conversationTopic: value.conversationTopic } : {}),
    ...(value.projectKind ? { projectKind: value.projectKind } : {}),
  };
}

/** Preserve every executable choice; compression must not choose behaviours. */
export function compactDecisionOptionIndices(context: DecisionRequestContext): number[] {
  return context.options.map((_option, index) => index);
}

function compactFollowUpOptionIndices(
  context: DecisionRequestContext,
  selectedOptions: readonly DecisionRequestContext['options'][number][],
): number[] {
  const openingIds = new Set(selectedOptions.filter((option) => option.requiresFollowUp).map((option) => option.id));
  return context.followUpOptions.flatMap((option, index) => (
    option.matchesOptionIds.some((id) => openingIds.has(id)) ? [index] : []
  ));
}

/** Concise factual fields, with all distinct executable choices retained. */
export function buildCompactDecisionRequestContext(
  context: DecisionRequestContext,
  handles: DecisionProbeHandleMap = buildDecisionProbeHandleMap(context),
): CompactDecisionRequestContext {
  const selectedOptionIndices = compactDecisionOptionIndices(context);
  const selectedOptions = selectedOptionIndices.flatMap((index) => (
    context.options[index] ? [context.options[index]] : []
  ));
  const selectedFollowUpIndices = compactFollowUpOptionIndices(context, selectedOptions);
  const selectedFollowUps = selectedFollowUpIndices.flatMap((index) => (
    context.followUpOptions[index] ? [context.followUpOptions[index]] : []
  ));
  const relatedPeople = relevantPersonIds(selectedOptions);
  const expressedKnowledgeIds = new Set(selectedOptions.flatMap((option) => (
    option.expressesFactId ? [option.expressesFactId] : []
  )));
  const expressedKnowledge = context.person.knowledge
    .filter((item) => expressedKnowledgeIds.has(item.id))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
  const knowledge = [
    ...expressedKnowledge,
    ...context.person.knowledge
      .filter((item) => !expressedKnowledgeIds.has(item.id))
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, 3 - expressedKnowledge.length)),
  ];
  const knowledgeHandleById = new Map(knowledge.map((item, index) => [item.id, `k${index + 1}`]));
  const optionHandleById = new Map(context.options.map((option, index) => [option.id, `o${index + 1}`]));
  const memories = [...context.person.memories]
    .sort((left, right) => Number(right.personIds.some((id) => relatedPeople.has(id))) - Number(left.personIds.some((id) => relatedPeople.has(id)))
      || right.salience - left.salience
      || right.lastExperiencedAtMonth - left.lastExperiencedAtMonth)
    .slice(0, 3);
  const memoryHandleById = new Map(handles.memories.map((memory) => [memory.itemId, memory.handle]));
  const selectedMemoryKeys = new Set(memories.map((memory) => (
    memory.gist
  )));
  const selectedKnowledgeIds = new Set(knowledge.map((item) => item.id));
  const compactGroundingFacts: DecisionProbeHandleMap['groundingFacts'] = [];
  for (const option of selectedOptions) {
    const facts = diverseOpenGroundingFacts(option.openConversationGrounding?.facts.filter((fact) => (
      fact.kind === 'relationship'
        || fact.kind === 'memory'
          && selectedMemoryKeys.has(fact.summary)
        || fact.kind === 'knowledge'
          && Boolean(fact.knowledgeId && selectedKnowledgeIds.has(fact.knowledgeId))
    )) ?? []);
    for (const fact of facts) compactGroundingFacts.push({
      handle: `q${compactGroundingFacts.length + 1}`,
      optionId: option.id,
      sourceFactId: fact.sourceFactId,
      kind: fact.kind,
      summary: fact.summary,
    });
  }
  handles.groundingFacts = compactGroundingFacts;
  const visiblePersonHandleById = new Map(handles.visible.flatMap((item) => (
    item.kind === 'person' ? [[item.personId, item.handle] as const] : []
  )));
  const visiblePeople = [...context.visiblePeople]
    .sort((left, right) => Number(relatedPeople.has(right.id)) - Number(relatedPeople.has(left.id))
      || Math.max(Math.abs(right.trust), Math.abs(right.bond), Math.abs(right.fear))
        - Math.max(Math.abs(left.trust), Math.abs(left.bond), Math.abs(left.fear))
      || left.id.localeCompare(right.id))
    .slice(0, Math.max(4, relatedPeople.size))
    .map(({ id, name, ageMonths: age, sex, health, hydration, nutrition, conditions, cellId, z, trust, bond, fear }) => ({
      handle: visiblePersonHandleById.get(id), name, ageMonths: age, sex, health, hydration, nutrition,
      conditions: conditions.map(({ kind, stage }) => ({ kind, stage })),
      cellId, z, trust, bond, fear,
    }));
  const soul = context.person.soul;
  const experience = context.person.experience ?? {
    version: 'person-experience-layer-v1' as const,
    authority: 'sourced-memory-and-learning' as const,
    adaptivePersonality: {
      version: 'adaptive-personality-v1' as const,
      authority: 'sourced-experience' as const,
      effectivePersonality: context.person.personality,
      styleMatrix: soul.styleMatrix,
      learnedShifts: [],
      rule: '没有可用的有来源人格变化。',
    },
    activeCues: [],
    rule: '没有可用的有来源经历 cue。',
  };
  const activeFacet = activatedSoulFacet(context);
  const characterNote = buildCharacterTurnNote(soul, experience, activeFacet.id);
  const { styleMatrix: currentDelivery, ...adaptivePersonality } = experience.adaptivePersonality;
  const targetedDrops = new Set([...selectedOptions, ...selectedFollowUps].flatMap((option) => (
    option.target?.kind === 'drop' ? [option.target.dropId] : []
  )));
  const targetedAnimals = new Set([...selectedOptions, ...selectedFollowUps].flatMap((option) => (
    option.target?.kind === 'animal' ? [option.target.animalId] : []
  )));
  const targetedContainers = new Set([...selectedOptions, ...selectedFollowUps].flatMap((option) => (
    option.target?.kind === 'container' ? [option.target.containerId] : []
  )));
  return {
    schemaVersion: 'decision-context-compact-v2',
    person: {
      id: context.person.id,
      name: context.person.name,
      ageMonths: context.person.ageMonths,
      sex: context.person.sex,
      body: context.person.body,
      conditions: context.person.conditions.map(({ kind, stage }) => ({ kind, stage })),
      capacities: context.person.capacities,
      personality: context.person.personality,
      personalityType: context.person.personalityType,
      motiveSensitivity: context.person.motiveSensitivity,
      soul: {
        innerVoice: soul.innerVoice,
        ...(soul.prototype ? { prototypeSummary: soul.prototype.personalitySummary } : {}),
      },
      characterNote,
      experience: {
        ...experience,
        adaptivePersonality: {
          ...adaptivePersonality,
          currentDelivery,
          learnedShifts: experience.adaptivePersonality.learnedShifts.map(({ sourceEventIds, ...shift }) => ({
            ...shift,
            sourceCount: sourceEventIds.length,
          })),
        },
        activeCues: experience.activeCues.map(({ memoryIds, sourceEventIds, ...cue }) => ({
          ...cue,
          memoryHandles: memoryIds.flatMap((itemId) => {
            const handle = memoryHandleById.get(itemId);
            return handle ? [handle] : [];
          }),
          sourceCount: sourceEventIds.length,
        })),
      },
      position: context.person.position,
      mindMarkdown: context.person.mindMarkdown,
      inventory: context.person.inventory.map(({ stackId, name, properties, quantity }) => ({
        handle: handles.held.find((item) => item.stackId === stackId)?.handle,
        name,
        properties,
        quantity,
      })),
      knowledge: knowledge.map(({ id, ...item }) => ({ id: knowledgeHandleById.get(id) ?? id, ...item })),
      memories: memories.map(({ id, lane, gist, precision, confidence, salience, emotionalValence, unresolved, personIds, exactUtterance }) => ({
        ...(memoryHandleById.get(id) ? { handle: memoryHandleById.get(id) } : {}),
        lane,
        gist,
        precision,
        confidence,
        salience,
        emotionalValence,
        unresolved,
        personIds,
        ...(exactUtterance ? { exactUtterance } : {}),
      })),
      recentMentalActs: context.person.recentMentalActs,
      relationshipEpisodes: context.person.relationshipEpisodes,
      kinship: {
        parents: context.person.kinship.parents.map(({ name, sex, relation }) => ({ name, sex, relation })),
        children: context.person.kinship.children.map(({ name, sex, relation }) => ({ name, sex, relation })),
        siblings: context.person.kinship.siblings.map(({ name, sex, relation, fullSibling }) => ({
          name, sex, relation, fullSibling,
        })),
      },
    },
    situation: {
      month: context.clock.elapsedMonths,
      ...(context.clock.planningTick !== undefined ? { planningTick: context.clock.planningTick } : {}),
      climate: context.climate,
      epoch: context.epoch,
      weather: context.weather,
      sheltered: context.sheltered,
      activePressures: context.activePressures,
    },
    recentDialogue: (context.recentDialogue ?? []).slice(0, 4),
    commitments: {
      recentCompletedWork: context.recentCompletedWork ?? [],
      ...(context.activeIntent ? { activeIntent: context.activeIntent } : {}),
      ...(context.activeProject ? { activeProject: {
        summary: context.activeProject.summary,
        need: context.activeProject.need,
        status: context.activeProject.status,
        lastProgressAtMonth: context.activeProject.lastProgressAtMonth,
        contributorCount: context.activeProject.contributorIds.length,
        materialPlan: context.activeProject.materialPlan.status === 'verified'
          ? {
              status: 'verified',
              desiredFunction: context.activeProject.materialPlan.desiredFunction,
              missingMaterials: context.activeProject.materialPlan.missingMaterials,
              reservationCount: context.activeProject.materialPlan.reservations.length,
            }
          : context.activeProject.materialPlan,
      } } : {}),
      characterAgenda: (context.person.characterAgenda ?? []).slice(0, 4).map(({ id, aim, theme, importance, horizonMonths, targetAtMonth, createdAtMonth, status, lastReviewedAtMonth, approaches }) => ({
        handle: handles.agendas.find((candidate) => candidate.itemId === id)?.handle,
        aim, theme, importance, horizonMonths, targetAtMonth, createdAtMonth, status, lastReviewedAtMonth,
        approaches: approaches.slice(0, 2).map(({ summary, disposition, latestOutcome, evaluationCount, recentEvaluations }) => ({
          summary, disposition, evaluationCount, recentEvaluations, ...(latestOutcome ? { latestOutcome } : {}),
        })),
      })),
      suspendedIntents: context.suspendedIntents.map((intent) => ({
        handle: handles.suspendedIntents.find((candidate) => candidate.intentId === intent.id)?.handle,
        summary: intent.summary,
        progress: intent.progress,
        nextActionKind: intent.nextActionKind,
        createdAtMonth: intent.createdAtMonth,
        lastProgressAtMonth: intent.lastProgressAtMonth,
        ...(intent.waitingFor ? { waitingFor: intent.waitingFor } : {}),
        ...(intent.plan ? { plan: intent.plan } : {}),
        ...(intent.recentOutcomes ? { recentOutcomes: intent.recentOutcomes } : {}),
      })),
      agreements: context.agreements.slice(0, 3).map((agreement) => ({
        kind: agreement.kind,
        status: agreement.status,
        proposedAtMonth: agreement.proposedAtMonth,
        pendingResponderNames: agreement.pendingResponderNames,
        ...(agreement.dueAtMonth !== undefined ? { dueAtMonth: agreement.dueAtMonth } : {}),
        requiresOwnResponse: agreement.requiredResponderIds.includes(context.person.id),
        acceptedBySelf: agreement.acceptedByPersonIds.includes(context.person.id),
        rejectedBySelf: agreement.rejectedByPersonIds.includes(context.person.id),
        electorateCount: agreement.partyIds.length,
        supportCount: agreement.acceptedByPersonIds.length,
        oppositionCount: agreement.rejectedByPersonIds.length,
        fulfilledBySelf: agreement.fulfilledByPersonIds.includes(context.person.id),
      })),
      collectives: context.collectives.slice(0, 1).map(({ purposeSummary, status, activeMemberIds, decisionRules, mandates }) => ({
        purposeSummary, status, activeMemberCount: activeMemberIds.length,
        decisionRules: decisionRules.slice(0, 2).map(({ method, scope, projectDuty }) => ({
          method, scope, ...(projectDuty ? { projectDuty } : {}),
        })),
        ownMandates: mandates.filter((mandate) => mandate.holderId === context.person.id).slice(0, 2)
          .map(({ validUntilMonth, status }) => ({ validUntilMonth, status })),
      })),
    },
    options: selectedOptionIndices.map((index) => context.options[index]).filter((option): option is DecisionRequestContext['options'][number] => Boolean(option)).map((option) => ({
      // Keep the original request index so the gateway cannot expand a short
      // list position into the wrong authoritative option.
      id: optionHandleById.get(option.id)!,
      ...(agendaHandleForOption(context, option, handles) ? {
        agendaHandle: agendaHandleForOption(context, option, handles),
      } : {}),
      summary: option.summary,
      reason: option.reason.slice(0, 180),
      ...(option.domain ? { domain: option.domain } : {}),
      ...(option.estimatedMonths !== undefined ? { estimatedMonths: option.estimatedMonths } : {}),
      ...(option.risks?.length ? { risks: option.risks.slice(0, 2) } : {}),
      ...(option.target ? { target: compactTarget(option.target, handles) } : {}),
      ...(option.requiresFollowUp ? { requiresFollowUp: true } : {}),
      semantics: {
        obligation: option.semantics.obligation,
        planningChannel: option.semantics.planningChannel,
        purpose: option.semantics.purpose,
        needKinds: option.semantics.needKinds.slice(0, 3),
        ...(option.semantics.conversation ? { conversation: option.semantics.conversation } : {}),
        ...(option.semantics.reproduction ? { reproduction: option.semantics.reproduction } : {}),
        ...(option.semantics.socialContext ? {
          socialContext: compactSocialContext(option.semantics.socialContext, visiblePersonHandleById),
        } : {}),
      },
      ...(option.experiencedOutcomes ? { experiencedOutcomes: option.experiencedOutcomes } : {}),
      ...(option.communicationKind ? { communicationKind: option.communicationKind } : {}),
      ...(option.speechAct ? { speechAct: compactSpeechAct(option.speechAct) } : {}),
      ...(option.expressesFactId ? {
        expressesKnowledgeId: knowledgeHandleById.get(option.expressesFactId) ?? option.expressesFactId,
      } : {}),
      ...(option.openConversationGrounding ? {
        groundingFacts: handles.groundingFacts
          .filter((fact) => fact.optionId === option.id)
          .map(({ handle, kind, summary }) => ({ handle, kind, summary })),
      } : {}),
      ...(option.socialHistory ? { socialHistory: {
        rememberedBefore: option.socialHistory.rememberedBefore,
        hasNewEvidence: option.socialHistory.hasNewEvidence,
        ...(option.socialHistory.outcome ? { outcome: option.socialHistory.outcome } : {}),
      } } : {}),
    })),
    followUpOptions: selectedFollowUpIndices.map((index) => ({ index, option: context.followUpOptions[index] }))
      .filter((item): item is { index: number; option: DecisionRequestContext['followUpOptions'][number] } => Boolean(item.option))
      .map(({ index, option: { summary, reason, domain, estimatedMonths, risks, target, semantics } }) => ({
      id: `f${index + 1}`, summary, reason: reason.slice(0, 180),
      ...(domain ? { domain } : {}),
      ...(estimatedMonths !== undefined ? { estimatedMonths } : {}),
      ...(risks?.length ? { risks: risks.slice(0, 1) } : {}),
      ...(target ? { target: compactTarget(target, handles) } : {}),
      purpose: semantics.purpose,
    })),
    visible: {
      people: visiblePeople,
      drops: [...context.visibleDrops]
        .sort((left, right) => Number(targetedDrops.has(right.id)) - Number(targetedDrops.has(left.id))
          || right.quantity - left.quantity || left.id.localeCompare(right.id))
        .slice(0, Math.max(4, targetedDrops.size)).map(({ id, name, properties, quantity, cellId, z }) => ({
        handle: handles.visible.find((item) => item.kind === 'drop' && item.dropId === id)?.handle,
        name, properties, quantity, cellId, z,
      })),
      animals: [...context.visibleAnimals]
        .sort((left, right) => Number(targetedAnimals.has(right.id)) - Number(targetedAnimals.has(left.id))
          || left.id.localeCompare(right.id))
        .slice(0, Math.max(2, targetedAnimals.size)).map(({ id, speciesId, cellId, z, health, hunger }) => ({
        handle: handles.visible.find((item) => item.kind === 'animal' && item.animalId === id)?.handle,
        speciesId, cellId, z, health, hunger,
      })),
      containers: [...context.visibleContainers]
        .sort((left, right) => Number(targetedContainers.has(right.id)) - Number(targetedContainers.has(left.id))
          || left.id.localeCompare(right.id))
        .slice(0, Math.max(2, targetedContainers.size)).map(({ id, contents, ...container }) => ({
        handle: handles.visible.find((item) => item.kind === 'container' && item.containerId === id)?.handle,
        ...container,
        contents: contents.slice(0, 3),
      })),
    },
  };
}
