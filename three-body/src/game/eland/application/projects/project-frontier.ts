import type {
  ProjectFunction,
  ProjectNeed,
  ProjectProposal,
} from '../../domain/project';
import {
  mechanicalPowerNetworkId,
  mechanicalPowerPlanKey,
} from '../../domain/mechanical-power';
import type { ProjectStep } from './project-step';

export interface ExecutableProjectFrontierCandidate {
  proposal: ProjectProposal;
  step: ProjectStep;
}

const PROJECT_FUNCTION_ID_MARKER = '--function-';

/**
 * Project proposals for one person and need used to share an id. Keep the
 * proposal generator's coarse identity intact, but make the accepted plan
 * unambiguous before it can enter intents, projects, or replayable actions.
 */
export function projectProposalWithFunctionIdentity(proposal: ProjectProposal): ProjectProposal {
  const suffix = `${PROJECT_FUNCTION_ID_MARKER}${proposal.desiredFunction}`;
  if (proposal.id.endsWith(suffix)) return proposal;

  const previousId = proposal.id;
  const id = `${previousId}${suffix}`;
  // Installation plans are created while the proposal still has its coarse
  // need identity. Rebind only a plan that points at that exact proposal;
  // maintenance and reliability proposals deliberately carry the original
  // installation project's plan and must keep that external identity.
  if (proposal.mechanicalPowerPlan?.projectId === previousId) {
    const mechanicalPowerPlan = {
      ...proposal.mechanicalPowerPlan,
      projectId: id,
    };
    return {
      ...proposal,
      id,
      mechanicalPowerPlan,
      mechanicalPowerPlanKey: mechanicalPowerPlanKey(mechanicalPowerPlan),
      mechanicalPowerNetworkId: mechanicalPowerNetworkId(mechanicalPowerPlan),
    };
  }

  return { ...proposal, id };
}

/** Preserve pressure as the motive boundary while allowing every tied plan to compile. */
export function projectProposalPressureGroups(proposals: readonly ProjectProposal[]): ProjectProposal[][] {
  const byPressure = new Map<number, ProjectProposal[]>();
  for (const proposal of proposals) {
    const group = byPressure.get(proposal.pressure) ?? [];
    group.push(proposal);
    byPressure.set(proposal.pressure, group);
  }
  return [...byPressure.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, group]) => group);
}

function openingStepHasOutstandingMaterial(step: ProjectStep): boolean {
  return step.missingMaterialIds.length > 0
    || (step.materialDemands ?? []).some((demand) => demand.outstandingQuantity > 0);
}

function currentFrontierRank(
  candidate: ExecutableProjectFrontierCandidate,
  completedFunctions: ReadonlySet<ProjectFunction>,
): number {
  if (openingStepHasOutstandingMaterial(candidate.step)) return 0;
  return completedFunctions.has(candidate.proposal.desiredFunction) ? 1 : 2;
}

/**
 * Reorders only candidates competing for the same need. Slots belonging to
 * other needs retain the proposal generator's seeded order, so this tie-break
 * cannot turn a capability frontier into a civilization-wide priority.
 *
 * A never-completed function wins only when its compiled opening step already
 * has no material deficit. If no such local opportunity exists, replenishment
 * and search keep their original eligibility and order.
 */
export function rankExecutableProjectFrontier<T extends ExecutableProjectFrontierCandidate>(
  candidates: readonly T[],
  completedFunctions: ReadonlySet<ProjectFunction>,
): T[] {
  const rankedByNeed = new Map<ProjectNeed, T[]>();
  for (const candidate of candidates) {
    const needCandidates = rankedByNeed.get(candidate.proposal.need) ?? [];
    needCandidates.push(candidate);
    rankedByNeed.set(candidate.proposal.need, needCandidates);
  }
  for (const [need, needCandidates] of rankedByNeed) {
    rankedByNeed.set(need, needCandidates
      .map((candidate, originalIndex) => ({ candidate, originalIndex }))
      .sort((left, right) => currentFrontierRank(right.candidate, completedFunctions)
        - currentFrontierRank(left.candidate, completedFunctions)
        || left.originalIndex - right.originalIndex)
      .map(({ candidate }) => candidate));
  }

  const nextIndexByNeed = new Map<ProjectNeed, number>();
  return candidates.map((candidate) => {
    const need = candidate.proposal.need;
    const nextIndex = nextIndexByNeed.get(need) ?? 0;
    nextIndexByNeed.set(need, nextIndex + 1);
    return rankedByNeed.get(need)?.[nextIndex] ?? candidate;
  });
}
