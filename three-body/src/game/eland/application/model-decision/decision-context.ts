import { materialDefinition } from '../../domain/material';
import { perceiveMaterial, type PerceivedMaterialProfile } from '../../domain/material-perception';
import { ageMonths } from '../../domain/person';
import {
  retrieveAgentMemories,
  type RecalledMemory,
} from '../../domain/agent-memory';
import { effectivePersonality } from '../../domain/personality';
import type { DecisionContext } from '../../simulation';
import { CONTAINER_CAPACITY } from '../../domain/container';
import { assessSocialRepetition } from '../../domain/social-repetition';
import { buildPersonExperienceLayer, buildPersonSoul } from '../../domain/person-soul';
import { cognitionStateOf, outcomeBeliefSuccess } from '../../domain/cognition';
import { buildCognitiveFrame } from '../cognition/option-appraisal';
import { speechActFromRepresentation } from '../../projection/speech-act';
import type {
  SpeechActView,
  SpeechLineView,
} from '../../../societyContract';
import { traitDefinition, traitStatesOf } from '../../domain/trait';
import { relationTo } from '../../domain/relation';
import { actionOptionSemantics } from '../../domain/action-option-semantics';
import { followUpSemanticallyMatches } from '../../domain/intent-follow-up';
import { projectMaterialPlanProvenance } from '../projects/project-material-provenance';
import type { CharacterAgendaItem } from '../../domain/character-agenda';
import type { MentalAct } from '../../domain/mental-act';
import { cellX, cellY, surfaceMaterial, topPosition } from '../../world/grid';
import {
  decisionCounterpartIds,
  recentDialogueForDecision,
  type RecentDialogueContextLine,
} from './recent-dialogue';

function perceivedProperties(profile: PerceivedMaterialProfile): string[] {
  return [...new Set([
    profile.phase,
    profile.form,
    profile.appearance,
    ...(profile.loadBand ? [profile.loadBand] : []),
    ...(profile.rigidity ? [profile.rigidity] : []),
  ])];
}

export interface DecisionRequestContext {
  person: {
    id: string;
    name: string;
    description: string;
    ageMonths: number;
    sex: DecisionContext['person']['sex'];
    body: DecisionContext['person']['body'];
    conditions: DecisionContext['person']['conditions'];
    capacities: DecisionContext['person']['baselineCapacities'];
    traits: Array<{ id: string; name: string; description: string }>;
    personality: ReturnType<typeof effectivePersonality>;
    motiveSensitivity: DecisionContext['person']['motiveSensitivity'];
    soul: ReturnType<typeof buildPersonSoul>;
    experience: ReturnType<typeof buildPersonExperienceLayer>;
    currentChoice: string;
    currentAction: string;
    position: { cellId: number; z: number };
    inventory: Array<{ stackId: string; name: string; properties: string[]; perception: PerceivedMaterialProfile; quantity: number }>;
    knowledge: Array<{ id: string; summary: string; confidence: number }>;
    knownPlaces: Array<{ name: string; position: { x: number; y: number; z: number }; lastConfirmedAtMonth: number }>;
    /** The person's only model-visible memory document. */
    mindMarkdown: string;
    memories: RecalledMemory[];
    /** Persisted subjective turns, not claims that their assumptions were true. */
    recentMentalActs: Array<MentalAct & { atMonth: number }>;
    cognition: ReturnType<typeof buildDecisionCognitionProjection>;
    characterAgenda: CharacterAgendaSummary[];
    kinship: {
      parents: Array<{ id: string; name: string; sex: DecisionContext['person']['sex']; relation: 'mother' | 'father' }>;
      children: Array<{ id: string; name: string; sex: DecisionContext['person']['sex']; relation: 'daughter' | 'son' }>;
      siblings: Array<{
        id: string; name: string; sex: DecisionContext['person']['sex']; relation: 'sister' | 'brother';
        fullSibling: boolean; sharedParentIds: string[];
      }>;
    };
  };
  clock: { elapsedMonths: number; planningTick?: number };
  climate: DecisionContext['state']['civilization']['climate'];
  epoch: DecisionContext['state']['civilization']['epoch'];
  weather: DecisionContext['state']['civilization']['weather'];
  activePressures: Array<{ kind: string; stage: number; consequences: string[] }>;
  /**
   * Verified persisted model utterances personally spoken or heard. They are
   * subjective conversation context, never authoritative world facts.
   */
  recentDialogue?: RecentDialogueContextLine[];
  activeIntent?: {
    id: string; summary: string; domain: 'strategic' | 'social'; progress: number; nextActionKind: string;
    stateGoalUntilMonth?: number;
    lifecycle?: {
      completion: 'on-achievement' | 'maintain-state';
      reviewAtMonth: number;
      maintainUntilMonth?: number;
    };
  };
  activeProject?: {
    id: string;
    summary: string;
    need: string;
    status: string;
    lastProgressAtMonth: number;
    contributorIds: string[];
    materialPlan:
      | {
          status: 'verified';
          desiredFunction: string;
          provenance: { kind: 'verified-technique' | 'completed-recipe'; knowledgeId?: string; sourceFactIds: string[] };
          missingMaterials: Array<{ name: string }>;
          reservations: Array<{ personId: string; name: string; quantity: number }>;
        }
      | { status: 'unresolved'; question: 'inspect-local-properties-and-test-candidates'; reservationCount: number };
  };
  suspendedIntents: Array<{ id: string; summary: string; progress: number; nextActionKind: string }>;
  agreements: Array<{
    id: string; kind: string; status: string; partyIds: string[]; dueAtMonth?: number;
    requiredResponderIds: string[]; acceptedByPersonIds: string[]; fulfilledByPersonIds: string[];
  }>;
  collectives: Array<{
    id: string; purposeSummary: string; status: string; activeMemberIds: string[]; joinedAtMonth: number;
    decisionRules: Array<{
      id: string; method: string; scope: string; materialId?: number;
      projectDuty?: { projectKind: string; desiredFunction: string; progressKind: string };
    }>;
    mandates: Array<{
      id: string; holderId: string; materialId?: number; projectId?: string;
      validUntilMonth: number; status: string;
    }>;
  }>;
  permissions: Array<{ id: string; grantorId: string; granteeId: string; materialId: number; validUntilMonth: number; status: string }>;
  options: Array<{
    id: string; summary: string; reason: string; domain?: 'strategic' | 'social';
    estimatedMonths?: number; risks?: string[]; target?: DecisionContext['options'][number]['target']; requiresFollowUp: boolean;
    /** Server-only linkage; compact projection replaces it with an agenda handle. */
    characterAgendaItemId?: string;
    /** Server-only linkage used to associate a project step with an existing agenda. */
    projectId?: string;
    communicationKind?: 'claim' | 'prediction' | 'request' | 'offer' | 'accept' | 'reject' | 'revoke-agreement' | 'revoke' | 'withdraw';
    speechAct?: SpeechActView;
    communicatesFactId?: string;
    /** Server-only allow-list; model transports receive request-scoped handles instead. */
    openConversationGrounding?: NonNullable<DecisionContext['options'][number]['openConversationGrounding']>;
    socialRepetition?: {
      score: number;
      rememberedBefore: boolean;
      hasNewEvidence: boolean;
      reasons: string[];
      outcome?: string;
      previousCommunicationEventId?: string;
    };
    semantics: ReturnType<typeof actionOptionSemantics>;
  }>;
  followUpOptions: Array<{
    id: string; summary: string; reason: string; domain?: 'strategic' | 'social';
    estimatedMonths?: number; risks?: string[]; target?: DecisionContext['options'][number]['target'];
    semantics: ReturnType<typeof actionOptionSemantics>;
    /** Server-only relation used to build a bounded valid follow-up shortlist. */
    matchesOptionIds: string[];
  }>;
  visiblePeople: Array<{
    id: string; name: string; ageMonths: number; sex: DecisionContext['person']['sex'];
    health: number; hydration: number; nutrition: number; conditions: DecisionContext['person']['conditions'];
    cellId: number; z: number; trust: number; bond: number; fear: number;
  }>;
  visibleDrops: Array<{ id: string; name: string; properties: string[]; perception: PerceivedMaterialProfile; quantity: number; cellId: number; z: number }>;
  visibleAnimals: Array<{ id: string; speciesId: string; cellId: number; z: number; health: number; hunger: number }>;
  visibleContainers: Array<{
    id: string; position: { x: number; y: number; z: number };
    capacity: number; usedCapacity: number;
    contents: Array<{ name: string; quantity: number }>;
  }>;
  /** Bounded, currently visible surfaces for proposal probes; no material ids leave this projection. */
  visibleVoxels: Array<{
    position: { x: number; y: number; z: number };
    name: string;
    properties: string[];
  }>;
}

export interface CharacterAgendaSummary {
  /** Server-owned identity; compact model contexts replace both fields with a request handle. */
  id: string;
  basisKey: string;
  /** Server-only project linkage; never exposed in a model request. */
  projectIds: string[];
  aim: string;
  theme: string;
  importance: number;
  horizonMonths: number;
  targetAtMonth: number;
  status: CharacterAgendaItem['status'];
  lastReviewedAtMonth: number;
  approaches: Array<{
    summary: string;
    disposition: CharacterAgendaItem['approaches'][number]['disposition'];
    latestOutcome?: CharacterAgendaItem['approaches'][number]['latestOutcome'];
    evaluationCount: number;
  }>;
}

export function buildDecisionCognitionProjection(context: DecisionContext) {
  const planningMonth = context.state.clock.elapsedMonths + 1;
  const frame = buildCognitiveFrame(context, context.options, { atMonth: planningMonth, planningTick: 1 });
  const appraisalByOption = new Map(frame.appraisals.map((appraisal) => [appraisal.option.id, appraisal]));
  return {
    architecture: frame.architecture,
    planningMonth,
    needs: frame.needs.slice(0, 6).map((need) => ({
      kind: need.kind,
      urgency: Math.round(need.urgency * 100) / 100,
      reasons: need.reasons.slice(0, 2),
      sourceFactIds: need.sourceFactIds.slice(-6),
    })),
    outcomeBeliefs: cognitionStateOf(context.person).outcomeBeliefs
      .slice()
      .sort((left, right) => right.lastUpdatedAtMonth - left.lastUpdatedAtMonth || right.attempts - left.attempts)
      .slice(0, 8)
      .map((belief) => ({
        basisKey: belief.basisKey,
        attempts: belief.attempts,
        expectedSuccess: Math.round(outcomeBeliefSuccess(belief) * 100) / 100,
        expectedEffort: Math.round(belief.expectedEffort * 100) / 100,
        expectedHarm: Math.round(belief.expectedHarm * 100) / 100,
        sourceFactIds: belief.sourceEventIds.slice(-6),
      })),
    optionAppraisals: context.options.map((option) => {
      const appraisal = appraisalByOption.get(option.id);
      return {
        optionId: option.id,
        addressedNeeds: appraisal?.addressedNeeds.map((need) => need.kind) ?? [],
        motivation: Math.round((appraisal?.motivation ?? 0) * 100) / 100,
        aspiration: Math.round((appraisal?.aspiration ?? 0) * 100) / 100,
        expectedSuccess: Math.round((appraisal?.expectedSuccess ?? 0.5) * 100) / 100,
        uncertainty: Math.round((appraisal?.uncertainty ?? 1) * 100) / 100,
        reasons: appraisal?.reasons.slice(0, 3) ?? [],
        sourceFactIds: appraisal?.sourceFactIds.slice(-8) ?? option.sourceFactIds.slice(-8),
      };
    }),
  };
}

function pressureConsequences(kind: string, stage: number): string[] {
  if (kind === 'cold') return ['营养消耗加速', '操作与移动能力下降', ...(stage >= 3 ? ['每月损失健康'] : [])];
  if (kind === 'heat') return ['水分消耗加速', '操作与移动能力下降', ...(stage >= 3 ? ['每月损失健康'] : [])];
  if (kind === 'wound') return ['行动能力下降', ...(stage >= 2 ? ['持续损失健康并增加患病风险'] : [])];
  if (kind === 'illness') return ['水分与营养消耗加速', '行动能力下降', ...(stage >= 2 ? ['持续损失健康'] : [])];
  if (kind === 'aging') return ['恢复与行动能力下降', ...(stage >= 2 ? ['匮乏时额外损失健康'] : [])];
  if (kind === 'pregnancy') return ['水分与营养消耗增加', ...(stage >= 2 ? ['行动能力下降'] : [])];
  if (kind === 'postpartum-recovery') return ['水分与营养消耗增加', ...(stage >= 2 ? ['行动能力下降', '不能开始下一次妊娠'] : ['不能开始下一次妊娠'])];
  if (kind === 'restrained') return ['无法正常移动', '只能近身尝试分离拘束物质或等待他人解除'];
  if (kind === 'dehydrated-hibernation') return ['停止普通行动', '大幅降低代谢', '减少乱纪元气候伤害'];
  return [];
}

function immediateKinship(state: DecisionContext['state'], person: DecisionContext['person']): DecisionRequestContext['person']['kinship'] {
  const byId = new Map(state.people.map((candidate) => [candidate.id, candidate]));
  const parents = person.geneticParents.flatMap((parentId) => {
    const parent = byId.get(parentId);
    return parent ? [{
      id: parent.id,
      name: parent.name,
      sex: parent.sex,
      relation: parent.sex === 'female' ? 'mother' as const : 'father' as const,
    }] : [];
  });
  const children = state.people
    .filter((candidate) => candidate.id !== person.id && candidate.geneticParents.includes(person.id))
    .sort((left, right) => left.bornAtMonth - right.bornAtMonth || left.id.localeCompare(right.id))
    .map((child) => ({
      id: child.id,
      name: child.name,
      sex: child.sex,
      relation: child.sex === 'female' ? 'daughter' as const : 'son' as const,
    }));
  const ownParentIds = new Set(person.geneticParents);
  const siblings = ownParentIds.size === 0 ? [] : state.people
    .filter((candidate) => candidate.id !== person.id)
    .flatMap((candidate) => {
      const sharedParentIds = candidate.geneticParents.filter((parentId) => ownParentIds.has(parentId));
      if (!sharedParentIds.length) return [];
      const fullSibling = candidate.geneticParents.length === ownParentIds.size
        && candidate.geneticParents.every((parentId) => ownParentIds.has(parentId));
      return [{
        id: candidate.id,
        name: candidate.name,
        sex: candidate.sex,
        relation: candidate.sex === 'female' ? 'sister' as const : 'brother' as const,
        fullSibling,
        sharedParentIds,
      }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return { parents, children, siblings };
}

function characterAgendaSummary(items: readonly CharacterAgendaItem[] = []): CharacterAgendaSummary[] {
  const statusPriority: Record<CharacterAgendaItem['status'], number> = {
    active: 0,
    incubating: 1,
    blocked: 2,
    suspended: 3,
    fulfilled: 4,
    abandoned: 5,
  };
  return [...items]
    .sort((left, right) => statusPriority[left.status] - statusPriority[right.status]
      || right.importance - left.importance
      || right.lastReviewedAtMonth - left.lastReviewedAtMonth)
    .slice(0, 4)
    .map((item) => ({
      id: item.id,
      basisKey: item.basisKey,
      projectIds: [...item.projectIds],
      aim: item.aim,
      theme: item.theme,
      importance: item.importance,
      horizonMonths: item.horizonMonths,
      targetAtMonth: item.targetAtMonth,
      status: item.status,
      lastReviewedAtMonth: item.lastReviewedAtMonth,
      approaches: [...item.approaches]
        .sort((left, right) => right.lastConsideredAtMonth - left.lastConsideredAtMonth)
        .slice(0, 3)
        .map((approach) => ({
          summary: approach.summary,
          disposition: approach.disposition,
          ...(approach.latestOutcome ? { latestOutcome: approach.latestOutcome } : {}),
          evaluationCount: approach.evaluations.length,
        })),
    }));
}


export interface DecisionRequestProjectionOptions {
  /** Branch-local SpeechLines already restored from committed frames. */
  committedSpeechLines?: readonly SpeechLineView[];
}

export function buildDecisionRequestContext(
  context: DecisionContext,
  options: DecisionRequestProjectionOptions = {},
): DecisionRequestContext {
  const { person, state } = context;
  const visibleVoxels = [...context.visibleCells]
    .sort((left, right) => {
      const leftDistance = Math.abs(cellX(left) - cellX(person.position.cellId))
        + Math.abs(cellY(left) - cellY(person.position.cellId));
      const rightDistance = Math.abs(cellX(right) - cellX(person.position.cellId))
        + Math.abs(cellY(right) - cellY(person.position.cellId));
      return leftDistance - rightDistance || left - right;
    })
    .map((visibleCellId) => {
      const materialId = surfaceMaterial(state.world.grid, visibleCellId);
      const perception = perceiveMaterial(materialId, 'visible');
      return {
        materialId,
        position: topPosition(state.world.grid, visibleCellId),
        name: materialDefinition(materialId).name,
        properties: perceivedProperties(perception),
      };
    })
    .filter((candidate, index, all) => all.findIndex((other) => other.materialId === candidate.materialId) === index)
    .slice(0, 12)
    .map(({ position, name, properties }) => ({ position, name, properties }));
  const communicatedKnowledgeIds = new Set(context.options.flatMap((option) => (
    option.nextAction.kind === 'talk'
      && option.nextAction.speakerMeaning.kind === 'claim'
      && option.nextAction.speakerMeaning.factId
      ? [option.nextAction.speakerMeaning.factId]
      : []
  )));
  const communicatedKnowledge = person.knowledge
    .filter((item) => communicatedKnowledgeIds.has(item.id))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
  const projectedKnowledge = [
    ...communicatedKnowledge,
    ...person.knowledge
      .filter((item) => !communicatedKnowledgeIds.has(item.id))
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, 6 - communicatedKnowledge.length)),
  ];
  const activeProject = context.activeIntent?.projectId
    ? state.projects.find((project) => project.id === context.activeIntent?.projectId)
    : undefined;
  const activeProjectProvenance = activeProject
    ? projectMaterialPlanProvenance(state, person, activeProject)
    : null;
  const recalledMemories = context.mind
    ? [...context.mind.episodes, ...context.mind.beliefs].slice(0, 10)
    : retrieveAgentMemories(state, person, {
        atMonth: state.clock.elapsedMonths + 1,
        personIds: [...decisionCounterpartIds(context)],
        unresolved: true,
        limit: 10,
        tokenBudget: 1_400,
      });
  const counterpartIds = [...decisionCounterpartIds(context)];
  const recentMentalActs = context.mind?.deliberations ?? [...state.world.past]
    .reverse()
    .flatMap((event) => event.kind === 'decision'
      && event.who === person.id
      && 'mentalAct' in event.decision
      && event.decision.mentalAct
      ? [{ ...structuredClone(event.decision.mentalAct), atMonth: event.atMonth }]
      : [])
    .slice(0, 4);
  return {
    person: {
      id: person.id,
      name: person.name,
      description: person.profile.description.slice(0, 240),
      ageMonths: ageMonths(person, state.clock.elapsedMonths),
      sex: person.sex,
      body: person.body,
      conditions: person.conditions,
      capacities: person.baselineCapacities,
      traits: traitStatesOf(person).map((trait) => {
        const definition = traitDefinition(trait.id);
        return { id: definition.id, name: definition.name, description: definition.description };
      }),
      personality: effectivePersonality(person),
      motiveSensitivity: person.motiveSensitivity,
      soul: buildPersonSoul(person),
      experience: buildPersonExperienceLayer(person, recalledMemories, counterpartIds),
      currentChoice: person.lastDecisionText.slice(0, 140),
      currentAction: person.currentActionText.slice(0, 180),
      position: { cellId: person.position.cellId, z: person.position.z },
      inventory: person.inventory.map((stack) => {
        const material = materialDefinition(stack.materialId);
        const perception = perceiveMaterial(stack.materialId, 'held');
        return {
          stackId: stack.id,
          name: material.name,
          properties: perceivedProperties(perception),
          perception,
          quantity: stack.quantity,
        };
      }),
      knowledge: projectedKnowledge.map(({ id, summary, confidence }) => ({ id, summary, confidence })),
      knownPlaces: [...person.knownPlaces]
        .sort((a, b) => b.lastConfirmedAtMonth - a.lastConfirmedAtMonth || a.id.localeCompare(b.id))
        .slice(0, 8)
        .map(({ materialId, position, lastConfirmedAtMonth }) => ({ name: materialDefinition(materialId).name, position, lastConfirmedAtMonth })),
      mindMarkdown: context.mind?.markdown ?? person.mindMarkdown ?? '',
      memories: recalledMemories,
      recentMentalActs,
      cognition: buildDecisionCognitionProjection(context),
      characterAgenda: characterAgendaSummary(person.characterAgenda?.items),
      kinship: immediateKinship(state, person),
    },
    clock: {
      elapsedMonths: context.decisionMonth ?? state.clock.elapsedMonths,
      ...(context.planningTick !== undefined ? { planningTick: context.planningTick } : {}),
    },
    climate: state.civilization.climate,
    epoch: state.civilization.epoch,
    weather: state.civilization.weather,
    activePressures: person.conditions.map((condition) => ({
      kind: condition.kind,
      stage: condition.stage,
      consequences: pressureConsequences(condition.kind, condition.stage),
    })),
    recentDialogue: recentDialogueForDecision(context, options.committedSpeechLines),
    ...(context.activeIntent ? { activeIntent: {
      id: context.activeIntent.id,
      summary: context.activeIntent.summary,
      domain: context.activeIntent.domain,
      progress: context.activeIntent.progress,
      nextActionKind: context.activeIntent.nextAction.kind,
      ...(context.activeIntent.stateGoalUntilMonth !== undefined ? { stateGoalUntilMonth: context.activeIntent.stateGoalUntilMonth } : {}),
      ...(context.activeIntent.lifecycle ? { lifecycle: {
        completion: context.activeIntent.lifecycle.completion,
        reviewAtMonth: context.activeIntent.lifecycle.reviewAtMonth,
        ...(context.activeIntent.lifecycle.maintainUntilMonth !== undefined
          ? { maintainUntilMonth: context.activeIntent.lifecycle.maintainUntilMonth }
          : {}),
      } } : {}),
    } } : {}),
    ...(activeProject ? { activeProject: {
      id: activeProject.id,
      summary: activeProject.summary,
      need: activeProject.need,
      status: activeProject.status,
      lastProgressAtMonth: activeProject.lastProgressAtMonth,
      contributorIds: [...activeProject.contributorIds],
      materialPlan: activeProjectProvenance ? {
        status: 'verified',
        desiredFunction: activeProject.desiredFunction,
        provenance: structuredClone(activeProjectProvenance),
        missingMaterials: activeProject.missingMaterialIds.map((materialId) => ({
          name: materialDefinition(materialId).name,
        })),
        reservations: activeProject.reservations.map((reservation) => ({
          personId: reservation.personId,
          name: materialDefinition(reservation.materialId).name,
          quantity: reservation.quantity,
        })),
      } : {
        status: 'unresolved',
        question: 'inspect-local-properties-and-test-candidates',
        reservationCount: activeProject.reservations.length,
      },
    } } : {}),
    suspendedIntents: state.intents
      .filter((intent) => intent.ownerId === person.id && intent.status === 'suspended' && !intent.suspendedByIntentId)
      .map((intent) => ({ id: intent.id, summary: intent.summary, progress: intent.progress, nextActionKind: intent.nextAction.kind })),
    agreements: state.agreements
      .filter((agreement) => agreement.partyIds.includes(person.id) && (agreement.status === 'proposed' || agreement.status === 'active' || (agreement.resolvedAtMonth ?? -99) >= state.clock.elapsedMonths - 6))
      .sort((a, b) => (b.acceptedAtMonth ?? b.proposedAtMonth) - (a.acceptedAtMonth ?? a.proposedAtMonth))
      .slice(0, 6)
      .map((agreement) => ({ id: agreement.id, kind: agreement.proposal.kind, status: agreement.status, partyIds: agreement.partyIds, ...(agreement.dueAtMonth !== undefined ? { dueAtMonth: agreement.dueAtMonth } : {}), requiredResponderIds: agreement.requiredResponderIds, acceptedByPersonIds: agreement.acceptedByPersonIds, fulfilledByPersonIds: agreement.fulfilledByPersonIds })),
    collectives: state.collectives.flatMap((collective) => {
      const own = collective.memberships.find((membership) => membership.personId === person.id && membership.status === 'active');
      return own ? [{
        id: collective.id,
        purposeSummary: collective.purposeSummary,
        status: collective.status,
        activeMemberIds: collective.memberships.filter((membership) => membership.status === 'active').map((membership) => membership.personId),
        joinedAtMonth: own.joinedAtMonth,
        decisionRules: collective.decisionRules.filter((rule) => rule.status === 'active').map((rule) => ({
          id: rule.id,
          method: rule.method,
          scope: rule.scope,
          ...(rule.scope === 'coordinate-material'
            ? { materialId: rule.materialId }
            : { projectDuty: { ...rule.projectDuty } }),
        })),
        mandates: collective.mandates.filter((mandate) => mandate.status === 'active').map((mandate) => ({
          id: mandate.id,
          holderId: mandate.holderId,
          validUntilMonth: mandate.validUntilMonth,
          status: mandate.status,
          ...(mandate.scope === 'coordinate-material'
            ? { materialId: mandate.materialId }
            : { projectId: mandate.projectId }),
        })),
      }] : [];
    }),
    permissions: state.permissions
      .filter((permission) => permission.status === 'active' && (permission.grantorId === person.id || permission.granteeId === person.id))
      .map(({ id, grantorId, granteeId, materialId, validUntilMonth, status }) => ({ id, grantorId, granteeId, materialId, validUntilMonth, status })),
    options: context.options.map((option) => {
      const { id, summary, reason, domain, estimatedMonths, risks, target, requiresFollowUp, nextAction, completionAction } = option;
      // Open conversation is only grounded after the model chooses its actual
      // sources. A repetition score computed from the placeholder fallback
      // would describe a different utterance and can wrongly suppress it.
      const repetition = option.openConversationGrounding
        ? undefined
        : assessSocialRepetition(state, person, option);
      return {
        id, summary, reason, domain, estimatedMonths, risks, target, requiresFollowUp: Boolean(requiresFollowUp),
        ...(option.characterAgendaItemId ? { characterAgendaItemId: option.characterAgendaItemId } : {}),
        ...(option.projectId ? { projectId: option.projectId } : {}),
        ...(option.openConversationGrounding
          ? { openConversationGrounding: structuredClone(option.openConversationGrounding) }
          : {}),
        semantics: structuredClone(actionOptionSemantics(option)),
        ...(nextAction.kind === 'talk'
          ? {
              communicationKind: nextAction.speakerMeaning.kind,
              speechAct: speechActFromRepresentation(nextAction.speakerMeaning),
            }
          : completionAction?.kind === 'talk'
            ? {
                communicationKind: completionAction.speakerMeaning.kind,
                speechAct: speechActFromRepresentation(completionAction.speakerMeaning),
              }
            : {}),
        ...(nextAction.kind === 'talk' && nextAction.speakerMeaning.kind === 'claim' && nextAction.speakerMeaning.factId
          ? { communicatesFactId: nextAction.speakerMeaning.factId }
          : {}),
        ...(repetition?.subjectKey ? { socialRepetition: {
          score: repetition.score,
          rememberedBefore: Boolean(repetition.previousCommunicationEventId),
          hasNewEvidence: Boolean(repetition.previousCommunicationEventId && repetition.newEvidenceEventIds.length),
          reasons: repetition.reasons.slice(0, 3),
          ...(repetition.outcome ? { outcome: repetition.outcome } : {}),
          ...(repetition.previousCommunicationEventId
            ? { previousCommunicationEventId: repetition.previousCommunicationEventId }
            : {}),
        } } : {}),
      };
    }),
    followUpOptions: context.followUpOptions.map((option) => {
      const { id, summary, reason, domain, estimatedMonths, risks, target } = option;
      return {
        id, summary, reason, domain, estimatedMonths, risks, target,
        semantics: structuredClone(actionOptionSemantics(option)),
        matchesOptionIds: context.options
          .filter((opening) => opening.requiresFollowUp && followUpSemanticallyMatches(opening, option))
          .map((opening) => opening.id),
      };
    }),
    visiblePeople: context.visiblePeople.map((other) => {
      const relation = relationTo(person, other.id);
      return {
        id: other.id,
        name: other.name,
        ageMonths: ageMonths(other, state.clock.elapsedMonths),
        sex: other.sex,
        ...other.body,
        conditions: other.conditions,
        cellId: other.position.cellId,
        z: other.position.z,
        trust: relation?.trust ?? 0,
        bond: relation?.bond ?? 0,
        fear: relation?.fear ?? 0,
      };
    }),
    visibleDrops: context.visibleDrops.map((drop) => {
      const material = materialDefinition(drop.materialId);
      const perception = perceiveMaterial(drop.materialId, 'visible');
      return {
        id: drop.id,
        name: material.name,
        properties: perceivedProperties(perception),
        perception,
        quantity: drop.quantity,
        cellId: drop.cellId,
        z: drop.z,
      };
    }),
    visibleAnimals: context.visibleAnimals.map((animal) => ({
      id: animal.id,
      speciesId: animal.speciesId,
      cellId: animal.position.cellId,
      z: animal.position.z,
      health: animal.health,
      hunger: animal.hunger,
    })),
    visibleContainers: state.containers
      .filter((container) => context.visibleCells.includes(container.position.x + container.position.y * state.world.grid.width))
      .slice(0, 4)
      .map((container) => ({
        id: container.id,
        position: container.position,
        capacity: CONTAINER_CAPACITY,
        usedCapacity: container.inventory.reduce((sum, stack) => sum + stack.quantity, 0),
        contents: container.inventory.slice(0, 6).map((stack) => ({
          name: materialDefinition(stack.materialId).name,
          quantity: stack.quantity,
        })),
      })),
    visibleVoxels,
  };
}
