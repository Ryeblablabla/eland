import type { ActionOption, PrimitiveAction } from './action';

/**
 * Planner-facing meaning carried by an option independently of its opaque id.
 *
 * Option ids remain stable handles for sorting, selection and replay only.  Any
 * policy that needs to know whether an option is a response, a commitment,
 * reproduction, a conversation edge, or age-appropriate must read this value.
 */
export interface ActionOptionSemanticsV1 {
  version: 'action-option-semantics-v1';
  obligation: 'optional' | 'required-response' | 'commitment-action';
  planningChannel: 'ordinary' | 'edge';
  purpose:
    | 'homeostasis'
    | 'safety'
    | 'resource'
    | 'care'
    | 'inquiry'
    | 'project'
    | 'conversation'
    | 'reproduction'
    | 'social-coordination'
    | 'mortuary-care'
    | 'spatial-comfort'
    | 'movement'
    | 'production'
    | 'other';
  minimumLifeStage: 'learning-child' | 'adolescent' | 'adult';
  needKinds: Array<
    | 'homeostasis'
    | 'safety'
    | 'spatial-comfort'
    | 'care'
    | 'bereavement'
    | 'reserve'
    | 'capability'
    | 'commitment'
    | 'belonging'
    | 'generativity'
    | 'autonomy'
    | 'inquiry'
  >;
  conversation?: {
    turn: 'opening' | 'response';
    topic?: string;
  };
  reproduction?: {
    direction: 'proceed' | 'refuse';
    phase: 'proposal' | 'response' | 'attempt' | 'withdrawal';
    mode: 'mutual' | 'unilateral-trait';
  };
  /** Current typed social situation only; it never records an observer outcome. */
  socialContext?: {
    cooperationKind:
      | 'assist'
      | 'exchange'
      | 'conversation'
      | 'joint-project'
      | 'material-coordination'
      | 'reproduction'
      | 'companion'
      | 'collective'
      | 'membership'
      | 'governance'
      | 'other';
    phase: 'proposal' | 'response' | 'fulfillment' | 'withdrawal' | 'opening' | 'continuation';
    counterpartIds: string[];
    referenceId?: string;
    assistNeed?: 'water' | 'food' | 'shelter' | 'company';
    conversationTopic?: string;
    projectId?: string;
    projectKind?: string;
    materialId?: number;
  };
  edgeTrigger?:
    | 'required-response'
    | 'commitment-action'
    | 'record-use'
    | 'technique-demonstration'
    | 'project-knowledge-response'
    | 'conversation-response';
}

export type ActionOptionSemanticOverride = Partial<Omit<ActionOptionSemanticsV1, 'version'>>;

const NEED_ORDER: ActionOptionSemanticsV1['needKinds'] = [
  'homeostasis',
  'safety',
  'spatial-comfort',
  'care',
  'bereavement',
  'reserve',
  'capability',
  'commitment',
  'belonging',
  'generativity',
  'autonomy',
  'inquiry',
];

const OBLIGATIONS = ['optional', 'required-response', 'commitment-action'] as const;
const PLANNING_CHANNELS = ['ordinary', 'edge'] as const;
const PURPOSES = [
  'homeostasis',
  'safety',
  'resource',
  'care',
  'inquiry',
  'project',
  'conversation',
  'reproduction',
  'social-coordination',
  'mortuary-care',
  'spatial-comfort',
  'movement',
  'production',
  'other',
] as const;
const MINIMUM_LIFE_STAGES = ['learning-child', 'adolescent', 'adult'] as const;
const CONVERSATION_TURNS = ['opening', 'response'] as const;
const REPRODUCTION_DIRECTIONS = ['proceed', 'refuse'] as const;
const REPRODUCTION_PHASES = ['proposal', 'response', 'attempt', 'withdrawal'] as const;
const REPRODUCTION_MODES = ['mutual', 'unilateral-trait'] as const;
const COOPERATION_KINDS = [
  'assist',
  'exchange',
  'conversation',
  'joint-project',
  'material-coordination',
  'reproduction',
  'companion',
  'collective',
  'membership',
  'governance',
  'other',
] as const;
const SOCIAL_PHASES = ['proposal', 'response', 'fulfillment', 'withdrawal', 'opening', 'continuation'] as const;
const ASSIST_NEEDS = ['water', 'food', 'shelter', 'company'] as const;
const EDGE_TRIGGERS = [
  'required-response',
  'commitment-action',
  'record-use',
  'technique-demonstration',
  'project-knowledge-response',
  'conversation-response',
] as const;

function semanticRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function semanticEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as T;
}

function optionalSemanticString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label} must be a string`);
}

function semanticStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a string array`);
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} must be a string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value;
}

function executionAction(option: Pick<ActionOption, 'nextAction' | 'completionAction'>): PrimitiveAction {
  return option.completionAction ?? option.nextAction;
}

function communicationAction(option: Pick<ActionOption, 'nextAction' | 'completionAction'>) {
  const action = executionAction(option);
  return action.kind === 'talk' ? action : undefined;
}

function acceptedAuthorization(option: Pick<ActionOption, 'nextAction' | 'completionAction'>): string | undefined {
  const action = executionAction(option);
  return action.kind === 'act' || action.kind === 'transfer'
    ? action.authorizationRef
    : undefined;
}

function inferredReproduction(
  option: Pick<ActionOption, 'nextAction' | 'completionAction' | 'relationshipBasis'>,
): ActionOptionSemanticsV1['reproduction'] | undefined {
  const action = executionAction(option);
  if (action.kind === 'act' && action.operation === 'reproduce') return {
    direction: 'proceed',
    phase: 'attempt',
    mode: action.authorizationRef ? 'mutual' : 'unilateral-trait',
  };
  if (action.kind !== 'talk') return undefined;
  const content = action.speakerMeaning;
  if ((content.kind === 'request' || content.kind === 'offer')
    && content.proposal?.kind === 'reproduce') return {
    direction: 'proceed',
    phase: 'proposal',
    mode: 'mutual',
  };
  if (option.relationshipBasis?.kind !== 'reproduce') return undefined;
  if (content.kind === 'accept') return {
    direction: 'proceed',
    phase: 'response',
    mode: 'mutual',
  };
  if (content.kind === 'reject') return {
    direction: 'refuse',
    phase: 'response',
    mode: 'mutual',
  };
  return undefined;
}

function normalizedSocialContext(
  context: ActionOptionSemanticsV1['socialContext'],
): ActionOptionSemanticsV1['socialContext'] {
  if (!context) return undefined;
  return {
    ...context,
    counterpartIds: [...new Set(context.counterpartIds)].sort(),
  };
}

function inferredSocialContext(
  option: Pick<ActionOption, 'nextAction' | 'completionAction' | 'target' | 'relationshipBasis' | 'projectId' | 'projectProposal'>,
  reproduction: ActionOptionSemanticsV1['reproduction'],
): ActionOptionSemanticsV1['socialContext'] {
  const action = executionAction(option);
  const targetId = option.target?.kind === 'person' ? option.target.personId : undefined;
  if (action.kind === 'act' && action.techniqueDemonstration) return normalizedSocialContext({
    cooperationKind: 'joint-project',
    phase: 'fulfillment',
    counterpartIds: [action.techniqueDemonstration.learnerId],
    referenceId: action.techniqueDemonstration.requestEventId,
    projectId: action.techniqueDemonstration.projectId,
    projectKind: 'technique-demonstration',
  });
  if (action.kind === 'transfer' && action.authorizationRef) return normalizedSocialContext({
    cooperationKind: 'material-coordination',
    phase: 'fulfillment',
    counterpartIds: targetId ? [targetId] : [],
    referenceId: action.authorizationRef,
    materialId: action.materialId,
  });
  if (action.kind !== 'talk') {
    if (!reproduction) return undefined;
    return normalizedSocialContext({
      cooperationKind: 'reproduction',
      phase: reproduction.phase === 'withdrawal' ? 'withdrawal' : 'fulfillment',
      counterpartIds: targetId ? [targetId] : [],
      ...(acceptedAuthorization(option) ? { referenceId: acceptedAuthorization(option) } : {}),
    });
  }
  const content = action.speakerMeaning;
  const counterpartIds = [...new Set([
    ...(option.target?.kind === 'person' ? [option.target.personId] : []),
    ...(targetId ? [targetId] : []),
  ])];
  if (content.kind === 'claim' && content.conversation) return normalizedSocialContext({
    cooperationKind: 'conversation',
    phase: content.conversation.turn === 'opening' ? 'opening' : 'response',
    counterpartIds,
    ...(content.conversation.referenceEventId ? { referenceId: content.conversation.referenceEventId } : {}),
    conversationTopic: content.conversation.topic,
  });
  if (content.kind === 'claim' && content.projectKnowledgeResponse) return normalizedSocialContext({
    cooperationKind: 'joint-project',
    phase: 'response',
    counterpartIds,
    referenceId: content.projectKnowledgeResponse.requestEventId,
    projectId: content.projectKnowledgeResponse.projectId,
    projectKind: 'knowledge-response',
    materialId: content.projectKnowledgeResponse.outputMaterialId,
  });
  if (content.kind === 'request' && content.techniqueDemonstration) return normalizedSocialContext({
    cooperationKind: 'joint-project',
    phase: 'proposal',
    counterpartIds,
    projectId: content.techniqueDemonstration.projectId,
    projectKind: 'technique-demonstration',
  });
  if (content.kind === 'request' && content.projectKnowledgeRequest) return normalizedSocialContext({
    cooperationKind: 'joint-project',
    phase: 'proposal',
    counterpartIds,
    projectId: content.projectKnowledgeRequest.projectId,
    projectKind: 'knowledge-request',
    materialId: content.projectKnowledgeRequest.outputMaterialId,
  });
  if (content.kind === 'request' && content.projectMaterialContribution) return normalizedSocialContext({
    cooperationKind: 'joint-project',
    phase: 'proposal',
    counterpartIds,
    projectId: content.projectMaterialContribution.projectId,
    projectKind: 'material-contribution',
    materialId: content.projectMaterialContribution.materialId,
  });
  if ((content.kind === 'request' || content.kind === 'offer') && content.proposal) {
    const proposal = content.proposal;
    const cooperationKind = proposal.kind === 'reproduce'
      ? 'reproduction'
      : proposal.kind === 'decision-rule'
      || proposal.kind === 'mandate'
      || proposal.kind === 'permission'
      ? 'governance'
      : proposal.kind;
    return normalizedSocialContext({
      cooperationKind,
      phase: 'proposal',
      counterpartIds,
      referenceId: content.id,
      ...(proposal.kind === 'assist' ? { assistNeed: proposal.need } : {}),
      ...(proposal.kind === 'exchange' ? { materialId: proposal.offererMaterialId } : {}),
      ...(proposal.kind === 'permission'
        || (proposal.kind === 'decision-rule' && proposal.scope === 'coordinate-material')
        ? { materialId: proposal.materialId }
        : {}),
      ...(proposal.kind === 'mandate' && proposal.projectId
        ? { projectId: proposal.projectId, projectKind: 'recurring-duty' }
        : {}),
    });
  }
  if (content.kind === 'accept' || content.kind === 'reject') return normalizedSocialContext({
    cooperationKind: reproduction ? 'reproduction' : 'other',
    phase: 'response',
    counterpartIds,
    referenceId: content.referenceId,
  });
  if (content.kind === 'revoke-agreement') return normalizedSocialContext({
    cooperationKind: reproduction ? 'reproduction' : 'other',
    phase: 'withdrawal',
    counterpartIds,
    referenceId: content.referenceId,
  });
  if (content.kind === 'revoke') return normalizedSocialContext({
    cooperationKind: 'governance',
    phase: 'withdrawal',
    counterpartIds,
    referenceId: content.permissionId,
  });
  if (content.kind === 'withdraw') return normalizedSocialContext({
    cooperationKind: 'collective',
    phase: 'withdrawal',
    counterpartIds,
    referenceId: content.collectiveId,
  });
  return undefined;
}

function inferredMinimumLifeStage(
  option: Pick<ActionOption, 'domain' | 'goal' | 'nextAction' | 'completionAction' | 'projectId' | 'projectProposal' | 'relationshipBasis'>,
  reproduction: ActionOptionSemanticsV1['reproduction'],
): ActionOptionSemanticsV1['minimumLifeStage'] {
  const action = executionAction(option);
  const content = action.kind === 'talk' ? action.speakerMeaning : undefined;
  const adultSocialKind = (content?.kind === 'request' || content?.kind === 'offer')
    ? content.proposal?.kind
    : undefined;
  if (reproduction
    || content?.kind === 'prediction'
    || content?.kind === 'withdraw'
    || adultSocialKind === 'collective'
    || adultSocialKind === 'membership'
    || adultSocialKind === 'decision-rule'
    || adultSocialKind === 'mandate'
    || adultSocialKind === 'permission') return 'adult';
  if (option.projectId || option.projectProposal || option.domain === 'social' || option.relationshipBasis) return 'adolescent';
  if (option.goal.kind === 'body-at-least'
    || option.goal.kind === 'body-at-most'
    || option.goal.kind === 'sheltered'
    || option.goal.kind === 'death-mourned'
    || option.goal.kind === 'near-person'
    || action.kind === 'attend'
    || (action.kind === 'act' && action.operation === 'ingest')
    || (action.kind === 'transfer'
      && (action.from.kind === 'ground' || action.to.kind === 'person'))) return 'learning-child';
  return 'adolescent';
}

function inferredPurpose(
  option: Pick<ActionOption, 'goal' | 'nextAction' | 'completionAction' | 'projectId' | 'projectProposal' | 'recordUseBasis'>,
  conversation: ActionOptionSemanticsV1['conversation'],
  reproduction: ActionOptionSemanticsV1['reproduction'],
): ActionOptionSemanticsV1['purpose'] {
  if (reproduction) return 'reproduction';
  if (conversation) return 'conversation';
  if (option.projectId || option.projectProposal || option.goal.kind === 'project-completed') return 'project';
  if (option.recordUseBasis || option.goal.kind === 'knowledge' || executionAction(option).kind === 'attend') return 'inquiry';
  if (option.goal.kind === 'body-at-least') return 'homeostasis';
  if (option.goal.kind === 'body-at-most') return 'care';
  if (option.goal.kind === 'sheltered' || option.goal.kind === 'condition') return 'safety';
  if (option.goal.kind === 'death-mourned'
    || option.goal.kind === 'remains-interred'
    || option.goal.kind === 'memorial-marked') return 'mortuary-care';
  if (option.goal.kind === 'inventory-at-least' || option.goal.kind === 'container-inventory-at-least') return 'resource';
  if (option.goal.kind === 'near-person'
    || option.goal.kind === 'representation-made'
    || option.goal.kind === 'agreement-contribution-recorded') return 'social-coordination';
  if (option.goal.kind === 'at-cell') return 'movement';
  if (option.goal.kind === 'voxel-is') return 'production';
  return 'other';
}

function inferredNeeds(
  option: Pick<ActionOption, 'goal' | 'nextAction' | 'completionAction' | 'projectId' | 'projectProposal' | 'recordUseBasis'>,
  purpose: ActionOptionSemanticsV1['purpose'],
  reproduction: ActionOptionSemanticsV1['reproduction'],
): ActionOptionSemanticsV1['needKinds'] {
  const needs = new Set<ActionOptionSemanticsV1['needKinds'][number]>();
  if (purpose === 'homeostasis') needs.add('homeostasis');
  if (purpose === 'safety') needs.add('safety');
  if (purpose === 'care') needs.add('care');
  if (purpose === 'inquiry') needs.add('inquiry');
  if (purpose === 'resource') needs.add('reserve');
  if (purpose === 'project') {
    needs.add('commitment');
    needs.add('capability');
  }
  if (purpose === 'conversation' || purpose === 'social-coordination') needs.add('belonging');
  if (purpose === 'mortuary-care') needs.add('bereavement');
  if (reproduction) needs.add('generativity');
  const action = communicationAction(option);
  if (action && ['accept', 'reject', 'revoke-agreement', 'revoke', 'withdraw'].includes(action.speakerMeaning.kind)) needs.add('autonomy');
  return NEED_ORDER.filter((need) => needs.has(need));
}

/**
 * Infer only from typed domain fields.  This function deliberately never
 * inspects `option.id`, so renaming an option cannot alter planner policy.
 */
export function inferActionOptionSemantics(
  option: Pick<ActionOption,
    | 'domain'
    | 'goal'
    | 'nextAction'
    | 'completionAction'
    | 'target'
    | 'projectId'
    | 'projectProposal'
    | 'relationshipBasis'
    | 'recordUseBasis'>,
  override: ActionOptionSemanticOverride = {},
): ActionOptionSemanticsV1 {
  const action = communicationAction(option);
  const conversation = action?.speakerMeaning.kind === 'claim' && action.speakerMeaning.conversation
    ? {
        turn: action.speakerMeaning.conversation.turn,
        topic: action.speakerMeaning.conversation.topic,
      } satisfies NonNullable<ActionOptionSemanticsV1['conversation']>
    : undefined;
  const reproduction = override.reproduction ?? inferredReproduction(option);
  const socialContext = normalizedSocialContext(override.socialContext
    ?? inferredSocialContext(option, reproduction));
  const typedRequiredResponse = action?.speakerMeaning.kind === 'accept'
    || action?.speakerMeaning.kind === 'reject';
  const execution = executionAction(option);
  const acceptedCommitment = Boolean(acceptedAuthorization(option)
    || option.goal.kind === 'agreement-fulfilled'
    || option.goal.kind === 'agreement-contribution-recorded'
    || (execution.kind === 'act' && execution.operation === 'reproduce'));
  const obligation = override.obligation
    ?? (typedRequiredResponse ? 'required-response' : acceptedCommitment ? 'commitment-action' : 'optional');
  const edgeTrigger = override.edgeTrigger
    ?? (obligation === 'required-response'
      ? 'required-response'
      : obligation === 'commitment-action'
        ? 'commitment-action'
        : option.recordUseBasis
          ? 'record-use'
          : execution.kind === 'act' && execution.techniqueDemonstration
            ? 'technique-demonstration'
            : action?.speakerMeaning.kind === 'claim' && action.speakerMeaning.projectKnowledgeResponse
              ? 'project-knowledge-response'
              : conversation?.turn === 'response'
                ? 'conversation-response'
                : undefined);
  const purpose = override.purpose ?? inferredPurpose(option, conversation, reproduction);
  const minimumLifeStage = override.minimumLifeStage
    ?? inferredMinimumLifeStage(option, reproduction);
  const needKinds = override.needKinds ?? inferredNeeds(option, purpose, reproduction);
  return validateActionOptionSemantics({
    version: 'action-option-semantics-v1',
    obligation,
    planningChannel: override.planningChannel ?? (edgeTrigger ? 'edge' : 'ordinary'),
    purpose,
    minimumLifeStage,
    needKinds: [...new Set(needKinds)],
    ...(override.conversation ?? conversation ? { conversation: override.conversation ?? conversation } : {}),
    ...(reproduction ? { reproduction } : {}),
    ...(socialContext ? { socialContext } : {}),
    ...(edgeTrigger ? { edgeTrigger } : {}),
  });
}

export function validateActionOptionSemantics(value: unknown): ActionOptionSemanticsV1 {
  const semantics = semanticRecord(value, 'Action option semantics');
  if (semantics.version !== 'action-option-semantics-v1') {
    throw new Error('Unsupported action option semantics version');
  }
  const obligation = semanticEnum(semantics.obligation, OBLIGATIONS, 'option obligation');
  const planningChannel = semanticEnum(semantics.planningChannel, PLANNING_CHANNELS, 'planning channel');
  const purpose = semanticEnum(semantics.purpose, PURPOSES, 'option purpose');
  const minimumLifeStage = semanticEnum(
    semantics.minimumLifeStage,
    MINIMUM_LIFE_STAGES,
    'minimum life stage',
  );
  const needKinds = semanticStringArray(semantics.needKinds, 'Option needKinds');
  for (const need of needKinds) semanticEnum(need, NEED_ORDER, 'option need semantic');

  let conversation: ActionOptionSemanticsV1['conversation'];
  if (semantics.conversation !== undefined) {
    const nested = semanticRecord(semantics.conversation, 'Conversation semantics');
    conversation = {
      turn: semanticEnum(nested.turn, CONVERSATION_TURNS, 'conversation turn'),
      ...(nested.topic !== undefined ? { topic: nested.topic as string } : {}),
    };
    optionalSemanticString(nested.topic, 'Conversation topic');
  }

  let reproduction: ActionOptionSemanticsV1['reproduction'];
  if (semantics.reproduction !== undefined) {
    const nested = semanticRecord(semantics.reproduction, 'Reproduction semantics');
    reproduction = {
      direction: semanticEnum(nested.direction, REPRODUCTION_DIRECTIONS, 'reproduction direction'),
      phase: semanticEnum(nested.phase, REPRODUCTION_PHASES, 'reproduction phase'),
      mode: semanticEnum(nested.mode, REPRODUCTION_MODES, 'reproduction mode'),
    };
  }

  let socialContext: ActionOptionSemanticsV1['socialContext'];
  if (semantics.socialContext !== undefined) {
    const nested = semanticRecord(semantics.socialContext, 'Social context semantics');
    const counterpartIds = semanticStringArray(nested.counterpartIds, 'Social counterpartIds');
    optionalSemanticString(nested.referenceId, 'Social referenceId');
    optionalSemanticString(nested.conversationTopic, 'Social conversationTopic');
    optionalSemanticString(nested.projectId, 'Social projectId');
    optionalSemanticString(nested.projectKind, 'Social projectKind');
    if (nested.materialId !== undefined
      && (typeof nested.materialId !== 'number'
        || !Number.isSafeInteger(nested.materialId)
        || nested.materialId < 0)) {
      throw new Error('Social materialId must be a non-negative safe integer');
    }
    socialContext = {
      cooperationKind: semanticEnum(nested.cooperationKind, COOPERATION_KINDS, 'cooperation kind'),
      phase: semanticEnum(nested.phase, SOCIAL_PHASES, 'social phase'),
      counterpartIds,
      ...(nested.referenceId !== undefined ? { referenceId: nested.referenceId as string } : {}),
      ...(nested.assistNeed !== undefined
        ? { assistNeed: semanticEnum(nested.assistNeed, ASSIST_NEEDS, 'assist need') }
        : {}),
      ...(nested.conversationTopic !== undefined ? { conversationTopic: nested.conversationTopic as string } : {}),
      ...(nested.projectId !== undefined ? { projectId: nested.projectId as string } : {}),
      ...(nested.projectKind !== undefined ? { projectKind: nested.projectKind as string } : {}),
      ...(nested.materialId !== undefined ? { materialId: nested.materialId as number } : {}),
    };
  }

  const edgeTrigger = semantics.edgeTrigger === undefined
    ? undefined
    : semanticEnum(semantics.edgeTrigger, EDGE_TRIGGERS, 'edge trigger');

  if (obligation === 'required-response' && planningChannel !== 'edge') {
    throw new Error('Required response must use edge planning');
  }
  if (obligation === 'commitment-action' && planningChannel !== 'edge') {
    throw new Error('Commitment action must use edge planning');
  }
  if (edgeTrigger && planningChannel !== 'edge') {
    throw new Error('Edge trigger must use edge planning');
  }
  if (planningChannel === 'edge' && !edgeTrigger) {
    throw new Error('Edge planning requires an explicit edge trigger');
  }
  if (obligation === 'required-response'
    && edgeTrigger !== 'required-response') {
    throw new Error('Required response must carry the required-response edge trigger');
  }
  if (obligation === 'commitment-action' && edgeTrigger !== 'commitment-action') {
    throw new Error('Commitment action must carry the commitment-action edge trigger');
  }
  if (edgeTrigger === 'required-response' && obligation !== 'required-response') {
    throw new Error('Required-response edge trigger requires a required response');
  }
  if (edgeTrigger === 'commitment-action' && obligation !== 'commitment-action') {
    throw new Error('Commitment-action edge trigger requires a commitment action');
  }
  if (edgeTrigger === 'conversation-response'
    && (obligation !== 'optional' || conversation?.turn !== 'response')) {
    throw new Error('Conversation-response edge trigger requires an optional typed conversation response');
  }
  if (edgeTrigger
    && edgeTrigger !== 'required-response'
    && edgeTrigger !== 'commitment-action'
    && edgeTrigger !== 'conversation-response'
    && obligation !== 'optional') {
    throw new Error('Optional edge trigger cannot carry an obligation');
  }
  if (reproduction && purpose !== 'reproduction') {
    throw new Error('Reproduction metadata requires reproduction purpose');
  }
  if (purpose === 'reproduction' && !reproduction) {
    throw new Error('Reproduction purpose requires reproduction metadata');
  }
  if (conversation && purpose !== 'conversation') {
    throw new Error('Conversation metadata requires conversation purpose');
  }
  if (purpose === 'conversation' && !conversation) {
    throw new Error('Conversation purpose requires conversation metadata');
  }
  if (minimumLifeStage === 'learning-child'
    && (reproduction || obligation === 'required-response')) {
    throw new Error('Child-simple options cannot be reproduction or required social responses');
  }
  if (conversation?.turn === 'response' && obligation !== 'optional') {
    throw new Error('Conversation response must remain optional');
  }
  if (conversation?.turn === 'opening' && obligation !== 'optional') {
    throw new Error('Conversation opening must remain optional');
  }
  if (reproduction?.phase === 'response' && obligation !== 'required-response') {
    throw new Error('Reproduction response must be classified as required-response');
  }
  if (reproduction?.phase === 'attempt' && obligation !== 'commitment-action') {
    throw new Error('Reproduction attempt must be a commitment action');
  }
  if (reproduction?.phase === 'withdrawal' && obligation !== 'optional') {
    throw new Error('Reproduction withdrawal must remain optional');
  }
  if (reproduction?.phase === 'proposal' && obligation !== 'optional') {
    throw new Error('Reproduction proposal must remain optional');
  }
  if ((reproduction?.phase === 'proposal' || reproduction?.phase === 'attempt')
    && reproduction.direction !== 'proceed') {
    throw new Error('Reproduction proposal or attempt must proceed');
  }
  if (reproduction?.phase === 'withdrawal' && reproduction.direction !== 'refuse') {
    throw new Error('Reproduction withdrawal must refuse');
  }
  if (reproduction?.mode === 'unilateral-trait' && reproduction.phase !== 'attempt') {
    throw new Error('Unilateral-trait reproduction is only valid for an attempt');
  }
  if (socialContext?.assistNeed && socialContext.cooperationKind !== 'assist') {
    throw new Error('Assist need requires assist cooperation context');
  }
  if (socialContext?.conversationTopic && socialContext.cooperationKind !== 'conversation') {
    throw new Error('Conversation topic requires conversation cooperation context');
  }
  if ((socialContext?.projectId || socialContext?.projectKind)
    && socialContext.cooperationKind !== 'joint-project'
    && socialContext.cooperationKind !== 'governance') {
    throw new Error('Project reference requires joint-project or governance cooperation context');
  }
  if (conversation && socialContext) {
    if (socialContext.cooperationKind !== 'conversation') {
      throw new Error('Conversation metadata requires conversation cooperation context');
    }
    const expectedPhase = conversation.turn === 'opening' ? 'opening' : 'response';
    if (socialContext.phase !== expectedPhase) {
      throw new Error('Conversation social phase must match its turn');
    }
    if (socialContext.conversationTopic !== conversation.topic) {
      throw new Error('Conversation social topic must match conversation metadata');
    }
  }
  if (reproduction && socialContext && socialContext.cooperationKind !== 'reproduction') {
    throw new Error('Reproduction metadata requires reproduction cooperation context');
  }
  return semantics as unknown as ActionOptionSemanticsV1;
}

function validateSemanticConsistency(
  option: ActionOption,
  semantics: ActionOptionSemanticsV1,
): ActionOptionSemanticsV1 {
  const execution = executionAction(option);
  const communication = execution.kind === 'talk' ? execution : undefined;
  const conversation = communication?.speakerMeaning.kind === 'claim'
    ? communication.speakerMeaning.conversation
    : undefined;
  const typedRequiredResponse = communication?.speakerMeaning.kind === 'accept'
    || communication?.speakerMeaning.kind === 'reject';
  if (typedRequiredResponse && semantics.obligation !== 'required-response') {
    throw new Error('Typed response action must be classified as required-response');
  }
  if (conversation && (semantics.conversation?.turn !== conversation.turn
    || semantics.conversation.topic !== conversation.topic)) {
    throw new Error('Conversation semantics must match the typed conversation payload');
  }
  if (execution.kind === 'act' && execution.operation === 'reproduce') {
    if (semantics.obligation !== 'commitment-action'
      || semantics.purpose !== 'reproduction'
      || semantics.reproduction?.phase !== 'attempt') {
      throw new Error('Executable reproduction must carry commitment-action reproduction semantics');
    }
  }
  if (option.relationshipBasis?.kind === 'reproduce'
    && (communication?.speakerMeaning.kind === 'accept' || communication?.speakerMeaning.kind === 'reject')
    && !semantics.reproduction) {
    throw new Error('Reproduction response must carry explicit consent direction');
  }
  const optionalTechniqueEdge = execution.kind === 'act'
    && Boolean(execution.techniqueDemonstration)
    && !execution.authorizationRef;
  const optionalKnowledgeEdge = communication?.speakerMeaning.kind === 'claim'
    && Boolean(communication.speakerMeaning.projectKnowledgeResponse);
  if ((optionalTechniqueEdge || optionalKnowledgeEdge)
    && (semantics.obligation !== 'optional' || semantics.planningChannel !== 'edge')) {
    throw new Error('Unaccepted teaching response must remain an optional edge');
  }
  return semantics;
}

/** Explicit metadata for meanings that cannot be reconstructed from the action payload alone. */
export function defineActionOptionSemantics(
  override: ActionOptionSemanticOverride,
): ActionOptionSemanticsV1 {
  return validateActionOptionSemantics({
    version: 'action-option-semantics-v1',
    obligation: override.obligation ?? 'optional',
    planningChannel: override.planningChannel ?? (override.edgeTrigger ? 'edge' : 'ordinary'),
    purpose: override.purpose ?? 'other',
    minimumLifeStage: override.minimumLifeStage ?? 'adolescent',
    needKinds: [...new Set(override.needKinds ?? [])],
    ...(override.conversation ? { conversation: override.conversation } : {}),
    ...(override.reproduction ? { reproduction: override.reproduction } : {}),
    ...(override.socialContext ? { socialContext: normalizedSocialContext(override.socialContext) } : {}),
    ...(override.edgeTrigger ? { edgeTrigger: override.edgeTrigger } : {}),
  });
}

/** Attach and validate v1 metadata at the authoritative option-production boundary. */
export function classifyActionOption(
  option: ActionOption,
  override: ActionOptionSemanticOverride = {},
): ActionOption {
  const semantics = option.semantics
    ? validateActionOptionSemantics(option.semantics)
    : inferActionOptionSemantics(option, override);
  return { ...option, semantics: validateSemanticConsistency(option, semantics) };
}

/**
 * Consumer view for small unit fixtures that construct an option directly.
 * Production contexts are classified and validated before this is reached.
 */
export function actionOptionSemantics(option: ActionOption): ActionOptionSemanticsV1 {
  const semantics = option.semantics
    ? validateActionOptionSemantics(option.semantics)
    : inferActionOptionSemantics(option);
  return validateSemanticConsistency(option, semantics);
}

export function assertClassifiedActionOption(option: ActionOption): asserts option is ActionOption & { semantics: ActionOptionSemanticsV1 } {
  if (!option.semantics) throw new Error('Action option reached decision boundary without typed semantics');
  validateSemanticConsistency(option, validateActionOptionSemantics(option.semantics));
}

export function isRequiredResponseOption(option: ActionOption): boolean {
  return actionOptionSemantics(option).obligation === 'required-response';
}

export function isCommitmentActionOption(option: ActionOption): boolean {
  return actionOptionSemantics(option).obligation === 'commitment-action';
}

export function isOpenConversationOption(option: ActionOption): boolean {
  const conversation = actionOptionSemantics(option).conversation;
  return conversation?.turn === 'opening' && conversation.topic === 'open';
}

/** Legacy rule-authored topic menus stay available only to the pure local planner. */
export function isPreselectedConversationOpeningOption(option: ActionOption): boolean {
  const conversation = actionOptionSemantics(option).conversation;
  return conversation?.turn === 'opening' && conversation.topic !== 'open';
}

/**
 * A voluntary expression whose subjective choice belongs to the person, not
 * to the deterministic fallback planner while a model is available.
 *
 * Required replies and already accepted commitments are excluded by the
 * obligation check. Urgent requests for water or food remain rule-plannable so
 * a delayed model cannot make the body abandon an available rescue. Every
 * other optional communication -- claim, prediction, teaching, project talk,
 * relationship or governance proposal -- expresses a preference and must not
 * be silently invented by fallback rules.
 */
export function isModelOwnedVoluntarySocialOption(option: ActionOption): boolean {
  const semantics = actionOptionSemantics(option);
  if (semantics.obligation !== 'optional') return false;
  if (executionAction(option).kind !== 'talk') return false;
  const social = semantics.socialContext;
  return !(social?.cooperationKind === 'assist'
    && social.phase === 'proposal'
    && (social.assistNeed === 'water' || social.assistNeed === 'food'));
}

export function isEdgeActionOption(option: ActionOption): boolean {
  return actionOptionSemantics(option).planningChannel === 'edge';
}
