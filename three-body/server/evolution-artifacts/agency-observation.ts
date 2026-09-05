import type { ActionFact, SimulationState } from '../../src/game/eland/simulation';
import { isAlive } from '../../src/game/eland/domain/person';
import { observeWorkAdoption } from '../../src/game/eland/domain/works';

function changedPhysicalState(event: ActionFact): boolean {
  const attempt = event.diff.attempt as { worldChanged?: boolean } | undefined;
  if (event.action.kind === 'world-interact' && typeof attempt?.worldChanged === 'boolean') return attempt.worldChanged;
  if (event.pathSegment.length > 1) return true;
  if (event.status !== 'completed') return false;
  if (['move', 'transfer', 'act', 'inscribe'].includes(event.action.kind)) return true;
  return event.action.kind === 'world-interact'
    && Array.isArray(event.diff.appliedEffects)
    && event.diff.appliedEffects.some((effect: { kind?: string }) => effect.kind
      && !['knowledge', 'world-state', 'relation'].includes(effect.kind));
}

/** Observation only. These counts are never goals, rewards or decision weights. */
export function observeAgency(state: SimulationState) {
  const actions = state.world.past.filter((event): event is ActionFact => event.kind === 'action');
  const personMonths = new Map<string, { actionIds: string[]; physical: number; speech: number; observation: number }>();
  for (const event of actions) {
    const key = `${event.who}:${event.atMonth}`;
    const month = personMonths.get(key) ?? { actionIds: [], physical: 0, speech: 0, observation: 0 };
    month.actionIds.push(event.id);
    if (changedPhysicalState(event)) month.physical += 1;
    if (event.status === 'completed' && event.action.kind === 'talk') month.speech += 1;
    if (event.status === 'completed' && (event.action.kind === 'attend'
      || event.action.kind === 'world-interact' && event.action.adjudication.effects.length > 0
        && event.action.adjudication.effects.every((effect) => effect.kind === 'knowledge'))) month.observation += 1;
    personMonths.set(key, month);
  }
  const goals = new Map<string, { personId: string; goal: string; firstMonth: number; lastMonth: number; decisions: number; sourceEventIds: string[] }>();
  for (const event of state.world.past) {
    if (event.kind !== 'decision' || !event.usedModel) continue;
    const goal = event.decision.mentalAct?.goal;
    if (!goal) continue;
    const key = `${event.who}:${goal}`;
    const item = goals.get(key) ?? { personId: event.who, goal, firstMonth: event.atMonth, lastMonth: event.atMonth, decisions: 0, sourceEventIds: [] };
    item.lastMonth = event.atMonth;
    item.decisions += 1;
    item.sourceEventIds.push(event.id);
    goals.set(key, item);
  }
  const worksCreated = actions.filter((event) => event.status === 'completed'
    && Array.isArray(event.diff.appliedEffects)
    && event.diff.appliedEffects.some((effect: { kind?: string }) => effect.kind === 'assemble'));
  return {
    throughMonth: state.clock.elapsedMonths,
    cognition: {
      mindDecisions: state.world.past.filter((event) => event.kind === 'decision' && event.usedModel && !event.planContinuation).length,
      planContinuations: state.world.past.filter((event) => event.kind === 'decision' && event.usedModel && event.planContinuation).length,
      verifiedGoalCompletions: actions.filter((event) => (event.diff.planAssessment as { goal?: string } | undefined)?.goal === 'satisfied')
        .map((event) => event.id),
      unchangedRetries: actions.filter((event) => (event.diff.attempt as { repetition?: string } | undefined)?.repetition === 'unchanged-retry')
        .map((event) => event.id),
    },
    population: {
      living: state.people.filter(isAlive).length,
      bornOnMap: state.people.filter((person) => person.geneticParents.length > 0).length,
      maxGeneration: Math.max(0, ...state.people.map((person) => person.generation)),
      regionalArrivals: state.people.filter((person) => person.origin?.kind === 'regional-arrival').length,
    },
    activity: {
      actionCount: actions.length,
      physicalActionCount: actions.filter(changedPhysicalState).length,
      blockedActionCount: actions.filter((event) => event.status === 'blocked').length,
      physicalPersonMonths: [...personMonths.values()].filter((month) => month.physical > 0).length,
      speechWithoutPhysicalPersonMonths: [...personMonths.values()].filter((month) => month.speech > 0 && month.physical === 0).length,
      observationOnlyPersonMonths: [...personMonths.values()].filter((month) => month.observation > 0 && month.physical === 0 && month.speech === 0).length,
    },
    construction: {
      completedProjects: state.projects.filter((project) => project.status === 'completed').map((project) => ({ id: project.id, summary: project.summary })),
      worksCreated: worksCreated.map((event) => ({ sourceEventId: event.id, atMonth: event.atMonth, who: event.who })),
      survivingWorks: (state.world.works ?? []).map((work) => ({
        id: work.id, name: work.summary, condition: work.condition,
        useReceipts: observeWorkAdoption(work, state.world.past.filter((event) => event.kind === 'action' || event.kind === 'environment'), state.clock.elapsedMonths).receipts.length,
      })),
    },
    agreements: state.agreements.map((agreement) => ({
      id: agreement.id, kind: agreement.proposal.kind, status: agreement.status,
      partyIds: agreement.partyIds, proposedAtMonth: agreement.proposedAtMonth,
      sourceEventIds: agreement.sourceEventIds,
    })),
    // Exact wording only; paraphrased repetitions require reading the transcript.
    repeatedGoals: [...goals.values()].filter((goal) => goal.lastMonth > goal.firstMonth)
      .sort((left, right) => (right.lastMonth - right.firstMonth) - (left.lastMonth - left.firstMonth))
      .slice(0, 12),
  };
}
