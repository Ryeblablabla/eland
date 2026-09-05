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
import {
  cognitiveOutcomeBasisKey,
  goalOutcomeBeliefFor,
  outcomeBeliefFor,
} from '../../domain/cognition';
import { speechActFromRepresentation } from '../../domain/speech-act';
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
import type { RepresentationInput } from '../../domain/action';
import { cellX, cellY, surfaceMaterial, topPosition } from '../../world/grid';
import { shelterGeometryAt } from '../../domain/structure';
import {
  decisionCounterpartIds,
  recentDialogueForDecision,
  type RecentDialogueContextLine,
} from './recent-dialogue';
import { mbtiTypeForPersonality, type MbtiType } from '../../domain/mbti-persona-presets';
import { animalBondTrust } from '../../domain/animal-bonds';
import { observeWorkAdoption } from '../../domain/works';

function perceivedProperties(profile: PerceivedMaterialProfile): string[] {
  return [...new Set([
    profile.phase,
    profile.form,
    profile.appearance,
    ...(profile.loadBand ? [profile.loadBand] : []),
    ...(profile.rigidity ? [profile.rigidity] : []),
  ])];
}

function openWorldFactCurrentCell(
  state: DecisionContext['state'],
  fact: NonNullable<DecisionContext['state']['world']['openFacts']>[number],
): number | undefined {
  const target = fact.targetRef;
  if (!target) return fact.cellId;
  if (target.kind === 'voxel') return target.position.x + target.position.y * state.world.grid.width;
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId;
  if (target.kind === 'person') return state.people.find((person) => person.id === target.personId)?.position.cellId;
  if (target.kind === 'animal') return state.world.animals.find((animal) => animal.id === target.animalId)?.position.cellId;
  if (target.kind === 'work') {
    const work = state.world.works?.find((work) => work.id === target.workId);
    return work ? work.position.x + work.position.y * state.world.grid.width : undefined;
  }
  if (target.kind === 'container') {
    const container = state.containers.find((candidate) => candidate.id === target.containerId);
    return container ? container.position.x + container.position.y * state.world.grid.width : undefined;
  }
  if (target.kind === 'inventory-stack') {
    const owner = state.people.find((person) => person.id === target.personId
      && person.inventory.some((stack) => stack.id === target.stackId));
    return owner?.position.cellId;
  }
  const remains = state.world.remains?.find((candidate) => candidate.id === target.remainsId);
  return remains?.position.cellId;
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
    personalityType: MbtiType;
    motiveSensitivity: DecisionContext['person']['motiveSensitivity'];
    soul: ReturnType<typeof buildPersonSoul>;
    experience: ReturnType<typeof buildPersonExperienceLayer>;
    currentChoice: string;
    currentAction: string;
    position: { cellId: number; z: number };
    inventory: Array<{
      stackId: string; materialId: number; name: string; properties: string[];
      perception: PerceivedMaterialProfile; quantity: number;
    }>;
    knowledge: Array<{ id: string; kind: string; summary: string; confidence: number }>;
    procedures?: Array<{ id: string; summary: string; confidence: number; method: NonNullable<DecisionContext['person']['knowledge'][number]['procedural']> }>;
    knownPlaces: Array<{ name: string; position: { x: number; y: number; z: number }; lastConfirmedAtMonth: number }>;
    /** The person's only model-visible memory document. */
    mindMarkdown: string;
    memories: RecalledMemory[];
    /** Persisted subjective turns, not claims that their assumptions were true. */
    recentMentalActs: Array<MentalAct & { atMonth: number }>;
    /** Directed model-authored meanings grounded in remembered world facts. */
    relationshipEpisodes: Array<{
      otherPersonId: string;
      otherPersonName: string;
      experiencedAtMonth: number;
      meanings: string[];
      interpretation: string;
      unresolvedExpectation?: string;
      desiredResponse?: string;
      sourceCount: number;
    }>;
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
  /** A current-month plan continuation reuses this exact, already spoken intention. */
  continuingPlan?: NonNullable<DecisionContext['continuingPlan']> & {
    recentResults: string[];
    recentEffects: Array<{ atMonth: number; effects: unknown[] }>;
  };
  climate: DecisionContext['state']['civilization']['climate'];
  epoch: DecisionContext['state']['civilization']['epoch'];
  weather: DecisionContext['state']['civilization']['weather'];
  sheltered: boolean;
  activePressures: Array<{ kind: string; stage: number; consequences: string[] }>;
  /**
   * Verified persisted model utterances personally spoken or heard. They are
   * subjective conversation context, never authoritative world facts.
   */
  recentDialogue?: RecentDialogueContextLine[];
  activeIntent?: {
    id: string; summary: string; domain: 'strategic' | 'social'; progress: number; nextActionKind: string;
    plan?: {
      steps: string[];
      disposition: string;
    };
    recentOutcomes?: Array<{
      execution: string;
      goalProgress: string;
      evidence: string;
      atMonth: number;
    }>;
    stateGoalUntilMonth?: number;
    lifecycle?: {
      completion: 'on-achievement' | 'maintain-state';
      reviewAtMonth: number;
      maintainUntilMonth?: number;
    };
  };
  /** Finished executable episodes retain the author's larger plan for the next decision. */
  recentCompletedWork?: Array<{
    summary: string;
    status: string;
    atMonth: number;
    plan: { steps: string[]; disposition: string };
    recentOutcomes: Array<{ execution: string; goalProgress: string; evidence: string; atMonth: number }>;
  }>;
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
  suspendedIntents: Array<{
    id: string;
    summary: string;
    progress: number;
    nextActionKind: string;
    planSourceDecisionEventId: string;
    requiresNewSpeech: boolean;
    createdAtMonth: number;
    lastProgressAtMonth: number;
    waitingFor?: 'world-change';
    plan?: { steps: string[]; disposition: string };
    recentOutcomes?: Array<{ execution: string; goalProgress: string; evidence: string; atMonth: number }>;
  }>;
  agreements: Array<{
    id: string; kind: string; status: string; partyIds: string[]; dueAtMonth?: number;
    proposedAtMonth: number;
    pendingResponderNames: string[];
    requiredResponderIds: string[]; acceptedByPersonIds: string[]; fulfilledByPersonIds: string[];
    rejectedByPersonIds: string[];
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
    /** Server-only project scope used to keep a selected project step aligned with the stated intention. */
    executionProjectFunction?: DecisionContext['state']['projects'][number]['desiredFunction'];
    communicationKind?: 'claim' | 'prediction' | 'request' | 'offer' | 'accept' | 'reject' | 'revoke-agreement' | 'revoke' | 'withdraw';
    /** Server-only canonical meaning used to verify that spoken words actually express the selected speech act. */
    communicationMeaning?: RepresentationInput;
    speechAct?: SpeechActView;
    expressesFactId?: string;
    /** Server-only allow-list; model transports receive request-scoped handles instead. */
    openConversationGrounding?: NonNullable<DecisionContext['options'][number]['openConversationGrounding']>;
    socialHistory?: {
      rememberedBefore: boolean;
      hasNewEvidence: boolean;
      outcome?: string;
    };
    /** Person-local counts from committed outcomes of semantically similar actions and goals. */
    experiencedOutcomes?: {
      similarAction?: {
        attempts: number;
        completed: number;
        progressed: number;
        blocked: number;
        failed: number;
        lastUpdatedAtMonth: number;
      };
      intendedGoal?: {
        attempts: number;
        achieved: number;
        attemptedUnmet: number;
        lastUpdatedAtMonth: number;
      };
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
  visibleAnimals: Array<{
    id: string;
    speciesId: string;
    cellId: number;
    z: number;
    health: number;
    hunger: number;
    bondTrust: number;
  }>;
  visibleContainers: Array<{
    id: string; position: { x: number; y: number; z: number };
    capacity: number; usedCapacity: number;
    contents: Array<{ name: string; quantity: number }>;
  }>;
  /** Durable nearby state asserted by completed open-ended world interactions. */
  visibleOpenWorldFacts?: Array<{
    summary: string;
    atMonth: number;
    stateKey?: string;
    stateValue?: string;
    targetKind?: string;
  }>;
  /** Nearby person-built composite entities (works) with their builders and state. */
  visibleWorks?: Array<{
    id: string;
    position: { x: number; y: number; z: number };
    summary: string;
    arrangement: string;
    condition: string;
    conditionValue: number;
    profile: { cover: number; rigidity: number; stability: number };
    createdAtMonth: number;
    lastTouchedAtMonth: number;
    builders: string[];
    components: Array<{ name: string; materialKey: string; quantity: number }>;
    layout?: Array<{ offset: { x: number; y: number; z: number }; materialKey: string }>;
    recentUse: Array<{ atMonth: number; kind: string; by: string; result: string; shelterUse?: Record<string, unknown> }>;
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
  createdAtMonth: number;
  status: CharacterAgendaItem['status'];
  lastReviewedAtMonth: number;
  approaches: Array<{
    summary: string;
    disposition: CharacterAgendaItem['approaches'][number]['disposition'];
    latestOutcome?: CharacterAgendaItem['approaches'][number]['latestOutcome'];
    evaluationCount: number;
    recentEvaluations: Array<{ atMonth: number; outcome: string; note?: string }>;
  }>;
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
      createdAtMonth: item.createdAtMonth,
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
          recentEvaluations: approach.evaluations.slice(-3).map(({ atMonth, outcome, note }) => ({
            atMonth, outcome, ...(note ? { note } : {}),
          })),
        })),
    }));
}

function intentRequiresNewSpeech(
  state: DecisionContext['state'],
  intent: DecisionContext['state']['intents'][number],
): boolean {
  let current: typeof intent | undefined = intent;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.nextAction.kind === 'talk' || current.completionAction?.kind === 'talk'
      || (!current.openingActionCompleted && current.openingAction?.kind === 'talk')) return true;
    const parentId: string | undefined = current.returnToIntentId;
    current = parentId ? state.intents.find((candidate) => candidate.id === parentId
      && (candidate.status === 'active' || candidate.status === 'suspended')) : undefined;
  }
  return false;
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
  const expressedKnowledgeIds = new Set(context.options.flatMap((option) => (
    option.nextAction.kind === 'talk'
      && option.nextAction.speakerMeaning.kind === 'claim'
      && option.nextAction.speakerMeaning.factId
      ? [option.nextAction.speakerMeaning.factId]
      : []
  )));
  const expressedKnowledge = person.knowledge
    .filter((item) => expressedKnowledgeIds.has(item.id))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
  const projectedKnowledge = [
    ...expressedKnowledge,
    ...person.knowledge
      .filter((item) => !expressedKnowledgeIds.has(item.id))
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, 6 - expressedKnowledge.length)),
  ];
  const activeProject = context.activeIntent?.projectId
    ? state.projects.find((project) => project.id === context.activeIntent?.projectId)
    : undefined;
  const activeProjectProvenance = activeProject
    ? projectMaterialPlanProvenance(state, person, activeProject)
    : null;
  const recalledMemories = context.mind
    ? [...context.mind.episodes, ...context.mind.beliefs, ...context.mind.related].slice(0, 20)
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
    ...(context.continuingPlan ? {
      continuingPlan: {
        ...structuredClone(context.continuingPlan),
        recentResults: context.continuingPlan.outcomeReceipts.slice(-4).flatMap((receipt) => {
          const event = context.currentMonthEvents?.find((event) => event.id === receipt.actionEventId)
            ?? state.world.past.find((event) => event.id === receipt.actionEventId);
          return event?.kind === 'action' ? [event.result] : [];
        }),
        recentEffects: context.continuingPlan.outcomeReceipts.slice(-4).flatMap((receipt) => {
          const event = context.currentMonthEvents?.find((event) => event.id === receipt.actionEventId)
            ?? state.world.past.find((event) => event.id === receipt.actionEventId);
          return event?.kind === 'action' && Array.isArray(event.diff.appliedEffects)
            ? [{ atMonth: event.atMonth, effects: structuredClone(event.diff.appliedEffects) }] : [];
        }),
      },
    } : {}),
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
      personalityType: mbtiTypeForPersonality(person.personality.baseline),
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
          materialId: stack.materialId,
          name: material.name,
          properties: perceivedProperties(perception),
          perception,
          quantity: stack.quantity,
        };
      }),
      knowledge: projectedKnowledge.map(({ id, kind, summary, confidence }) => ({ id, kind, summary, confidence })),
      procedures: person.knowledge.filter((fact) => fact.procedural)
        .sort((left, right) => (right.procedural!.experiences.at(-1)?.atMonth ?? 0) - (left.procedural!.experiences.at(-1)?.atMonth ?? 0))
        .slice(0, 8).map((fact) => ({ id: fact.id, summary: fact.summary, confidence: fact.confidence, method: structuredClone(fact.procedural!) })),
      knownPlaces: [...person.knownPlaces]
        .sort((a, b) => b.lastConfirmedAtMonth - a.lastConfirmedAtMonth || a.id.localeCompare(b.id))
        .slice(0, 8)
        .map(({ materialId, position, lastConfirmedAtMonth }) => ({ name: materialDefinition(materialId).name, position, lastConfirmedAtMonth })),
      mindMarkdown: context.mind?.markdown ?? person.mindMarkdown ?? '',
      memories: recalledMemories,
      recentMentalActs,
      relationshipEpisodes: [...(person.relationshipEpisodes ?? [])]
        .filter((episode) => counterpartIds.length === 0 || counterpartIds.includes(episode.otherPersonId))
        .sort((left, right) => right.experiencedAtMonth - left.experiencedAtMonth
          || right.id.localeCompare(left.id))
        .slice(0, 8)
        .map((episode) => ({
          otherPersonId: episode.otherPersonId,
          otherPersonName: state.people.find((candidate) => candidate.id === episode.otherPersonId)?.name
            ?? '记忆中的对方',
          experiencedAtMonth: episode.experiencedAtMonth,
          meanings: [...episode.appraisal.meanings],
          interpretation: episode.appraisal.interpretation,
          ...(episode.appraisal.unresolvedExpectation
            ? { unresolvedExpectation: episode.appraisal.unresolvedExpectation }
            : {}),
          ...(episode.appraisal.desiredResponse
            ? { desiredResponse: episode.appraisal.desiredResponse }
            : {}),
          sourceCount: episode.sourceFactIds.length,
        })),
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
    sheltered: Boolean(shelterGeometryAt(state.world.grid, person.position)),
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
      ...(context.activeIntent.plan ? { plan: {
        steps: [...context.activeIntent.plan.steps],
        disposition: context.activeIntent.plan.disposition,
      } } : {}),
      ...(context.activeIntent.outcomeReceipts?.length ? {
        recentOutcomes: context.activeIntent.outcomeReceipts.slice(-4).map((receipt) => ({
          execution: receipt.execution,
          goalProgress: receipt.goalProgress,
          evidence: receipt.evidence,
          atMonth: receipt.atMonth,
        })),
      } : {}),
      ...(context.activeIntent.stateGoalUntilMonth !== undefined ? { stateGoalUntilMonth: context.activeIntent.stateGoalUntilMonth } : {}),
      ...(context.activeIntent.lifecycle ? { lifecycle: {
        completion: context.activeIntent.lifecycle.completion,
        reviewAtMonth: context.activeIntent.lifecycle.reviewAtMonth,
        ...(context.activeIntent.lifecycle.maintainUntilMonth !== undefined
          ? { maintainUntilMonth: context.activeIntent.lifecycle.maintainUntilMonth }
          : {}),
      } } : {}),
    } } : {}),
    recentCompletedWork: state.intents
      .filter((intent) => intent.ownerId === person.id && intent.plan
        && (intent.status === 'completed' || intent.status === 'failed' || intent.status === 'blocked'))
      .sort((left, right) => right.lastProgressAtMonth - left.lastProgressAtMonth
        || right.createdAtMonth - left.createdAtMonth)
      .slice(0, 3)
      .map((intent) => ({
        summary: intent.summary,
        status: intent.status,
        atMonth: intent.lastProgressAtMonth,
        plan: { steps: [...intent.plan!.steps], disposition: intent.plan!.disposition },
        recentOutcomes: (intent.outcomeReceipts ?? []).slice(-4).map((receipt) => ({
          execution: receipt.execution,
          goalProgress: receipt.goalProgress,
          evidence: receipt.evidence,
          atMonth: receipt.atMonth,
        })),
      })),
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
      .map((intent) => ({
        id: intent.id,
        summary: intent.summary,
        progress: intent.progress,
        nextActionKind: intent.nextAction.kind,
        planSourceDecisionEventId: intent.planSourceDecisionEventId ?? intent.sourceDecisionEventId,
        requiresNewSpeech: intentRequiresNewSpeech(state, intent),
        createdAtMonth: intent.createdAtMonth,
        lastProgressAtMonth: intent.lastProgressAtMonth,
        ...(intent.waitingFor ? { waitingFor: intent.waitingFor } : {}),
        ...(intent.plan ? {
          plan: { steps: [...intent.plan.steps], disposition: intent.plan.disposition },
        } : {}),
        ...(intent.outcomeReceipts?.length ? {
          recentOutcomes: intent.outcomeReceipts.slice(-3).map((receipt) => ({
            execution: receipt.execution,
            goalProgress: receipt.goalProgress,
            evidence: receipt.evidence,
            atMonth: receipt.atMonth,
          })),
        } : {}),
      })),
    agreements: state.agreements
      .filter((agreement) => agreement.partyIds.includes(person.id) && (agreement.status === 'proposed' || agreement.status === 'active' || (agreement.resolvedAtMonth ?? -99) >= state.clock.elapsedMonths - 6))
      .sort((a, b) => (b.acceptedAtMonth ?? b.proposedAtMonth) - (a.acceptedAtMonth ?? a.proposedAtMonth))
      .slice(0, 6)
      .map((agreement) => ({
        id: agreement.id, kind: agreement.proposal.kind, status: agreement.status,
        partyIds: agreement.partyIds, proposedAtMonth: agreement.proposedAtMonth,
        pendingResponderNames: agreement.status === 'proposed'
          ? agreement.requiredResponderIds
            .filter((id) => !agreement.acceptedByPersonIds.includes(id) && !agreement.rejectedByPersonIds.includes(id))
            .map((id) => state.people.find((person) => person.id === id)?.name ?? '未知人物')
          : [],
        ...(agreement.dueAtMonth !== undefined ? { dueAtMonth: agreement.dueAtMonth } : {}),
        requiredResponderIds: agreement.requiredResponderIds,
        acceptedByPersonIds: agreement.acceptedByPersonIds,
        rejectedByPersonIds: agreement.rejectedByPersonIds,
        fulfilledByPersonIds: agreement.fulfilledByPersonIds,
      })),
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
      const actionBelief = outcomeBeliefFor(person, cognitiveOutcomeBasisKey(nextAction, option.goal));
      const goalBelief = goalOutcomeBeliefFor(
        person,
        cognitiveOutcomeBasisKey(completionAction ?? nextAction, option.goal),
      );
      const experiencedOutcomes = actionBelief || goalBelief ? {
        ...(actionBelief ? { similarAction: {
          attempts: actionBelief.attempts,
          completed: actionBelief.completed,
          progressed: actionBelief.progressed,
          blocked: actionBelief.blocked,
          failed: actionBelief.failed,
          lastUpdatedAtMonth: actionBelief.lastUpdatedAtMonth,
        } } : {}),
        ...(goalBelief ? { intendedGoal: {
          attempts: goalBelief.attempts,
          achieved: goalBelief.achieved,
          attemptedUnmet: goalBelief.attemptedUnmet,
          lastUpdatedAtMonth: goalBelief.lastUpdatedAtMonth,
        } } : {}),
      } : undefined;
      // Open conversation is only grounded after the model chooses its actual
      // sources. A repetition score computed from the placeholder fallback
      // would describe a different utterance and can wrongly suppress it.
      const repetition = option.openConversationGrounding
        ? undefined
        : assessSocialRepetition(state, person, option);
      const executionProjectFunction = option.projectProposal?.desiredFunction
        ?? (option.projectId ? state.projects.find((project) => project.id === option.projectId)?.desiredFunction : undefined);
      return {
        id, summary, reason, domain, estimatedMonths, risks, target, requiresFollowUp: Boolean(requiresFollowUp),
        ...(option.characterAgendaItemId ? { characterAgendaItemId: option.characterAgendaItemId } : {}),
        ...(option.projectId ? { projectId: option.projectId } : {}),
        ...(executionProjectFunction ? { executionProjectFunction } : {}),
        ...(option.openConversationGrounding
          ? { openConversationGrounding: structuredClone(option.openConversationGrounding) }
          : {}),
        semantics: structuredClone(actionOptionSemantics(option)),
        ...(experiencedOutcomes ? { experiencedOutcomes } : {}),
        ...(nextAction.kind === 'talk'
          ? {
              communicationKind: nextAction.speakerMeaning.kind,
              communicationMeaning: structuredClone(nextAction.speakerMeaning),
              speechAct: speechActFromRepresentation(nextAction.speakerMeaning),
            }
          : completionAction?.kind === 'talk'
            ? {
                communicationKind: completionAction.speakerMeaning.kind,
                communicationMeaning: structuredClone(completionAction.speakerMeaning),
                speechAct: speechActFromRepresentation(completionAction.speakerMeaning),
              }
            : {}),
        ...(nextAction.kind === 'talk' && nextAction.speakerMeaning.kind === 'claim' && nextAction.speakerMeaning.factId
          ? { expressesFactId: nextAction.speakerMeaning.factId }
          : {}),
        ...(repetition?.subjectKey ? { socialHistory: {
          rememberedBefore: Boolean(repetition.previousCommunicationEventId),
          hasNewEvidence: Boolean(repetition.previousCommunicationEventId && repetition.newEvidenceEventIds.length),
          ...(repetition.outcome ? { outcome: repetition.outcome } : {}),
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
      bondTrust: animalBondTrust(state.world, animal.id, person.id),
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
    visibleOpenWorldFacts: (state.world.openFacts ?? [])
      .filter((fact) => {
        const currentCell = openWorldFactCurrentCell(state, fact);
        return currentCell !== undefined
          && Math.abs(cellX(currentCell) - cellX(person.position.cellId))
            + Math.abs(cellY(currentCell) - cellY(person.position.cellId)) <= 7;
      })
      .slice(-6)
      .map((fact) => ({
        summary: fact.summary,
        atMonth: fact.atMonth,
        ...(fact.stateKey ? { stateKey: fact.stateKey } : {}),
        ...(fact.stateValue ? { stateValue: fact.stateValue } : {}),
        ...(fact.targetRef ? { targetKind: fact.targetRef.kind } : {}),
      })),
    visibleWorks: (state.world.works ?? [])
      .filter((work) => context.visibleCells.includes(work.position.x + work.position.y * state.world.grid.width))
      .map((work) => ({
        id: work.id,
        position: { ...work.position },
        summary: work.summary,
        arrangement: work.arrangement,
        condition: work.condition >= 75 ? '材料保存完好' : work.condition >= 40 ? '材料已有磨损' : '材料明显破损',
        conditionValue: work.condition,
        profile: { ...work.profile },
        ...(work.layout ? { layout: work.layout.voxels.map((voxel) => ({ offset: { ...voxel.offset }, materialKey: materialDefinition(voxel.materialId).key })) } : {}),
        createdAtMonth: work.createdAtMonth,
        lastTouchedAtMonth: work.lastTouchedAtMonth,
        builders: work.builderIds
          .map((id) => state.people.find((person) => person.id === id)?.name ?? id)
          .slice(0, 3),
        components: work.components.map((component) => ({
          name: materialDefinition(component.materialId).name,
          materialKey: materialDefinition(component.materialId).key,
          quantity: component.quantity,
        })),
        recentUse: (() => {
          const sources = (work.useReceipts ?? []).flatMap((receipt) => {
            const event = context.currentMonthEvents?.find((event) => event.id === receipt.sourceEventId)
              ?? state.world.past.find((event) => event.id === receipt.sourceEventId);
            return event?.kind === 'action' || event?.kind === 'environment' ? [event] : [];
          });
          return observeWorkAdoption(work, sources, state.clock.elapsedMonths).receipts.slice(-3).flatMap((receipt) => {
            const event = sources.find((event) => event.id === receipt.sourceEventId);
            if (!event) return [];
            const shelterUse = event.kind === 'environment' ? event.diff.shelterUse as Record<string, unknown> | undefined : undefined;
            return [{
              atMonth: receipt.atMonth,
              kind: receipt.kind,
              by: state.people.find((person) => person.id === receipt.actorId)?.name ?? '未知人物',
              result: event.result,
              ...(shelterUse ? { shelterUse: {
                coldLoadWithoutShelter: shelterUse.coldLoadWithoutShelter,
                coldLoad: shelterUse.coldLoad,
                heatLoadWithoutShelter: shelterUse.heatLoadWithoutShelter,
                heatLoad: shelterUse.heatLoad,
                weatherProtection: shelterUse.weatherProtection,
                thermalInsulation: shelterUse.thermalInsulation,
              } } : {}),
            }];
          });
        })(),
      })),
    visibleVoxels,
  };
}
