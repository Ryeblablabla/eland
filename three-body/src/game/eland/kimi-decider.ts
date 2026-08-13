import { materialDefinition, type MaterialTag } from './domain/material';
import { projectMemories } from './domain/memory';
import type { BatchDecider, Decision, DecisionContext, TokenUsage } from './simulation';

export interface DecisionRequestContext {
  person: {
    id: string;
    name: string;
    description: string;
    body: DecisionContext['person']['body'];
    conditions: DecisionContext['person']['conditions'];
    capacities: DecisionContext['person']['baselineCapacities'];
    drives: DecisionContext['person']['driveBias'];
    currentChoice: string;
    inventory: Array<{ stackId: string; materialId: number; name: string; properties: MaterialTag[]; quantity: number }>;
    knowledge: Array<{ id: string; summary: string; confidence: number }>;
    memories: ReturnType<typeof projectMemories>;
  };
  clock: { elapsedMonths: number };
  climate: DecisionContext['state']['civilization']['climate'];
  activePressures: Array<{ kind: string; stage: number; consequences: string[] }>;
  activeIntent?: { id: string; summary: string; progress: number; nextActionKind: string };
  suspendedIntents: Array<{ id: string; summary: string; progress: number; nextActionKind: string }>;
  agreements: Array<{
    id: string; kind: string; status: string; partyIds: string[]; dueAtMonth?: number; fulfilledByPersonIds: string[];
  }>;
  collectives: Array<{ id: string; purposeSummary: string; status: string; activeMemberIds: string[]; joinedAtMonth: number }>;
  permissions: Array<{ id: string; grantorId: string; granteeId: string; materialId: number; validUntilMonth: number; status: string }>;
  options: Array<{
    id: string; summary: string; reason: string; domain?: 'strategic' | 'social';
    estimatedMonths?: number; risks?: string[]; target?: DecisionContext['options'][number]['target']; requiresFollowUp: boolean;
  }>;
  followUpOptions: Array<{
    id: string; summary: string; reason: string; domain?: 'strategic' | 'social';
    estimatedMonths?: number; risks?: string[]; target?: DecisionContext['options'][number]['target'];
  }>;
  visiblePeople: Array<{ id: string; name: string; health: number; hydration: number; nutrition: number; cellId: number; trust: number; bond: number; fear: number }>;
  visibleDrops: Array<{ id: string; materialId: number; name: string; properties: MaterialTag[]; quantity: number; cellId: number }>;
}

function pressureConsequences(kind: string, stage: number): string[] {
  if (kind === 'cold') return ['营养消耗加速', '操作与移动能力下降', ...(stage >= 3 ? ['每月损失健康'] : [])];
  if (kind === 'heat') return ['水分消耗加速', '操作与移动能力下降', ...(stage >= 3 ? ['每月损失健康'] : [])];
  if (kind === 'wound') return ['行动能力下降', ...(stage >= 2 ? ['持续损失健康并增加患病风险'] : [])];
  if (kind === 'illness') return ['水分与营养消耗加速', '行动能力下降', ...(stage >= 2 ? ['持续损失健康'] : [])];
  if (kind === 'aging') return ['恢复与行动能力下降', ...(stage >= 2 ? ['匮乏时额外损失健康'] : [])];
  if (kind === 'pregnancy') return ['水分与营养消耗增加', ...(stage >= 2 ? ['行动能力下降'] : [])];
  if (kind === 'restrained') return ['无法正常移动', '只能近身尝试分离拘束物质或等待他人解除'];
  return [];
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
  return {
    person: {
      id: person.id,
      name: person.name,
      description: person.profile.description.slice(0, 240),
      body: person.body,
      conditions: person.conditions,
      capacities: person.baselineCapacities,
      drives: person.driveBias,
      currentChoice: person.lastDecisionText.slice(0, 140),
      inventory: person.inventory.map((stack) => {
        const material = materialDefinition(stack.materialId);
        return { stackId: stack.id, materialId: stack.materialId, name: material.name, properties: [...material.tags], quantity: stack.quantity };
      }),
      knowledge: person.knowledge.sort((a, b) => b.confidence - a.confidence).slice(0, 6).map(({ id, summary, confidence }) => ({ id, summary, confidence })),
      memories: projectMemories(person, state.clock.elapsedMonths),
    },
    clock: { elapsedMonths: state.clock.elapsedMonths },
    climate: state.civilization.climate,
    activePressures: person.conditions.map((condition) => ({
      kind: condition.kind,
      stage: condition.stage,
      consequences: pressureConsequences(condition.kind, condition.stage),
    })),
    ...(context.activeIntent ? { activeIntent: { id: context.activeIntent.id, summary: context.activeIntent.summary, progress: context.activeIntent.progress, nextActionKind: context.activeIntent.nextAction.kind } } : {}),
    suspendedIntents: state.intents.filter((intent) => intent.ownerId === person.id && intent.status === 'suspended').map((intent) => ({ id: intent.id, summary: intent.summary, progress: intent.progress, nextActionKind: intent.nextAction.kind })),
    agreements: state.agreements
      .filter((agreement) => agreement.partyIds.includes(person.id) && (agreement.status === 'proposed' || agreement.status === 'active' || (agreement.resolvedAtMonth ?? -99) >= state.clock.elapsedMonths - 6))
      .sort((a, b) => (b.acceptedAtMonth ?? b.proposedAtMonth) - (a.acceptedAtMonth ?? a.proposedAtMonth))
      .slice(0, 6)
      .map((agreement) => ({ id: agreement.id, kind: agreement.proposal.kind, status: agreement.status, partyIds: agreement.partyIds, ...(agreement.dueAtMonth !== undefined ? { dueAtMonth: agreement.dueAtMonth } : {}), fulfilledByPersonIds: agreement.fulfilledByPersonIds })),
    collectives: state.collectives.flatMap((collective) => {
      const own = collective.memberships.find((membership) => membership.personId === person.id && membership.status === 'active');
      return own ? [{
        id: collective.id,
        purposeSummary: collective.purposeSummary,
        status: collective.status,
        activeMemberIds: collective.memberships.filter((membership) => membership.status === 'active').map((membership) => membership.personId),
        joinedAtMonth: own.joinedAtMonth,
      }] : [];
    }),
    permissions: state.permissions
      .filter((permission) => permission.status === 'active' && (permission.grantorId === person.id || permission.granteeId === person.id))
      .map(({ id, grantorId, granteeId, materialId, validUntilMonth, status }) => ({ id, grantorId, granteeId, materialId, validUntilMonth, status })),
    options: context.options.map(({ id, summary, reason, domain, estimatedMonths, risks, target, requiresFollowUp }) => ({ id, summary, reason, domain, estimatedMonths, risks, target, requiresFollowUp: Boolean(requiresFollowUp) })),
    followUpOptions: context.followUpOptions.map(({ id, summary, reason, domain, estimatedMonths, risks, target }) => ({ id, summary, reason, domain, estimatedMonths, risks, target })),
    visiblePeople: context.visiblePeople.map((other) => {
      const relation = person.relations.find((item) => item.personId === other.id);
      return { id: other.id, name: other.name, ...other.body, cellId: other.position.cellId, trust: relation?.trust ?? 0, bond: relation?.bond ?? 0, fear: relation?.fear ?? 0 };
    }),
    visibleDrops: context.visibleDrops.map((drop) => {
      const material = materialDefinition(drop.materialId);
      return { id: drop.id, materialId: drop.materialId, name: material.name, properties: [...material.tags], quantity: drop.quantity, cellId: drop.cellId };
    }),
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
