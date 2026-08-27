import { materialDefinition } from './domain/material';
import { perceiveMaterial, type PerceivedMaterialProfile } from './domain/material-perception';
import { projectMemories } from './domain/memory';
import { ageMonths } from './domain/person';
import { effectivePersonality } from './domain/personality';
import type { BatchDecider, Decision, DecisionContext, TokenUsage } from './simulation';
import { CONTAINER_CAPACITY } from './domain/container';
import { assessSocialRepetition } from './domain/social-repetition';
import { buildPersonSoul } from './domain/person-soul';
import { cognitionStateOf, outcomeBeliefSuccess } from './domain/cognition';
import { buildCognitiveFrame } from './application/cognition/option-appraisal';
import { speechActFromRepresentation } from './projection/speech-act';
import type { SpeechActView } from '../societyContract';
import { traitDefinition, traitStatesOf } from './domain/trait';
import { relationTo } from './domain/relation';
import { actionOptionSemantics } from './domain/action-option-semantics';
import { projectMaterialPlanProvenance } from './application/projects/project-material-provenance';

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
    currentChoice: string;
    currentAction: string;
    position: { cellId: number; z: number };
    inventory: Array<{ stackId: string; name: string; properties: string[]; perception: PerceivedMaterialProfile; quantity: number }>;
    knowledge: Array<{ id: string; summary: string; confidence: number }>;
    knownPlaces: Array<{ name: string; position: { x: number; y: number; z: number }; lastConfirmedAtMonth: number }>;
    memories: ReturnType<typeof projectMemories>;
    cognition: ReturnType<typeof buildDecisionCognitionProjection>;
    kinship: {
      parents: Array<{ id: string; name: string; sex: DecisionContext['person']['sex']; relation: 'mother' | 'father' }>;
      children: Array<{ id: string; name: string; sex: DecisionContext['person']['sex']; relation: 'daughter' | 'son' }>;
      siblings: Array<{
        id: string; name: string; sex: DecisionContext['person']['sex']; relation: 'sister' | 'brother';
        fullSibling: boolean; sharedParentIds: string[];
      }>;
    };
  };
  clock: { elapsedMonths: number };
  climate: DecisionContext['state']['civilization']['climate'];
  epoch: DecisionContext['state']['civilization']['epoch'];
  weather: DecisionContext['state']['civilization']['weather'];
  activePressures: Array<{ kind: string; stage: number; consequences: string[] }>;
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
    communicationKind?: 'claim' | 'prediction' | 'request' | 'offer' | 'accept' | 'reject' | 'revoke-agreement' | 'revoke' | 'withdraw';
    speechAct?: SpeechActView;
    communicatesFactId?: string;
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

export interface DecideApiResponse {
  model: string;
  decided: number;
  total: number;
  decisions: (Decision | null)[];
  usage?: TokenUsage;
}

export function buildDecisionRequestContext(context: DecisionContext): DecisionRequestContext {
  const { person, state } = context;
  const activeProject = context.activeIntent?.projectId
    ? state.projects.find((project) => project.id === context.activeIntent?.projectId)
    : undefined;
  const activeProjectProvenance = activeProject
    ? projectMaterialPlanProvenance(state, person, activeProject)
    : null;
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
      knowledge: [...person.knowledge].sort((a, b) => b.confidence - a.confidence).slice(0, 6).map(({ id, summary, confidence }) => ({ id, summary, confidence })),
      knownPlaces: [...person.knownPlaces]
        .sort((a, b) => b.lastConfirmedAtMonth - a.lastConfirmedAtMonth || a.id.localeCompare(b.id))
        .slice(0, 8)
        .map(({ materialId, position, lastConfirmedAtMonth }) => ({ name: materialDefinition(materialId).name, position, lastConfirmedAtMonth })),
      memories: projectMemories(person, state.clock.elapsedMonths),
      cognition: buildDecisionCognitionProjection(context),
      kinship: immediateKinship(state, person),
    },
    clock: { elapsedMonths: state.clock.elapsedMonths },
    climate: state.civilization.climate,
    epoch: state.civilization.epoch,
    weather: state.civilization.weather,
    activePressures: person.conditions.map((condition) => ({
      kind: condition.kind,
      stage: condition.stage,
      consequences: pressureConsequences(condition.kind, condition.stage),
    })),
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
      const repetition = assessSocialRepetition(state, person, option);
      return {
        id, summary, reason, domain, estimatedMonths, risks, target, requiresFollowUp: Boolean(requiresFollowUp),
        semantics: structuredClone(actionOptionSemantics(option)),
        ...(nextAction.kind === 'communicate'
          ? {
              communicationKind: nextAction.content.kind,
              speechAct: speechActFromRepresentation(nextAction.content),
            }
          : completionAction?.kind === 'communicate'
            ? {
                communicationKind: completionAction.content.kind,
                speechAct: speechActFromRepresentation(completionAction.content),
              }
            : {}),
        ...(nextAction.kind === 'communicate' && nextAction.content.kind === 'claim' && nextAction.content.factId
          ? { communicatesFactId: nextAction.content.factId }
          : {}),
        ...(repetition.subjectKey ? { socialRepetition: {
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
    followUpOptions: context.followUpOptions.map(({ id, summary, reason, domain, estimatedMonths, risks, target }) => ({ id, summary, reason, domain, estimatedMonths, risks, target })),
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
  };
}

export function createKimiDecider(): BatchDecider {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  return {
    async decideAll(contexts) {
      if (!contexts.length) return [];
      const response = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contexts: contexts.map(buildDecisionRequestContext) }),
      });
      if (!response.ok) throw new Error(`决策服务返回 ${response.status}`);
      const data = await response.json() as DecideApiResponse;
      usage = data.usage ?? usage;
      return data.decisions;
    },
    takeUsage() {
      const result = usage;
      usage = { inputTokens: 0, outputTokens: 0 };
      return result;
    },
  };
}
