import type {
  AgentState,
  BatchDecider,
  Decision,
  DecisionContext,
  MatterState,
  SimulationState,
} from "./simulation";

export type DecideApiResponse = {
  model: string;
  decided: number;
  total: number;
  decisions: (Decision | null)[];
};

const MAX_INTERPRETATIONS = 18;
const MAX_KNOWLEDGE = 18;
const MAX_HYPOTHESES = 12;
const MAX_SOURCE_IDS = 12;
const MAX_MATTER = 320;

function tail<T>(items: T[] | undefined, max: number): T[] {
  return (items ?? []).slice(-max);
}

function compactAgent(agent: AgentState): AgentState {
  return {
    ...agent,
    mind: {
      needs: { ...agent.mind.needs, focus: agent.mind.needs.focus.slice(0, 64) },
      affect: {
        ...agent.mind.affect,
        sourceEventIds: tail(agent.mind.affect.sourceEventIds, MAX_SOURCE_IDS),
        supportEventIds: tail(agent.mind.affect.supportEventIds, MAX_SOURCE_IDS),
      },
      cognition: {
        perception: agent.mind.cognition.perception.slice(0, 96),
        choice: agent.mind.cognition.choice.slice(0, 64),
        interpretation: agent.mind.cognition.interpretation.slice(0, 140),
        interpretations: tail(agent.mind.cognition.interpretations, MAX_INTERPRETATIONS).map((item) => ({
          ...item,
          factIds: tail(item.factIds, MAX_SOURCE_IDS),
          interpretation: item.interpretation.slice(0, 160),
        })),
        knowledge: tail(agent.mind.cognition.knowledge, MAX_KNOWLEDGE).map((item) => ({
          ...item,
          claim: item.claim.slice(0, 180),
          sourceEventIds: tail(item.sourceEventIds, MAX_SOURCE_IDS),
        })),
        hypotheses: tail(agent.mind.cognition.hypotheses, MAX_HYPOTHESES).map((item) => ({
          ...item,
          claim: item.claim.slice(0, 180),
          sourceEventIds: tail(item.sourceEventIds, MAX_SOURCE_IDS),
        })),
        memory: {
          ...agent.mind.cognition.memory,
          episodic: agent.mind.cognition.memory.episodic.map((fragment) => ({ ...fragment, summary: fragment.summary.slice(0, 180), sourceEventIds: tail(fragment.sourceEventIds, MAX_SOURCE_IDS) })),
          summaries: agent.mind.cognition.memory.summaries.map((summary) => ({ ...summary, summary: summary.summary.slice(0, 180), lessons: summary.lessons.slice(0, 6), sourceEventIds: tail(summary.sourceEventIds, MAX_SOURCE_IDS) })),
        },
      },
    },
    limbs: {
      ...agent.limbs,
      actionText: agent.limbs.actionText.slice(0, 80),
    },
    relations: agent.relations.map((relation) => ({
      ...relation,
      sourceEventIds: tail(relation.sourceEventIds, MAX_SOURCE_IDS),
    })),
  };
}

function compactMatter(item: MatterState): MatterState {
  const { bodyEffect: _hiddenBodyEffect, ...visible } = item;
  return {
    ...visible,
    name: item.name.slice(0, 64),
    traits: item.traits.slice(0, 12),
    sourceEventIds: item.sourceEventIds ? tail(item.sourceEventIds, MAX_SOURCE_IDS) : undefined,
    records: item.records
      ? tail(item.records, 8).map((record) => ({
          ...record,
          sourceEventIds: tail(record.sourceEventIds, MAX_SOURCE_IDS),
          note: record.note.slice(0, 120),
        }))
      : undefined,
  };
}

/**
 * The simulator keeps an intentionally complete, auditable state. The model
 * only needs a bounded decision view; sending the audit log verbatim makes
 * long-running civilizations exceed the API gateway body limit.
 */
export function buildDecisionRequestState(input: SimulationState): SimulationState {
  const agents = input.agents.map(compactAgent);
  const activeLocations = new Set(agents.map((agent) => agent.locationId));
  const matter = input.world.matter
    .filter((item) => (
      item.kind !== "metabolized" && (
        item.holder.kind === "agent" ||
        activeLocations.has(item.holder.id) ||
        item.quantity > 0 ||
        Boolean(item.construction) ||
        Boolean(item.records?.length) ||
        item.traits.includes("instrument")
      )
    ))
    .map(compactMatter);
  const prioritizedMatter = [
    ...matter.filter((item) => item.holder.kind === "agent" || activeLocations.has(item.holder.id)),
    ...matter.filter((item) => item.holder.kind === "space" && !activeLocations.has(item.holder.id)),
  ].slice(0, MAX_MATTER);

  return {
    ...input,
    world: {
      time: {
        present: input.world.time.present,
        past: [],
      },
      space: {
        locations: input.world.space.locations.map((location) => ({
          ...location,
          neighbors: location.neighbors.slice(),
        })),
        routes: input.world.space.routes.map(({ id, from, to, traffic, state }) => ({ id, from, to, traffic, state, sourceEventIds: [] })),
      },
      matter: prioritizedMatter,
    },
    agents,
    derived: { practices: [], institutions: [], milestones: [], issues: [] },
    lastStep: [],
  };
}

export function createDeepSeekDecider(): BatchDecider {
  return {
    async decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]> {
      if (!contexts.length) return [];
      const response = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contexts: contexts.map((context) => ({ agentId: context.agent.id, state: buildDecisionRequestState(context.state) })) }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`决策服务返回 ${response.status}${detail ? `：${detail.slice(0, 120)}` : ""}`);
      }
      const data = (await response.json()) as DecideApiResponse;
      if (!Array.isArray(data.decisions)) throw new Error("决策服务返回格式异常");
      return data.decisions;
    },
  };
}
