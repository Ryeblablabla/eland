import { materialDefinition } from './domain/material';
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
    inventory: Array<{ stackId: string; materialId: number; name: string; quantity: number }>;
  };
  clock: { elapsedMonths: number };
  climate: DecisionContext['state']['civilization']['climate'];
  activeIntent?: { id: string; summary: string; progress: number; nextActionKind: string };
  suspendedIntents: Array<{ id: string; summary: string; progress: number; nextActionKind: string }>;
  options: DecisionContext['options'];
  visiblePeople: Array<{ id: string; name: string; health: number; hydration: number; nutrition: number; cellId: number }>;
  visibleDrops: Array<{ id: string; materialId: number; name: string; quantity: number; cellId: number }>;
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
      inventory: person.inventory.map((stack) => ({ stackId: stack.id, materialId: stack.materialId, name: materialDefinition(stack.materialId).name, quantity: stack.quantity })),
    },
    clock: { elapsedMonths: state.clock.elapsedMonths },
    climate: state.civilization.climate,
    ...(context.activeIntent ? { activeIntent: { id: context.activeIntent.id, summary: context.activeIntent.summary, progress: context.activeIntent.progress, nextActionKind: context.activeIntent.nextAction.kind } } : {}),
    suspendedIntents: state.intents.filter((intent) => intent.ownerId === person.id && intent.status === 'suspended').map((intent) => ({ id: intent.id, summary: intent.summary, progress: intent.progress, nextActionKind: intent.nextAction.kind })),
    options: context.options,
    visiblePeople: context.visiblePeople.map((other) => ({ id: other.id, name: other.name, ...other.body, cellId: other.position.cellId })),
    visibleDrops: context.visibleDrops.map((drop) => ({ id: drop.id, materialId: drop.materialId, name: materialDefinition(drop.materialId).name, quantity: drop.quantity, cellId: drop.cellId })),
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
