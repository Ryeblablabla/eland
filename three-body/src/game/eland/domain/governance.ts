import type { ActionOption, PrimitiveAction } from './action';
import { agreementById, type Agreement } from './agreement';
import { activeMemberIds, activeMembership } from './collective';
import { worldEventById } from './event-index';
import type { MaterialId } from './material';
import type { ActionFact, DecisionAuthorityState, SimulationState } from './model';
import type { PersonId } from './person';
import type { ProjectProgressEvidence, ProjectState, RecurringProjectDutySubject } from './project';
import { projectProgressKindPriority } from './project';
import {
  coordinationPracticeBasisFor,
  recordMandateCoordinationClosureSocialLearning,
} from './social-learning';
import { personById, projectById } from './state-index';

interface DecisionRuleBase {
  id: string;
  collectiveId: string;
  method: 'unanimous';
  mandateDurationMonths: number;
  status: 'active' | 'retired';
  acceptedAtMonth: number;
  proposalAgreementId: string;
  sourceEventIds: string[];
  endedAtMonth?: number;
}

export type DecisionRule = DecisionRuleBase & (
  | { scope: 'coordinate-material'; materialId: MaterialId }
  | { scope: 'assign-recurring-duty'; projectDuty: RecurringProjectDutySubject }
);

interface MandateBase {
  id: string;
  collectiveId: string;
  decisionRuleId: string;
  holderId: PersonId;
  validFromMonth: number;
  validUntilMonth: number;
  status: 'active' | 'expired' | 'ended';
  proposalAgreementId: string;
  sourceEventIds: string[];
  contributionEventIds: string[];
  distributionEventIds: string[];
  /** Index into contributionEventIds after the latest real contribution -> distribution closure. */
  coordinationContributionCursor?: number;
  /** Bounded causal bases for social learning; these confer no extra authority. */
  coordinationClosures?: MandateCoordinationClosure[];
  endedAtMonth?: number;
}

export type Mandate = MandateBase & (
  | {
      scope: 'coordinate-material';
      materialId: MaterialId;
    }
  | {
      scope: 'assign-recurring-duty';
      projectDuty: RecurringProjectDutySubject;
      /** The pre-existing active project accepted with this finite duty. */
      projectId: string;
      dutyProgressEventIds: string[];
      dutyCompletionEventIds: string[];
    }
);

export interface MandateCoordinationClosure {
  version: 'mandate-coordination-closure-v1';
  id: string;
  atMonth: number;
  contributorIds: PersonId[];
  recipientIds: PersonId[];
  contributionEventIds: string[];
  distributionEventIds: string[];
  sourceEventIds: string[];
}

export function activeMandatesFor(
  state: Pick<DecisionAuthorityState, 'clock' | 'collectives'>,
  personId: PersonId,
): Mandate[] {
  return state.collectives.flatMap((collective) => {
    if (!activeMembership(collective, personId)) return [];
    return collective.mandates.filter((mandate) => mandate.status === 'active'
      && state.clock.elapsedMonths <= mandate.validUntilMonth);
  });
}

export function mandateById(state: SimulationState, id: string): Mandate | undefined {
  return state.collectives.flatMap((collective) => collective.mandates).find((mandate) => mandate.id === id);
}

export function recurringDutyProjectMatchesSubject(
  project: Pick<ProjectState, 'kind' | 'desiredFunction'>,
  subject: RecurringProjectDutySubject,
): boolean {
  return project.kind === subject.projectKind && project.desiredFunction === subject.desiredFunction;
}

export function mandateWasExercised(mandate: Mandate): boolean {
  return mandate.scope === 'coordinate-material'
    ? mandate.contributionEventIds.length > 0 && mandate.distributionEventIds.length > 0
    : mandate.dutyProgressEventIds.length > 0 && mandate.dutyCompletionEventIds.length > 0;
}

function optionProgressKinds(option: ActionOption): Set<ProjectProgressEvidence['kind']> {
  const kinds = new Set<ProjectProgressEvidence['kind']>();
  const actions = [option.nextAction, ...(option.completionAction ? [option.completionAction] : [])];
  for (const action of actions) {
    if (action.kind === 'move') {
      kinds.add('logistics-advance');
      continue;
    }
    if (action.kind === 'communicate') {
      if (action.content.kind === 'claim' && action.content.projectKnowledgeResponse) {
        kinds.add('knowledge-contribution');
      }
      if (action.channel === 'record') kinds.add('material-contribution');
      continue;
    }
    // These existing project actions are recorded as material contribution on
    // completion by recordProjectAction. This classifier grants no legality.
    kinds.add('material-contribution');
  }
  const preferred = [...kinds].sort((left, right) => (
    projectProgressKindPriority(right) - projectProgressKindPriority(left)
  ))[0];
  return new Set(preferred ? [preferred] : []);
}

/**
 * Returns the exact active mandate that may raise commitment for an option
 * already compiled as legal. It never creates or rewrites an option/action.
 */
export function recurringDutyMandateForExistingOption(
  state: Pick<DecisionAuthorityState, 'clock' | 'collectives' | 'projects'>,
  personId: PersonId,
  option: ActionOption,
  atMonth: number,
): Extract<Mandate, { scope: 'assign-recurring-duty' }> | undefined {
  if (!option.projectId) return undefined;
  const project = projectById(state, option.projectId);
  if (!project || project.status !== 'active'
    || (project.ownerId !== personId && !project.contributorIds.includes(personId))) return undefined;
  const progressKinds = optionProgressKinds(option);
  return activeMandatesFor(state, personId).find((candidate): candidate is Extract<
    Mandate,
    { scope: 'assign-recurring-duty' }
  > => candidate.scope === 'assign-recurring-duty'
    && candidate.holderId === personId
    && candidate.projectId === project.id
    && atMonth >= candidate.validFromMonth
    && atMonth <= candidate.validUntilMonth
    && recurringDutyProjectMatchesSubject(project, candidate.projectDuty)
    && progressKinds.has(candidate.projectDuty.progressKind));
}

/** 授权只赋予协调目的；它不允许协调者从成员背包强取物质。 */
export function mandateSupportsTransfer(
  state: SimulationState,
  mandate: Mandate | undefined,
  actorId: PersonId,
  action: Extract<PrimitiveAction, { kind: 'transfer' }>,
  atMonth: number,
): 'contribution' | 'distribution' | null {
  if (!mandate || mandate.status !== 'active' || atMonth < mandate.validFromMonth || atMonth > mandate.validUntilMonth) return null;
  if (mandate.scope !== 'coordinate-material') return null;
  if (action.from.kind !== 'person' || action.from.personId !== actorId || action.to.kind !== 'person' || action.materialId !== mandate.materialId) return null;
  const collective = state.collectives.find((candidate) => candidate.id === mandate.collectiveId);
  if (!collective || !activeMembership(collective, actorId) || !activeMembership(collective, action.to.personId)) return null;
  if (actorId !== mandate.holderId && action.to.personId === mandate.holderId) return 'contribution';
  if (actorId === mandate.holderId && action.to.personId !== mandate.holderId) return 'distribution';
  return null;
}

/** A duty is exercised only by the holder's real matching project progress. */
export function recordRecurringDutyProjectProgress(
  state: SimulationState,
  project: ProjectState,
  fact: ActionFact,
  evidence: ProjectProgressEvidence,
): void {
  if (fact.who !== evidence.actorId
    || fact.id !== evidence.eventId
    || (fact.status !== 'progressed' && fact.status !== 'completed')) return;
  const preferredEvidence = (project.progressEvidence ?? [])
    .filter((candidate) => candidate.eventId === fact.id && candidate.actorId === fact.who)
    .sort((left, right) => projectProgressKindPriority(right.kind)
      - projectProgressKindPriority(left.kind))[0];
  if (!preferredEvidence || preferredEvidence.kind !== evidence.kind) return;
  for (const mandate of state.collectives.flatMap((collective) => collective.mandates)) {
    if (mandate.scope !== 'assign-recurring-duty'
      || mandate.status !== 'active'
      || mandate.holderId !== fact.who
      || mandate.projectId !== project.id
      || fact.atMonth < mandate.validFromMonth
      || fact.atMonth > mandate.validUntilMonth
      || !recurringDutyProjectMatchesSubject(project, mandate.projectDuty)
      || mandate.projectDuty.progressKind !== evidence.kind) continue;
    mandate.dutyProgressEventIds = [...new Set([...mandate.dutyProgressEventIds, fact.id])];
    mandate.sourceEventIds = [...new Set([...mandate.sourceEventIds, fact.id])];
  }
}

/** Completion closes the same project episode; progress alone is not an institution. */
export function recordRecurringDutyProjectCompletion(
  state: SimulationState,
  project: ProjectState,
): void {
  if (project.status !== 'completed' || project.completionEventIds.length === 0) return;
  for (const mandate of state.collectives.flatMap((collective) => collective.mandates)) {
    if (mandate.scope !== 'assign-recurring-duty'
      || mandate.status !== 'active'
      || mandate.projectId !== project.id
      || mandate.dutyProgressEventIds.length === 0
      || !recurringDutyProjectMatchesSubject(project, mandate.projectDuty)
      || (project.completedAtMonth ?? Number.POSITIVE_INFINITY) < mandate.validFromMonth
      || (project.completedAtMonth ?? Number.POSITIVE_INFINITY) > mandate.validUntilMonth) continue;
    mandate.dutyCompletionEventIds = [...new Set([
      ...mandate.dutyCompletionEventIds,
      ...project.completionEventIds,
    ])];
    mandate.sourceEventIds = [...new Set([
      ...mandate.sourceEventIds,
      ...project.completionEventIds,
    ])];
  }
}

function activeProposal<T extends 'decision-rule' | 'mandate'>(state: SimulationState, referenceId: string, kind: T) {
  const agreement = agreementById(state, referenceId);
  return agreement?.status === 'active' && agreement.proposal.kind === kind
    ? agreement as Agreement & { proposal: Extract<Agreement['proposal'], { kind: T }> }
    : undefined;
}

function matchesCurrentMembers(state: SimulationState, agreement: Agreement & { proposal: { proposerId: PersonId; requiredApproverIds: PersonId[]; collectiveId: string } }) {
  const collective = state.collectives.find((candidate) => candidate.id === agreement.proposal.collectiveId);
  const members = collective ? activeMemberIds(state, collective) : [];
  const expected = new Set(members.filter((id) => id !== agreement.proposal.proposerId));
  const proposed = new Set(agreement.proposal.requiredApproverIds);
  return collective && members.length >= 2
    && members.includes(agreement.proposal.proposerId)
    && expected.size === proposed.size
    && [...expected].every((id) => proposed.has(id))
    && members.every((id) => agreement.acceptedByPersonIds.includes(id))
    ? { collective, members }
    : null;
}

function fulfillAgreement(agreement: Agreement, fact: ActionFact): void {
  agreement.status = 'fulfilled';
  agreement.resolvedAtMonth = fact.atMonth;
  agreement.fulfillmentEventIds = [...new Set([...agreement.fulfillmentEventIds, fact.id])];
  agreement.fulfilledByPersonIds = [...agreement.partyIds];
}

function closeMandateCoordinationCycle(
  state: SimulationState,
  mandate: Mandate,
  distributionFact: ActionFact,
): void {
  if (distributionFact.action.kind !== 'transfer' || distributionFact.action.to.kind !== 'person') return;
  const cursor = Math.max(0, mandate.coordinationContributionCursor ?? 0);
  const pendingContributionEventIds = mandate.contributionEventIds.slice(cursor);
  if (pendingContributionEventIds.length === 0) return;
  const contributionFacts = pendingContributionEventIds.map((eventId) => worldEventById(state, eventId));
  if (contributionFacts.some((event) => event?.kind !== 'action'
    || event.status !== 'completed'
    || event.action.kind !== 'transfer'
    || event.action.authorizationRef !== mandate.id)) return;
  const contributorIds = [...new Set(contributionFacts.flatMap((event) => (
    event?.kind === 'action' ? [event.who] : []
  )))];
  if (contributorIds.length === 0) return;
  const closure: MandateCoordinationClosure = {
    version: 'mandate-coordination-closure-v1',
    id: `mandate-coordination:${mandate.id}:${distributionFact.id}`,
    atMonth: distributionFact.atMonth,
    contributorIds,
    recipientIds: [distributionFact.action.to.personId],
    contributionEventIds: pendingContributionEventIds,
    distributionEventIds: [distributionFact.id],
    sourceEventIds: [...new Set([...pendingContributionEventIds, distributionFact.id])],
  };
  mandate.coordinationContributionCursor = mandate.contributionEventIds.length;
  mandate.coordinationClosures = [...(mandate.coordinationClosures ?? []), closure].slice(-8);
  recordMandateCoordinationClosureSocialLearning(
    state,
    mandate.holderId,
    closure.contributorIds,
    closure.recipientIds,
    closure.id,
    closure.atMonth,
    closure.sourceEventIds,
  );
}

/** 沟通产生规则与授权；真实转移才算授权被行使。 */
export function recordGovernanceAction(state: SimulationState, fact: ActionFact): void {
  if (fact.status !== 'completed') return;
  if (fact.action.kind === 'transfer' && fact.action.authorizationRef) {
    const mandate = mandateById(state, fact.action.authorizationRef);
    const use = mandateSupportsTransfer(state, mandate, fact.who, fact.action, fact.atMonth);
    if (!mandate || !use) return;
    // A restored legacy mandate may already contain both sides of earlier
    // coordination. Start after that verified prefix instead of replaying it
    // into a newly introduced person-local posterior.
    mandate.coordinationContributionCursor ??= mandate.contributionEventIds.length;
    if (use === 'contribution') mandate.contributionEventIds = [...new Set([...mandate.contributionEventIds, fact.id])];
    else {
      mandate.distributionEventIds = [...new Set([...mandate.distributionEventIds, fact.id])];
      closeMandateCoordinationCycle(state, mandate, fact);
    }
    mandate.sourceEventIds = [...new Set([...mandate.sourceEventIds, fact.id])];
    return;
  }
  if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'accept') return;

  const ruleAgreement = activeProposal(state, fact.action.content.referenceId, 'decision-rule');
  if (ruleAgreement?.proposal.kind === 'decision-rule') {
    const match = matchesCurrentMembers(state, ruleAgreement);
    if (!match || ruleAgreement.proposal.method !== 'unanimous') return;
    const id = `decision-rule:${ruleAgreement.id}`;
    if (!match.collective.decisionRules.some((rule) => rule.id === id)) {
      const common = {
        id,
        collectiveId: match.collective.id,
        method: ruleAgreement.proposal.method,
        mandateDurationMonths: ruleAgreement.proposal.mandateDurationMonths,
        status: 'active' as const,
        acceptedAtMonth: fact.atMonth,
        proposalAgreementId: ruleAgreement.id,
        sourceEventIds: [...new Set([...ruleAgreement.sourceEventIds, fact.id])],
      };
      const rule: DecisionRule = ruleAgreement.proposal.scope === 'coordinate-material'
        ? {
            ...common,
            scope: 'coordinate-material',
            materialId: ruleAgreement.proposal.materialId,
          }
        : {
            ...common,
            scope: 'assign-recurring-duty',
            projectDuty: structuredClone(ruleAgreement.proposal.projectDuty),
          };
      match.collective.decisionRules.push(rule);
    }
    fulfillAgreement(ruleAgreement, fact);
    match.collective.sourceEventIds = [...new Set([...match.collective.sourceEventIds, ...ruleAgreement.sourceEventIds, fact.id])];
    return;
  }

  const mandateAgreement = activeProposal(state, fact.action.content.referenceId, 'mandate');
  if (mandateAgreement?.proposal.kind !== 'mandate') return;
  const match = matchesCurrentMembers(state, mandateAgreement);
  const rule = match?.collective.decisionRules.find((candidate) => candidate.id === mandateAgreement.proposal.decisionRuleId && candidate.status === 'active');
  if (!match || !rule || !match.members.includes(mandateAgreement.proposal.holderId)) return;
  let dutyProject: ProjectState | undefined;
  if (rule.scope === 'assign-recurring-duty') {
    dutyProject = mandateAgreement.proposal.projectId
      ? projectById(state, mandateAgreement.proposal.projectId)
      : undefined;
    const proposer = personById(state, mandateAgreement.proposal.proposerId);
    const holderHasExistingProjectStep = Boolean(dutyProject
      && dutyProject.status === 'active'
      && recurringDutyProjectMatchesSubject(dutyProject, rule.projectDuty)
      && (dutyProject.ownerId === mandateAgreement.proposal.holderId
        || dutyProject.contributorIds.includes(mandateAgreement.proposal.holderId)));
    const supportedDuty = proposer ? coordinationPracticeBasisFor(
      proposer,
      mandateAgreement.proposal.holderId,
      `joint-project-${rule.projectDuty.projectKind}`,
      rule.projectDuty,
    ) : undefined;
    if (!holderHasExistingProjectStep || supportedDuty?.support !== 'supported') return;
  }
  for (const mandate of match.collective.mandates.filter((candidate) => candidate.status === 'active' && candidate.decisionRuleId === rule.id)) {
    mandate.status = 'ended';
    mandate.endedAtMonth = fact.atMonth;
  }
  const common = {
    id: `mandate:${mandateAgreement.id}`,
    collectiveId: match.collective.id,
    decisionRuleId: rule.id,
    holderId: mandateAgreement.proposal.holderId,
    validFromMonth: fact.atMonth,
    validUntilMonth: fact.atMonth + rule.mandateDurationMonths,
    status: 'active' as const,
    proposalAgreementId: mandateAgreement.id,
    sourceEventIds: [...new Set([...mandateAgreement.sourceEventIds, fact.id])],
    contributionEventIds: [],
    distributionEventIds: [],
    coordinationContributionCursor: 0,
    coordinationClosures: [],
  };
  const mandate: Mandate = rule.scope === 'coordinate-material'
    ? {
        ...common,
        scope: 'coordinate-material',
        materialId: rule.materialId,
      }
    : {
        ...common,
        scope: 'assign-recurring-duty',
        projectDuty: structuredClone(rule.projectDuty),
        projectId: dutyProject!.id,
        dutyProgressEventIds: [],
        dutyCompletionEventIds: [],
      };
  match.collective.mandates.push(mandate);
  if (dutyProject && !dutyProject.triggerFactIds.includes(fact.id)) {
    dutyProject.triggerFactIds.push(fact.id);
  }
  fulfillAgreement(mandateAgreement, fact);
  match.collective.sourceEventIds = [...new Set([...match.collective.sourceEventIds, ...mandateAgreement.sourceEventIds, fact.id])];
}

export function advanceGovernanceLifecycle(state: SimulationState, atMonth: number): void {
  for (const collective of state.collectives) {
    for (const mandate of collective.mandates.filter((candidate) => candidate.status === 'active')) {
      const holderActive = Boolean(activeMembership(collective, mandate.holderId)
        && state.people.some((person) => person.id === mandate.holderId && person.diedAtMonth === undefined));
      if (atMonth > mandate.validUntilMonth || !holderActive || collective.status !== 'active') {
        mandate.status = atMonth > mandate.validUntilMonth ? 'expired' : 'ended';
        mandate.endedAtMonth = atMonth;
      }
    }
    if (collective.status === 'dissolved') for (const rule of collective.decisionRules.filter((candidate) => candidate.status === 'active')) {
      rule.status = 'retired';
      rule.endedAtMonth = atMonth;
    }
  }
}
