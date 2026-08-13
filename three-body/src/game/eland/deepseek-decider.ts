import type { BatchDecider, Decision, DecisionContext, TokenUsage } from './simulation';

export interface DecisionRequestContext {
  agent: {
    id: string;
    name: string;
    description: string;
    body: DecisionContext['agent']['body'];
    needs: DecisionContext['agent']['mind']['needs'];
    abilities: DecisionContext['agent']['limbs']['abilities'];
    currentChoice: string;
  };
  clock: { elapsedMonths: number };
  climate: DecisionContext['state']['civilization']['climate'];
  activePlan?: DecisionContext['activePlan'];
  suspendedPlans: Array<{ id: string; objective: string; mode: string; progress: number }>;
  affordances: DecisionContext['affordances'];
  visibleAgents: Array<{ id: string; name: string; state: string; cellId: number }>;
  visibleMatter: Array<{ id: string; kind: string; name: string; quantity: number; cellId: number; traits: string[] }>;
}

export interface DecideApiResponse {
  model: string;
  decided: number;
  total: number;
  decisions: (Decision | null)[];
  usage?: TokenUsage;
}

export function buildDecisionRequestContext(context: DecisionContext): DecisionRequestContext {
  const { agent, state } = context;
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.profile.description.slice(0, 240),
      body: agent.body,
      needs: agent.mind.needs,
      abilities: agent.limbs.abilities,
      currentChoice: agent.mind.cognition.choice.slice(0, 100),
    },
    clock: { elapsedMonths: state.clock.elapsedMonths },
    climate: state.civilization.climate,
    ...(context.activePlan ? { activePlan: context.activePlan } : {}),
    suspendedPlans: state.plans
      .filter((plan) => plan.ownerId === agent.id && plan.status === 'suspended')
      .map(({ id, objective, mode, progress }) => ({ id, objective, mode, progress })),
    affordances: context.affordances,
    visibleAgents: context.visibleAgents.map((other) => ({ id: other.id, name: other.name, state: other.body.state, cellId: other.position.cellId })),
    visibleMatter: context.visibleMatter.map((matter) => ({
      id: matter.id,
      kind: matter.kind,
      name: matter.name,
      quantity: matter.quantity,
      cellId: matter.holder.kind === 'cell' ? matter.holder.cellId : agent.position.cellId,
      traits: matter.traits,
    })),
  };
}

export function createDeepSeekDecider(): BatchDecider {
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
