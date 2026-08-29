import type { Decision, SimulationState } from '../domain/model';
import type { PersonId } from '../domain/person';
import { RulePlanner } from './rule-planner';
import {
  applyExternalClimate,
  type ExternalClimateInput,
} from './simulation/controller';
import { prepareMonth } from './simulation/month-boundary';
import {
  createMonthExecution,
  type MonthExecution,
} from './simulation/month-execution';
import type { ObservationProjector } from './simulation/observation-projector';
import { copyState } from './simulation/state-utils';

export interface FrozenPlayerEmbodimentDecision {
  personId: PersonId;
  decision: Decision;
  usedModel: boolean;
}

export interface PlayerEmbodimentMonthInput {
  state: SimulationState;
  controlledPersonId: PersonId;
  climate: ExternalClimateInput;
  /** Authoritative replay input. When present, local planning must not run again. */
  frozenInitialDecisions?: readonly FrozenPlayerEmbodimentDecision[];
}

export interface PreparedPlayerEmbodimentMonth {
  execution: MonthExecution;
  frozenInitialDecisions: FrozenPlayerEmbodimentDecision[];
}

/**
 * Builds one isolated, replayable month for limited player embodiment.
 * The committed input is cloned exactly once; climate and all month mutations
 * are applied only to that staged copy.
 */
export function preparePlayerEmbodimentMonth(
  observationProjector: ObservationProjector,
  input: PlayerEmbodimentMonthInput,
): PreparedPlayerEmbodimentMonth {
  const working = copyState(input.state);
  applyExternalClimate(working, input.climate);
  const prepared = prepareMonth(working, false, true);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  const frozenInitialDecisions: FrozenPlayerEmbodimentDecision[] = [];

  if (input.frozenInitialDecisions) {
    for (const item of input.frozenInitialDecisions) {
      decisions.set(item.personId, {
        decision: structuredClone(item.decision),
        usedModel: item.usedModel,
      });
      frozenInitialDecisions.push(structuredClone(item));
    }
  } else {
    const planner = new RulePlanner();
    for (const context of prepared.candidates) {
      if (context.person.id === input.controlledPersonId) continue;
      const decision = planner.decideAt(context, {
        atMonth: prepared.atMonth,
        planningTick: 1,
      });
      decisions.set(context.person.id, { decision, usedModel: false });
      frozenInitialDecisions.push({
        personId: context.person.id,
        decision,
        usedModel: false,
      });
    }
  }

  return {
    execution: createMonthExecution({
      observationProjector,
      prepared,
      decisions,
      usage: { inputTokens: 0, outputTokens: 0 },
      attempted: { total: 0, ordinary: 0, exempt: 0 },
      controlledPersonId: input.controlledPersonId,
      projectionCadence: 'monthly',
    }),
    frozenInitialDecisions,
  };
}
