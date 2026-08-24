import type { SimulationState } from '../../src/game/eland/simulation';
import { Material } from '../../src/game/eland/domain/material';
import { objectRecord } from './object-record';
interface HypothesisMetrics {
  hypothesisCampaigns: number;
  hypothesisCandidates: number;
  hypothesisAttempts: number;
  hypothesisResponses: number;
  hypothesisNoResponses: number;
  hypothesisExhaustedCampaigns: number;
  hypothesisFirstAttemptResponses: number;
  hypothesisFirstAttemptNoResponses: number;
  hypothesisCombineAttempts: number;
  hypothesisCombineResponses: number;
  hypothesisCombineNoResponses: number;
  hypothesisExertAttempts: number;
  hypothesisExertResponses: number;
  hypothesisExertNoResponses: number;
  hypothesisExposeAttempts: number;
  hypothesisExposeResponses: number;
  hypothesisExposeNoResponses: number;
  hypothesisConnectManipulatorShapesCandidates: number;
  hypothesisConnectManipulatorShapesAttempts: number;
  hypothesisConnectManipulatorShapesResponses: number;
  hypothesisConnectManipulatorShapesNoResponses: number;
  hypothesisConnectFlexibleLayersCandidates: number;
  hypothesisConnectFlexibleLayersAttempts: number;
  hypothesisConnectFlexibleLayersResponses: number;
  hypothesisConnectFlexibleLayersNoResponses: number;
  hypothesisSeekLocalHeatCandidates: number;
  hypothesisSeekLocalHeatAttempts: number;
  hypothesisSeekLocalHeatResponses: number;
  hypothesisSeekLocalHeatNoResponses: number;
  hypothesisShapePortableSurfaceCandidates: number;
  hypothesisShapePortableSurfaceAttempts: number;
  hypothesisShapePortableSurfaceResponses: number;
  hypothesisShapePortableSurfaceNoResponses: number;
  hypothesisTransformSubjectWithObservedHeatCandidates: number;
  hypothesisTransformSubjectWithObservedHeatAttempts: number;
  hypothesisTransformSubjectWithObservedHeatResponses: number;
  hypothesisTransformSubjectWithObservedHeatNoResponses: number;
  hypothesisCandidatesWithRoleBasis: number;
  hypothesisAttemptsWithRoleBasis: number;
  hypothesisCandidateRoleBasisCoverage: number;
  hypothesisAttemptRoleBasisCoverage: number;
  hypothesisCandidatesWithEntityRoleBasis: number;
  hypothesisAttemptsWithEntityRoleBasis: number;
  hypothesisActionDiffsWithEntityRoleBasis: number;
  hypothesisCandidateEntityRoleBasisCoverage: number;
  hypothesisAttemptEntityRoleBasisCoverage: number;
  hypothesisActionDiffEntityRoleBasisCoverage: number;
  hypothesisCandidatesMissingQuestionKind: number;
  hypothesisCandidatesMissingRoleBasis: number;
  hypothesisAttemptsMissingQuestionKind: number;
  hypothesisAttemptsMissingRoleBasis: number;
  hypothesisCandidateAttemptRoleBasisMismatches: number;
  hypothesisActionDiffRoleBasisMismatches: number;
  hypothesisNonFiniteRoleScores: number;
  hypothesisQuestionOperationMismatches: number;
  hypothesisExertVerifiedResponseToolAttempts: number;
  hypothesisExertVerifiedResponseInputAttempts: number;
  hypothesisExactEntityVerifiedResponseToolAttempts: number;
  hypothesisExactEntityVerifiedResponseInputAttempts: number;
  hypothesisMaterialOnlyVerifiedResponseAttributionViolations: number;
  hypothesisVerifiedResponses: number;
  hypothesisResponseDrivenTransitions: number;
  hypothesisUniquePairs: number;
  hypothesisUniqueSignatures: number;
  hypothesisUnresolvedProjects: number;
  hypothesisProjectMismatches: number;
  hypothesisUnresolvedActors: number;
  hypothesisActorMismatches: number;
  hypothesisUnresolvedCampaigns: number;
  hypothesisCampaignMismatches: number;
  hypothesisUnresolvedActionEvents: number;
  hypothesisActionMismatches: number;
  hypothesisOperationMismatches: number;
  hypothesisDuplicateProjectPairs: number;
  hypothesisDuplicateProjectSignatures: number;
  hypothesisBudgetExceeds: number;
  hypothesisTotalBudgetExceeds: number;
  hypothesisNoResponseBudgetExceeds: number;
  hypothesisResponseBudgetExceeds: number;
  hypothesisAttemptOrdinalMismatches: number;
  hypothesisActionDiffPairMismatches: number;
  hypothesisActionDiffSignatureMismatches: number;
  hypothesisActionDiffOutcomeMismatches: number;
  hypothesisMissingSourceKeys: number;
  hypothesisReliableKnowledgeViolations: number;
}

function emptyHypothesisMetrics(): HypothesisMetrics {
  return {
    hypothesisCampaigns: 0,
    hypothesisCandidates: 0,
    hypothesisAttempts: 0,
    hypothesisResponses: 0,
    hypothesisNoResponses: 0,
    hypothesisExhaustedCampaigns: 0,
    hypothesisFirstAttemptResponses: 0,
    hypothesisFirstAttemptNoResponses: 0,
    hypothesisCombineAttempts: 0,
    hypothesisCombineResponses: 0,
    hypothesisCombineNoResponses: 0,
    hypothesisExertAttempts: 0,
    hypothesisExertResponses: 0,
    hypothesisExertNoResponses: 0,
    hypothesisExposeAttempts: 0,
    hypothesisExposeResponses: 0,
    hypothesisExposeNoResponses: 0,
    hypothesisConnectManipulatorShapesCandidates: 0,
    hypothesisConnectManipulatorShapesAttempts: 0,
    hypothesisConnectManipulatorShapesResponses: 0,
    hypothesisConnectManipulatorShapesNoResponses: 0,
    hypothesisConnectFlexibleLayersCandidates: 0,
    hypothesisConnectFlexibleLayersAttempts: 0,
    hypothesisConnectFlexibleLayersResponses: 0,
    hypothesisConnectFlexibleLayersNoResponses: 0,
    hypothesisSeekLocalHeatCandidates: 0,
    hypothesisSeekLocalHeatAttempts: 0,
    hypothesisSeekLocalHeatResponses: 0,
    hypothesisSeekLocalHeatNoResponses: 0,
    hypothesisShapePortableSurfaceCandidates: 0,
    hypothesisShapePortableSurfaceAttempts: 0,
    hypothesisShapePortableSurfaceResponses: 0,
    hypothesisShapePortableSurfaceNoResponses: 0,
    hypothesisTransformSubjectWithObservedHeatCandidates: 0,
    hypothesisTransformSubjectWithObservedHeatAttempts: 0,
    hypothesisTransformSubjectWithObservedHeatResponses: 0,
    hypothesisTransformSubjectWithObservedHeatNoResponses: 0,
    hypothesisCandidatesWithRoleBasis: 0,
    hypothesisAttemptsWithRoleBasis: 0,
    hypothesisCandidateRoleBasisCoverage: 100,
    hypothesisAttemptRoleBasisCoverage: 100,
    hypothesisCandidatesWithEntityRoleBasis: 0,
    hypothesisAttemptsWithEntityRoleBasis: 0,
    hypothesisActionDiffsWithEntityRoleBasis: 0,
    hypothesisCandidateEntityRoleBasisCoverage: 100,
    hypothesisAttemptEntityRoleBasisCoverage: 100,
    hypothesisActionDiffEntityRoleBasisCoverage: 100,
    hypothesisCandidatesMissingQuestionKind: 0,
    hypothesisCandidatesMissingRoleBasis: 0,
    hypothesisAttemptsMissingQuestionKind: 0,
    hypothesisAttemptsMissingRoleBasis: 0,
    hypothesisCandidateAttemptRoleBasisMismatches: 0,
    hypothesisActionDiffRoleBasisMismatches: 0,
    hypothesisNonFiniteRoleScores: 0,
    hypothesisQuestionOperationMismatches: 0,
    hypothesisExertVerifiedResponseToolAttempts: 0,
    hypothesisExertVerifiedResponseInputAttempts: 0,
    hypothesisExactEntityVerifiedResponseToolAttempts: 0,
    hypothesisExactEntityVerifiedResponseInputAttempts: 0,
    hypothesisMaterialOnlyVerifiedResponseAttributionViolations: 0,
    hypothesisVerifiedResponses: 0,
    hypothesisResponseDrivenTransitions: 0,
    hypothesisUniquePairs: 0,
    hypothesisUniqueSignatures: 0,
    hypothesisUnresolvedProjects: 0,
    hypothesisProjectMismatches: 0,
    hypothesisUnresolvedActors: 0,
    hypothesisActorMismatches: 0,
    hypothesisUnresolvedCampaigns: 0,
    hypothesisCampaignMismatches: 0,
    hypothesisUnresolvedActionEvents: 0,
    hypothesisActionMismatches: 0,
    hypothesisOperationMismatches: 0,
    hypothesisDuplicateProjectPairs: 0,
    hypothesisDuplicateProjectSignatures: 0,
    hypothesisBudgetExceeds: 0,
    hypothesisTotalBudgetExceeds: 0,
    hypothesisNoResponseBudgetExceeds: 0,
    hypothesisResponseBudgetExceeds: 0,
    hypothesisAttemptOrdinalMismatches: 0,
    hypothesisActionDiffPairMismatches: 0,
    hypothesisActionDiffSignatureMismatches: 0,
    hypothesisActionDiffOutcomeMismatches: 0,
    hypothesisMissingSourceKeys: 0,
    hypothesisReliableKnowledgeViolations: 0,
  };
}

export function hypothesisMetrics(state: SimulationState): HypothesisMetrics {
  type HypothesisOutcome = 'response' | 'no-response';
  type HypothesisOperation = 'combine-inventory' | 'exert-air' | 'expose-local';
  type HypothesisQuestionKind =
    | 'connect-manipulator-shapes'
    | 'connect-flexible-layers'
    | 'seek-local-heat'
    | 'shape-portable-surface'
    | 'transform-subject-with-observed-heat';
  type MaterialPair = [number, number];
  type QuestionCounts = { candidates: number; attempts: number; responses: number; noResponses: number };
  type RoleBasis = {
    questionKind: unknown;
    roleScore: unknown;
    toolRoleScore: unknown;
    inputRoleScore: unknown;
    surfaceRoleScore: unknown;
    toolSourceKey: unknown;
    inputSourceKey: unknown;
    toolRoleMaterialId: unknown;
    inputRoleMaterialId: unknown;
    surfaceRoleMaterialId: unknown;
    roleReasonKeys: unknown;
    sourceKeys: unknown;
  };
  const rawState = state as unknown as {
    projects?: unknown;
    people?: unknown;
    world?: { past?: unknown };
  };
  const records = (value: unknown) => (
    Array.isArray(value)
      ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
      : []
  );
  const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const integerValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isInteger(value) ? value : null
  );
  const outcomeValue = (value: unknown): HypothesisOutcome | null => (
    value === 'response' || value === 'no-response' ? value : null
  );
  const operationValue = (value: unknown, legacyCombine = false): HypothesisOperation | null => {
    if (value === 'combine-inventory' || value === 'exert-air' || value === 'expose-local') return value;
    return value === undefined && legacyCombine ? 'combine-inventory' : null;
  };
  const questionValue = (value: unknown): HypothesisQuestionKind | null => {
    if (value === 'connect-manipulator-shapes'
      || value === 'connect-flexible-layers'
      || value === 'seek-local-heat'
      || value === 'shape-portable-surface'
      || value === 'transform-subject-with-observed-heat') return value;
    return null;
  };
  const expectedQuestionOperation = (question: HypothesisQuestionKind): HypothesisOperation => (
    question === 'connect-manipulator-shapes' || question === 'connect-flexible-layers'
      ? 'combine-inventory'
      : question === 'transform-subject-with-observed-heat'
        ? 'expose-local'
        : 'exert-air'
  );
  const stringKeys = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  );
  const materialPair = (value: unknown): MaterialPair | null => {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const left = integerValue(value[0]);
    const right = integerValue(value[1]);
    return left === null || right === null ? null : [left, right];
  };
  const normalizedPair = (operation: HypothesisOperation, pair: MaterialPair): MaterialPair => (
    operation === 'combine-inventory' && pair[0] > pair[1] ? [pair[1], pair[0]] : pair
  );
  const candidateKeyFor = (
    operation: HypothesisOperation,
    pair: MaterialPair,
    targetMaterialId?: number | null,
  ): string => {
    const [left, right] = normalizedPair(operation, pair);
    if (operation === 'combine-inventory') return String(left) + '+' + String(right);
    if (operation === 'exert-air') {
      return 'exert-air:' + String(left) + '>' + String(right) + '@' + String(targetMaterialId ?? Material.Air);
    }
    return 'expose-local:' + String(left) + '@' + String(targetMaterialId ?? right);
  };
  const signatureFor = (
    operation: HypothesisOperation | null,
    pair: MaterialPair | null,
    targetMaterialId?: number | null,
  ): string | null => (
    operation && pair ? operation + '\u0000' + candidateKeyFor(operation, pair, targetMaterialId) : null
  );
  const optionalIntegerMatches = (
    record: Record<string, unknown>,
    field: string,
    expected: number,
  ): boolean => record[field] === undefined || integerValue(record[field]) === expected;
  const roleMaterialIdsMatch = (
    record: Record<string, unknown>,
    operation: HypothesisOperation,
    pair: MaterialPair,
    prefix = '',
  ): boolean => {
    const toolField = prefix + 'ToolMaterialId';
    const inputField = prefix + 'InputMaterialId';
    const targetField = prefix + 'TargetMaterialId';
    if (operation === 'exert-air') return optionalIntegerMatches(record, toolField, pair[0])
      && optionalIntegerMatches(record, inputField, pair[1])
      && optionalIntegerMatches(record, targetField, Material.Air);
    if (operation === 'expose-local') return optionalIntegerMatches(record, inputField, pair[0])
      && optionalIntegerMatches(record, targetField, pair[1]);
    return true;
  };
  const actualSignature = (
    diff: Record<string, unknown>,
    operation: HypothesisOperation,
  ): string | null => {
    if (operation === 'combine-inventory') {
      return signatureFor(operation, materialPair(diff.inputMaterialIds));
    }
    const inputMaterialId = integerValue(diff.inputMaterialId);
    const targetMaterialId = integerValue(diff.targetMaterialId);
    if (inputMaterialId === null || targetMaterialId === null) return null;
    if (operation === 'exert-air') {
      const toolMaterialId = integerValue(diff.toolMaterialId);
      if (toolMaterialId === null || targetMaterialId !== Material.Air) return null;
      return signatureFor(operation, [toolMaterialId, inputMaterialId], targetMaterialId);
    }
    return signatureFor(operation, [inputMaterialId, targetMaterialId], targetMaterialId);
  };
  const legacyPairShape = (
    record: Record<string, unknown> | undefined,
    keyField: 'key' | 'candidateKey',
  ): boolean => {
    if (!record || record.operation !== undefined) return false;
    const pair = materialPair(record.materialIds);
    const key = stringValue(record[keyField]);
    return pair !== null && key === candidateKeyFor('combine-inventory', pair);
  };
  const expectedActionOperation = (operation: HypothesisOperation): 'combine' | 'exert' | 'expose' => (
    operation === 'combine-inventory' ? 'combine' : operation === 'exert-air' ? 'exert' : 'expose'
  );
  const storedRoleBasis = (record: Record<string, unknown>): RoleBasis => ({
    questionKind: record.questionKind,
    roleScore: record.roleScore,
    toolRoleScore: record.toolRoleScore,
    inputRoleScore: record.inputRoleScore,
    surfaceRoleScore: record.surfaceRoleScore,
    toolSourceKey: record.toolSourceKey,
    inputSourceKey: record.inputSourceKey,
    toolRoleMaterialId: record.toolRoleMaterialId,
    inputRoleMaterialId: record.inputRoleMaterialId,
    surfaceRoleMaterialId: record.surfaceRoleMaterialId,
    roleReasonKeys: record.roleReasonKeys,
    sourceKeys: record.sourceKeys,
  });
  const diffRoleBasis = (record: Record<string, unknown>): RoleBasis => ({
    questionKind: record.projectHypothesisQuestionKind,
    roleScore: record.projectHypothesisRoleScore,
    toolRoleScore: record.projectHypothesisToolRoleScore,
    inputRoleScore: record.projectHypothesisInputRoleScore,
    surfaceRoleScore: record.projectHypothesisSurfaceRoleScore,
    toolSourceKey: record.projectHypothesisToolSourceKey,
    inputSourceKey: record.projectHypothesisInputSourceKey,
    toolRoleMaterialId: record.projectHypothesisToolRoleMaterialId,
    inputRoleMaterialId: record.projectHypothesisInputRoleMaterialId,
    surfaceRoleMaterialId: record.projectHypothesisSurfaceRoleMaterialId,
    roleReasonKeys: record.projectHypothesisRoleReasonKeys,
    sourceKeys: record.projectHypothesisSourceKeys,
  });
  const exactReasonKeys = (value: unknown): string[] | null => (
    Array.isArray(value)
      && value.every((item) => typeof item === 'string' && item.length > 0)
      ? value as string[]
      : null
  );
  const requiredRoleScores = (
    basis: RoleBasis,
    operation: HypothesisOperation | null,
  ): Array<keyof RoleBasis> => (
    questionValue(basis.questionKind) === 'connect-flexible-layers'
      || questionValue(basis.questionKind) === 'transform-subject-with-observed-heat'
      || operation === 'expose-local'
      ? ['roleScore', 'inputRoleScore']
      : operation === 'combine-inventory' || operation === 'exert-air'
        ? ['roleScore', 'toolRoleScore', 'inputRoleScore']
        : ['roleScore']
  );
  const isExplicitNoFitReason = (reason: string): boolean => (
    reason.startsWith('role-') && reason.endsWith('-no-observed-fit')
  );
  const roleBasisPresent = (basis: RoleBasis, operation: HypothesisOperation | null): boolean => {
    const reasons = exactReasonKeys(basis.roleReasonKeys);
    if (!requiredRoleScores(basis, operation).every((field) => basis[field] !== undefined)
      || !reasons || reasons.length === 0) return false;
    return basis.roleScore !== 0 || reasons.some(isExplicitNoFitReason);
  };
  const roleBasisFinite = (basis: RoleBasis, operation: HypothesisOperation | null): boolean => (
    requiredRoleScores(basis, operation).every((field) => Number.isFinite(basis[field]))
  );
  const entityRoleBasisPresent = (
    basis: RoleBasis,
    operation: HypothesisOperation | null,
  ): boolean => {
    if (!roleBasisPresent(basis, operation) || !roleBasisFinite(basis, operation)) return false;
    const sourceKeys = exactReasonKeys(basis.sourceKeys);
    if (!sourceKeys) return false;
    const reasons = exactReasonKeys(basis.roleReasonKeys) ?? [];
    const roleEntityPresent = (
      scoreField: 'toolRoleScore' | 'inputRoleScore',
      sourceField: 'toolSourceKey' | 'inputSourceKey',
      materialField: 'toolRoleMaterialId' | 'inputRoleMaterialId',
      role: 'tool' | 'input',
    ): boolean => {
      if (!requiredRoleScores(basis, operation).includes(scoreField)) return true;
      const sourceKey = stringValue(basis[sourceField]);
      if (sourceKey && integerValue(basis[materialField]) !== null && sourceKeys.includes(sourceKey)) return true;
      const noFitRoles = role === 'input' ? ['input', 'surface'] : ['tool'];
      return basis[scoreField] === 0 && reasons.some((reason) => (
        isExplicitNoFitReason(reason) && noFitRoles.some((name) => reason.startsWith(`role-${name}-`))
      ));
    };
    if (!roleEntityPresent('toolRoleScore', 'toolSourceKey', 'toolRoleMaterialId', 'tool')
      || !roleEntityPresent('inputRoleScore', 'inputSourceKey', 'inputRoleMaterialId', 'input')) return false;
    const hasSurfaceRole = basis.surfaceRoleScore !== undefined || basis.surfaceRoleMaterialId !== undefined;
    if (!hasSurfaceRole) return true;
    const inputSourceKey = stringValue(basis.inputSourceKey);
    return Number.isFinite(basis.surfaceRoleScore)
      && integerValue(basis.surfaceRoleMaterialId) !== null
      && ((inputSourceKey !== null && sourceKeys.includes(inputSourceKey))
        || (basis.surfaceRoleScore === 0
          && reasons.some((reason) => reason === 'role-surface-no-observed-fit')));
  };
  const hasNonFiniteRoleScore = (basis: RoleBasis): boolean => (
    (['roleScore', 'toolRoleScore', 'inputRoleScore', 'surfaceRoleScore'] as const)
      .some((field) => basis[field] !== undefined && !Number.isFinite(basis[field]))
  );
  const roleBasisMatches = (left: RoleBasis, right: RoleBasis, compareSourceKeys = false): boolean => {
    const leftReasons = exactReasonKeys(left.roleReasonKeys);
    const rightReasons = exactReasonKeys(right.roleReasonKeys);
    const bothReasonsAbsent = left.roleReasonKeys === undefined && right.roleReasonKeys === undefined;
    const reasonsMatch = bothReasonsAbsent || (leftReasons !== null
      && rightReasons !== null
      && leftReasons.length === rightReasons.length
      && leftReasons.every((key, index) => key === rightReasons[index]));
    return left.questionKind === right.questionKind
      && left.roleScore === right.roleScore
      && left.toolRoleScore === right.toolRoleScore
      && left.inputRoleScore === right.inputRoleScore
      && left.surfaceRoleScore === right.surfaceRoleScore
      && left.toolSourceKey === right.toolSourceKey
      && left.inputSourceKey === right.inputSourceKey
      && left.toolRoleMaterialId === right.toolRoleMaterialId
      && left.inputRoleMaterialId === right.inputRoleMaterialId
      && left.surfaceRoleMaterialId === right.surfaceRoleMaterialId
      && reasonsMatch
      && (!compareSourceKeys || (() => {
        const leftSourceKeys = exactReasonKeys(left.sourceKeys);
        const rightSourceKeys = exactReasonKeys(right.sourceKeys);
        return leftSourceKeys !== null && rightSourceKeys !== null
          && leftSourceKeys.length === rightSourceKeys.length
          && leftSourceKeys.every((key, index) => key === rightSourceKeys[index]);
      })());
  };
  const responseRefSourceKey = (
    responseRef: Record<string, unknown> | null,
    actorId: string | null,
  ): string | null => {
    const materialId = integerValue(responseRef?.materialId);
    if (materialId === null) return null;
    if (responseRef?.kind === 'inventory-stack') {
      const stackId = stringValue(responseRef.stackId);
      return actorId && stackId ? `inventory:${actorId}:${stackId}` : null;
    }
    if (responseRef?.kind !== 'voxel') return null;
    const position = objectRecord(responseRef.position);
    const x = integerValue(position?.x);
    const y = integerValue(position?.y);
    const z = integerValue(position?.z);
    return x === null || y === null || z === null
      ? null
      : `voxel:${x}:${y}:${z}:${materialId}`;
  };

  const projects = records(rawState.projects);
  const people = records(rawState.people);
  const events = records(rawState.world?.past);
  const campaignEntries = projects.flatMap((project, projectIndex) => {
    const campaign = objectRecord(project.hypothesisCampaign);
    if (!campaign) return [];
    const projectId = stringValue(project.id);
    const campaignId = stringValue(campaign.id);
    return [{
      project,
      projectIndex,
      projectId,
      campaign,
      campaignId,
      key: (projectId ?? '#' + String(projectIndex)) + '\u0000' + (campaignId ?? '#campaign'),
    }];
  });
  if (campaignEntries.length === 0) return emptyHypothesisMetrics();

  type CampaignEntry = (typeof campaignEntries)[number];
  const projectById = new Map(projects.flatMap((project) => {
    const id = stringValue(project.id);
    return id ? [[id, project] as const] : [];
  }));
  const personIds = new Set(people.flatMap((person) => {
    const id = stringValue(person.id);
    return id ? [id] : [];
  }));
  const campaignEntriesById = new Map<string, CampaignEntry[]>();
  for (const entry of campaignEntries) {
    if (!entry.campaignId) continue;
    const matches = campaignEntriesById.get(entry.campaignId) ?? [];
    matches.push(entry);
    campaignEntriesById.set(entry.campaignId, matches);
  }
  const actionEntries = events.flatMap((event, eventIndex) => {
    if (event.kind !== 'action') return [];
    const id = stringValue(event.id);
    return [{
      event,
      eventIndex,
      id,
      key: id ?? '#' + String(eventIndex),
      diff: objectRecord(event.diff) ?? {},
    }];
  });
  const actionById = new Map(actionEntries.flatMap((entry) => (
    entry.id ? [[entry.id, entry] as const] : []
  )));
  const candidateEntries = campaignEntries.flatMap((entry) => (
    records(entry.campaign.candidates).map((candidate, candidateIndex) => ({
      ...entry,
      candidate,
      candidateIndex,
      candidateEntryKey: entry.key + '\u0000candidate:' + String(candidateIndex),
    }))
  ));
  const attemptEntries = campaignEntries.flatMap((entry) => {
    const attempts = Array.isArray(entry.campaign.attempts) ? entry.campaign.attempts : [];
    return attempts.flatMap((value, attemptIndex) => {
      const attempt = objectRecord(value);
      return attempt ? [{
        ...entry,
        attempt,
        attemptIndex,
        attemptKey: entry.key + '\u0000#' + String(attemptIndex),
      }] : [];
    });
  });
  type AttemptEntry = (typeof attemptEntries)[number];
  const attemptsByEventId = new Map<string, AttemptEntry[]>();
  for (const entry of attemptEntries) {
    const eventId = stringValue(entry.attempt.eventId);
    if (!eventId) continue;
    const matches = attemptsByEventId.get(eventId) ?? [];
    matches.push(entry);
    attemptsByEventId.set(eventId, matches);
  }

  const unresolvedProjects = new Set<string>();
  const projectMismatches = new Set<string>();
  const unresolvedActors = new Set<string>();
  const actorMismatches = new Set<string>();
  const unresolvedCampaigns = new Set<string>();
  const campaignMismatches = new Set<string>();
  const unresolvedActionEvents = new Set<string>();
  const actionMismatches = new Set<string>();
  const operationMismatches = new Set<string>();
  const duplicateProjectSignatures = new Set<string>();
  const budgetExceeds = new Set<string>();
  const totalBudgetExceeds = new Set<string>();
  const noResponseBudgetExceeds = new Set<string>();
  const responseBudgetExceeds = new Set<string>();
  const attemptOrdinalMismatches = new Set<string>();
  const actionDiffSignatureMismatches = new Set<string>();
  const actionDiffOutcomeMismatches = new Set<string>();
  const missingSourceKeys = new Set<string>();
  const reliableKnowledgeViolations = new Set<string>();
  const candidatesMissingQuestionKind = new Set<string>();
  const candidatesMissingRoleBasis = new Set<string>();
  const attemptsMissingQuestionKind = new Set<string>();
  const attemptsMissingRoleBasis = new Set<string>();
  const candidateAttemptRoleBasisMismatches = new Set<string>();
  const actionDiffRoleBasisMismatches = new Set<string>();
  const nonFiniteRoleScores = new Set<string>();
  const questionOperationMismatches = new Set<string>();
  const uniqueSignatures = new Set<string>();
  const projectSignatures = new Map<string, Set<string>>();
  const verifiedResponses = new Set<string>();
  const responseDrivenTransitions = new Set<string>();
  const exertVerifiedResponseToolAttempts = new Set<string>();
  const exertVerifiedResponseInputAttempts = new Set<string>();
  const exactEntityVerifiedResponseToolAttempts = new Set<string>();
  const exactEntityVerifiedResponseInputAttempts = new Set<string>();
  const materialOnlyVerifiedResponseAttributionViolations = new Set<string>();
  const operationCounts: Record<HypothesisOperation, {
    attempts: number;
    responses: number;
    noResponses: number;
  }> = {
    'combine-inventory': { attempts: 0, responses: 0, noResponses: 0 },
    'exert-air': { attempts: 0, responses: 0, noResponses: 0 },
    'expose-local': { attempts: 0, responses: 0, noResponses: 0 },
  };
  const questionCounts: Record<HypothesisQuestionKind, QuestionCounts> = {
    'connect-manipulator-shapes': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'connect-flexible-layers': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'seek-local-heat': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'shape-portable-surface': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'transform-subject-with-observed-heat': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
  };
  const attemptDetails = new Map<string, {
    operation: HypothesisOperation | null;
    materialIds: MaterialPair | null;
    candidate?: Record<string, unknown>;
  }>();
  let hypothesisResponses = 0;
  let hypothesisNoResponses = 0;
  let hypothesisFirstAttemptResponses = 0;
  let hypothesisFirstAttemptNoResponses = 0;
  let candidatesWithRoleBasis = 0;
  let attemptsWithRoleBasis = 0;
  let candidatesWithEntityRoleBasis = 0;
  let attemptsWithEntityRoleBasis = 0;
  let actionDiffsWithEntityRoleBasis = 0;

  for (const entry of candidateEntries) {
    const legacyCampaign = stringValue(entry.campaign.version) !== 'project-hypothesis-campaign-v2';
    const legacyCandidate = entry.candidate.operation === undefined
      && (legacyCampaign || legacyPairShape(entry.candidate, 'key'));
    const operation = operationValue(entry.candidate.operation, legacyCandidate);
    const question = questionValue(entry.candidate.questionKind);
    const basis = storedRoleBasis(entry.candidate);
    if (question) questionCounts[question].candidates += 1;
    else candidatesMissingQuestionKind.add(entry.candidateEntryKey);
    if (!roleBasisPresent(basis, operation)) candidatesMissingRoleBasis.add(entry.candidateEntryKey);
    if (question && roleBasisPresent(basis, operation) && roleBasisFinite(basis, operation)) {
      candidatesWithRoleBasis += 1;
    }
    if (question && entityRoleBasisPresent(basis, operation)) candidatesWithEntityRoleBasis += 1;
    if (hasNonFiniteRoleScore(basis)) nonFiniteRoleScores.add('candidate:' + entry.candidateEntryKey);
    if (question && operation !== expectedQuestionOperation(question)) {
      questionOperationMismatches.add('candidate:' + entry.candidateEntryKey);
    }
  }

  for (const entry of campaignEntries) {
    const campaignProjectId = stringValue(entry.campaign.projectId);
    const campaignActorId = stringValue(entry.campaign.actorId);
    const version = stringValue(entry.campaign.version);
    const totalBudget = integerValue(entry.campaign.budget);
    const noResponseBudget = integerValue(entry.campaign.noResponseBudget);
    const responseBudget = integerValue(entry.campaign.responseBudget);
    if (!campaignProjectId || !projectById.has(campaignProjectId)) unresolvedProjects.add('campaign:' + entry.key);
    if (!entry.projectId || campaignProjectId !== entry.projectId) projectMismatches.add('campaign:' + entry.key);
    if (!campaignActorId || !personIds.has(campaignActorId)) unresolvedActors.add('campaign:' + entry.key);
    if (!entry.campaignId) unresolvedCampaigns.add('campaign:' + entry.key);
    else if ((campaignEntriesById.get(entry.campaignId)?.length ?? 0) !== 1) campaignMismatches.add('campaign:' + entry.key);
    if (version !== null
      && version !== 'project-hypothesis-campaign-v1'
      && version !== 'project-hypothesis-campaign-v2') {
      campaignMismatches.add('version:' + entry.key);
    }
    if (totalBudget === null || totalBudget < 0) campaignMismatches.add('budget:' + entry.key);
    if (version === 'project-hypothesis-campaign-v2'
      && (noResponseBudget === null || noResponseBudget < 0
        || responseBudget === null || responseBudget < 0)) {
      campaignMismatches.add('stage-budgets:' + entry.key);
    }
  }

  for (const entry of attemptEntries) {
    const { campaign, attempt, attemptIndex, attemptKey } = entry;
    const attemptEventId = stringValue(attempt.eventId);
    const operationMismatchKey = attemptEventId ?? attemptKey;
    const candidateKey = stringValue(attempt.candidateKey);
    const attemptMaterialIds = materialPair(attempt.materialIds);
    const legacyCampaign = stringValue(campaign.version) !== 'project-hypothesis-campaign-v2';
    const legacyAttempt = attempt.operation === undefined
      && (legacyCampaign || legacyPairShape(attempt, 'candidateKey'));
    const operation = operationValue(attempt.operation, legacyAttempt);
    const outcome = outcomeValue(attempt.outcome);
    const question = questionValue(attempt.questionKind);
    const attemptRoleBasis = storedRoleBasis(attempt);
    if (question) {
      const counts = questionCounts[question];
      counts.attempts += 1;
      if (outcome === 'response') counts.responses += 1;
      else if (outcome === 'no-response') counts.noResponses += 1;
    } else {
      attemptsMissingQuestionKind.add(attemptKey);
    }
    if (!roleBasisPresent(attemptRoleBasis, operation)) attemptsMissingRoleBasis.add(attemptKey);
    if (question && roleBasisPresent(attemptRoleBasis, operation)
      && roleBasisFinite(attemptRoleBasis, operation)) {
      attemptsWithRoleBasis += 1;
    }
    if (question && entityRoleBasisPresent(attemptRoleBasis, operation)) attemptsWithEntityRoleBasis += 1;
    if (hasNonFiniteRoleScore(attemptRoleBasis)) nonFiniteRoleScores.add('attempt:' + attemptKey);
    if (question && operation !== expectedQuestionOperation(question)) {
      questionOperationMismatches.add('attempt:' + attemptKey);
    }
    if (outcome === 'response') {
      hypothesisResponses += 1;
      if (attemptIndex === 0) hypothesisFirstAttemptResponses += 1;
    } else if (outcome === 'no-response') {
      hypothesisNoResponses += 1;
      if (attemptIndex === 0) hypothesisFirstAttemptNoResponses += 1;
    }
    if (operation) {
      operationCounts[operation].attempts += 1;
      if (outcome === 'response') operationCounts[operation].responses += 1;
      else if (outcome === 'no-response') operationCounts[operation].noResponses += 1;
    } else {
      operationMismatches.add(operationMismatchKey);
    }

    const attemptTargetMaterialId = integerValue(attempt.targetMaterialId);
    const attemptSignature = signatureFor(operation, attemptMaterialIds, attemptTargetMaterialId);
    const expectedCandidateKey = operation && attemptMaterialIds
      ? candidateKeyFor(operation, attemptMaterialIds, attemptTargetMaterialId)
      : null;
    if (attemptSignature) uniqueSignatures.add(attemptSignature);
    if (attemptSignature) {
      const projectKey = entry.projectId ?? '#' + String(entry.projectIndex);
      const seenSignatures = projectSignatures.get(projectKey) ?? new Set<string>();
      if (seenSignatures.has(attemptSignature)) duplicateProjectSignatures.add(attemptKey);
      else seenSignatures.add(attemptSignature);
      projectSignatures.set(projectKey, seenSignatures);
    }
    if (!attemptSignature || !candidateKey || candidateKey !== expectedCandidateKey
      || (operation && attemptMaterialIds && !roleMaterialIdsMatch(attempt, operation, attemptMaterialIds))) {
      actionDiffSignatureMismatches.add(attemptKey);
    }

    const ordinal = integerValue(attempt.ordinal);
    if (ordinal !== attemptIndex + 1) attemptOrdinalMismatches.add(attemptKey);
    const totalBudget = integerValue(campaign.budget);
    const noResponseBudget = integerValue(campaign.noResponseBudget);
    const responseBudget = integerValue(campaign.responseBudget);
    const attemptsThroughCurrent = (Array.isArray(campaign.attempts)
      ? campaign.attempts.slice(0, attemptIndex + 1)
      : []).map(objectRecord).filter((item): item is Record<string, unknown> => item !== null);
    const noResponsesThroughCurrent = attemptsThroughCurrent
      .filter((item) => outcomeValue(item.outcome) === 'no-response').length;
    const responsesThroughCurrent = attemptsThroughCurrent
      .filter((item) => outcomeValue(item.outcome) === 'response').length;
    if (totalBudget !== null && (attemptIndex >= totalBudget || (ordinal !== null && ordinal > totalBudget))) {
      totalBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }
    if (noResponseBudget !== null && noResponsesThroughCurrent > noResponseBudget) {
      noResponseBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }
    if (responseBudget !== null && responsesThroughCurrent > responseBudget) {
      responseBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }

    const candidates = records(campaign.candidates);
    const candidateMatches = candidateKey
      ? candidates.filter((item) => stringValue(item.key) === candidateKey)
      : [];
    const candidate = candidateMatches.length === 1 ? candidateMatches[0] : undefined;
    if (candidateMatches.length !== 1) campaignMismatches.add(attemptKey);
    const candidateMaterialIds = materialPair(candidate?.materialIds);
    const legacyCandidate = candidate?.operation === undefined
      && (legacyCampaign || legacyPairShape(candidate, 'key'));
    const candidateOperation = candidate
      ? operationValue(candidate.operation, legacyCandidate)
      : null;
    const candidateTargetMaterialId = integerValue(candidate?.targetMaterialId);
    const candidateSignature = signatureFor(candidateOperation, candidateMaterialIds, candidateTargetMaterialId);
    const candidateExpectedKey = candidateOperation && candidateMaterialIds
      ? candidateKeyFor(candidateOperation, candidateMaterialIds, candidateTargetMaterialId)
      : null;
    const candidateQuestion = questionValue(candidate?.questionKind);
    if (candidate && !roleBasisMatches(
      storedRoleBasis(candidate),
      attemptRoleBasis,
      Array.isArray(attempt.sourceKeys),
    )) {
      candidateAttemptRoleBasisMismatches.add(attemptKey);
    }
    if (question && candidateQuestion !== question) {
      candidateAttemptRoleBasisMismatches.add(attemptKey);
    }
    if (!operation || !candidateOperation || candidateOperation !== operation
      || (candidate?.operation === undefined && attempt.operation !== undefined)) {
      operationMismatches.add(operationMismatchKey);
    }
    if (!attemptSignature || !candidateSignature || candidateSignature !== attemptSignature
      || !candidateKey || stringValue(candidate?.key) !== candidateKey
      || candidateKey !== expectedCandidateKey || stringValue(candidate?.key) !== candidateExpectedKey
      || (candidateOperation && candidateMaterialIds
        && !roleMaterialIdsMatch(candidate!, candidateOperation, candidateMaterialIds))) {
      actionDiffSignatureMismatches.add(attemptKey);
    }
    if (stringKeys(campaign.sourceKeys).length === 0
      || stringKeys(candidate?.sourceKeys).length === 0) {
      missingSourceKeys.add(attemptKey);
    }
    attemptDetails.set(attemptKey, {
      operation,
      materialIds: attemptMaterialIds,
      candidate,
    });

    const eventId = attemptEventId;
    const actionEntry = eventId ? actionById.get(eventId) : undefined;
    if (!eventId || !actionEntry) {
      unresolvedActionEvents.add(eventId ?? attemptKey);
      continue;
    }
    const { event, diff } = actionEntry;
    const action = objectRecord(event.action);
    const eventWho = stringValue(event.who);
    const campaignActorId = stringValue(campaign.actorId);
    const diffActorId = stringValue(diff.projectHypothesisActorId);
    const campaignProjectId = stringValue(campaign.projectId);
    const diffProjectId = stringValue(diff.projectHypothesisProjectId);
    const diffCampaignId = stringValue(diff.projectHypothesisCampaignId);
    if (!eventWho || !personIds.has(eventWho) || !diffActorId || !personIds.has(diffActorId)) {
      unresolvedActors.add('action:' + actionEntry.key);
    }
    if (eventWho !== campaignActorId || diffActorId !== campaignActorId || diffActorId !== eventWho) {
      actorMismatches.add(actionEntry.key);
    }
    if (!diffProjectId || !projectById.has(diffProjectId)) unresolvedProjects.add('action:' + actionEntry.key);
    if (diffProjectId !== entry.projectId || diffProjectId !== campaignProjectId) {
      projectMismatches.add(actionEntry.key);
    }
    if (!diffCampaignId || !campaignEntriesById.has(diffCampaignId)) {
      unresolvedCampaigns.add('action:' + actionEntry.key);
    }
    if (diffCampaignId !== entry.campaignId
      || (diffCampaignId && (campaignEntriesById.get(diffCampaignId)?.length ?? 0) !== 1)) {
      campaignMismatches.add(actionEntry.key);
    }
    const projectActionEventIds = stringKeys(entry.project.actionEventIds);
    if (action?.kind !== 'act'
      || integerValue(event.atMonth) !== integerValue(attempt.atMonth)
      || !projectActionEventIds.includes(eventId)) {
      actionMismatches.add(actionEntry.key);
    }
    const diffOperation = operationValue(
      diff.projectHypothesisOperation,
      legacyAttempt && operation === 'combine-inventory',
    );
    const projectedRoleBasis = diffRoleBasis(diff);
    const diffQuestion = questionValue(projectedRoleBasis.questionKind);
    if (!roleBasisMatches(attemptRoleBasis, projectedRoleBasis, Array.isArray(attempt.sourceKeys))) {
      actionDiffRoleBasisMismatches.add(attemptKey);
    }
    if (diffQuestion && entityRoleBasisPresent(projectedRoleBasis, diffOperation)) {
      actionDiffsWithEntityRoleBasis += 1;
    }
    if (hasNonFiniteRoleScore(projectedRoleBasis)) {
      nonFiniteRoleScores.add('action:' + actionEntry.key);
    }
    if (diffQuestion && (diffOperation !== expectedQuestionOperation(diffQuestion)
      || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(expectedQuestionOperation(diffQuestion)))) {
      questionOperationMismatches.add('action:' + actionEntry.key);
    }
    if (!operation || diffOperation !== operation
      || (legacyAttempt && stringValue(campaign.version) === 'project-hypothesis-campaign-v2'
        && diff.projectHypothesisOperation !== undefined)
      || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(operation)) {
      operationMismatches.add(operationMismatchKey);
      actionMismatches.add(actionEntry.key);
    }
    const diffOrdinal = integerValue(diff.projectHypothesisAttemptOrdinal);
    if (diffOrdinal !== ordinal || diffOrdinal !== attemptIndex + 1) {
      attemptOrdinalMismatches.add(attemptKey);
    }
    const diffBudget = integerValue(diff.projectHypothesisBudget);
    const legacyBudgetMatches = legacyAttempt && totalBudget !== null && diffBudget !== null
      && diffBudget >= (ordinal ?? attemptIndex + 1) && diffBudget <= totalBudget;
    if (diffBudget !== totalBudget && !legacyBudgetMatches) actionMismatches.add(actionEntry.key);
    const diffNoResponseBudget = integerValue(diff.projectHypothesisNoResponseBudget);
    const diffResponseBudget = integerValue(diff.projectHypothesisResponseBudget);
    if (legacyAttempt) {
      if (diffNoResponseBudget !== null && diffNoResponseBudget !== noResponseBudget) {
        actionMismatches.add(actionEntry.key);
      }
      if (diffResponseBudget !== null && diffResponseBudget !== responseBudget) {
        actionMismatches.add(actionEntry.key);
      }
    } else if (diffNoResponseBudget !== noResponseBudget || diffResponseBudget !== responseBudget) {
      actionMismatches.add(actionEntry.key);
    }
    if (totalBudget !== null && diffOrdinal !== null && diffOrdinal > totalBudget) {
      totalBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }
    const projectedMaterialIds = materialPair(diff.projectHypothesisMaterialIds);
    const projectedTargetMaterialId = integerValue(diff.projectHypothesisTargetMaterialId);
    const projectedSignature = signatureFor(diffOperation, projectedMaterialIds, projectedTargetMaterialId);
    const reconstructedActualSignature = operation ? actualSignature(diff, operation) : null;
    const diffCandidateKey = stringValue(diff.projectHypothesisCandidateKey);
    if (!attemptSignature || reconstructedActualSignature !== attemptSignature
      || projectedSignature !== attemptSignature || diffCandidateKey !== candidateKey
      || (diffOperation && projectedMaterialIds
        && !roleMaterialIdsMatch(diff, diffOperation, projectedMaterialIds, 'projectHypothesis'))) {
      actionDiffSignatureMismatches.add(attemptKey);
    }
    const actionOutcome = event.status === 'completed'
      ? 'response'
      : event.status === 'blocked' ? 'no-response' : null;
    if (!outcome || outcomeValue(diff.projectHypothesisOutcome) !== outcome || actionOutcome !== outcome) {
      actionDiffOutcomeMismatches.add(attemptKey);
    }
    if (stringKeys(diff.projectHypothesisSourceKeys).length === 0) missingSourceKeys.add(attemptKey);
    if (diff.projectHypothesisHadReliableKnowledge !== false) reliableKnowledgeViolations.add(actionEntry.key);
  }

  const validVerificationByAttempt = new Map<string, {
    outputMaterialId: number;
    sourceKey: string;
    responseEventId: string;
    verifiedEventId: string;
    verifiedAtMonth: number;
    verificationEventIndex: number;
    actorId: string | null;
  }>();
  for (const entry of attemptEntries) {
    if (outcomeValue(entry.attempt.outcome) !== 'response') continue;
    const details = attemptDetails.get(entry.attemptKey);
    const responseEventId = stringValue(entry.attempt.eventId);
    const verifiedEventId = stringValue(entry.attempt.verifiedEventId);
    const verifiedAtMonth = integerValue(entry.attempt.verifiedAtMonth);
    const outputMaterialId = integerValue(entry.attempt.outputMaterialId);
    const verificationEntry = verifiedEventId ? actionById.get(verifiedEventId) : undefined;
    const verificationAction = verificationEntry ? objectRecord(verificationEntry.event.action) : null;
    const verificationRequest = objectRecord(verificationAction?.verification);
    const verificationTarget = objectRecord(verificationAction?.target);
    const verificationDiff = verificationEntry?.diff;
    const attemptTechniqueId = stringValue(entry.attempt.techniqueId);
    const responseRef = objectRecord(entry.attempt.responseRef);
    const sourceKey = responseRefSourceKey(responseRef, stringValue(entry.campaign.actorId));
    const responseTargetMatches = responseRef?.kind === 'inventory-stack'
      ? verificationTarget?.kind === 'inventory-stack'
        && stringValue(verificationTarget.stackId) === stringValue(responseRef.stackId)
        && integerValue(responseRef.materialId) === outputMaterialId
      : responseRef?.kind === 'voxel'
        ? verificationTarget?.kind === 'voxel'
          && JSON.stringify(objectRecord(verificationTarget.position)) === JSON.stringify(objectRecord(responseRef.position))
          && integerValue(responseRef.materialId) === outputMaterialId
        : false;
    if (!details?.operation || !responseEventId || !verifiedEventId || verifiedAtMonth === null
      || outputMaterialId === null || !verificationEntry || verificationAction?.kind !== 'attend'
      || !attemptTechniqueId || !sourceKey || !responseTargetMatches
      || stringValue(verificationRequest?.techniqueId) !== attemptTechniqueId
      || stringValue(verificationRequest?.sourceEventId) !== responseEventId
      || integerValue(verificationRequest?.expectedMaterialId) !== outputMaterialId
      || verificationEntry.event.status !== 'completed'
      || stringValue(verificationEntry.event.who) !== stringValue(entry.campaign.actorId)
      || integerValue(verificationEntry.event.atMonth) !== verifiedAtMonth
      || verifiedAtMonth < (integerValue(entry.attempt.atMonth) ?? verifiedAtMonth)
      || !stringKeys(entry.project.actionEventIds).includes(verifiedEventId)
      || stringValue(verificationDiff?.projectHypothesisVerificationCampaignId) !== entry.campaignId
      || stringValue(verificationDiff?.projectHypothesisVerificationProjectId) !== entry.projectId
      || stringValue(verificationDiff?.projectHypothesisVerifiedAttemptEventId) !== responseEventId
      || stringValue(verificationDiff?.projectHypothesisVerifiedCandidateKey)
        !== stringValue(entry.attempt.candidateKey)
      || operationValue(verificationDiff?.projectHypothesisVerifiedOperation) !== details.operation
      || integerValue(verificationDiff?.projectHypothesisVerifiedOutputMaterialId) !== outputMaterialId
      || stringValue(verificationDiff?.verifiedSourceEventId) !== responseEventId) {
      continue;
    }
    verifiedResponses.add(entry.attemptKey);
    validVerificationByAttempt.set(entry.attemptKey, {
      outputMaterialId,
      sourceKey,
      responseEventId,
      verifiedEventId,
      verifiedAtMonth,
      verificationEventIndex: verificationEntry.eventIndex,
      actorId: stringValue(entry.campaign.actorId),
    });
  }
  for (const entry of attemptEntries) {
    const details = attemptDetails.get(entry.attemptKey);
    const candidate = details?.candidate;
    const atMonth = integerValue(entry.attempt.atMonth);
    if (!details?.materialIds || !candidate || atMonth === null
      || !stringKeys(candidate.reasonKeys).includes('verified-response-material')) {
      continue;
    }
    const sourceFactIds = new Set([
      ...stringKeys(entry.attempt.sourceFactIds),
      ...stringKeys(candidate.sourceFactIds),
    ]);
    const earlierAttempts = attemptEntries
      .filter((prior) => prior.key === entry.key && prior.attemptIndex < entry.attemptIndex)
      .sort((left, right) => right.attemptIndex - left.attemptIndex);
    const source = earlierAttempts.find((prior) => {
      const verification = validVerificationByAttempt.get(prior.attemptKey);
      return verification !== undefined
        && atMonth >= verification.verifiedAtMonth
        && details.materialIds!.includes(verification.outputMaterialId)
        && sourceFactIds.has(verification.responseEventId);
    });
    if (source) responseDrivenTransitions.add(entry.attemptKey);
  }
  for (const entry of attemptEntries) {
    const details = attemptDetails.get(entry.attemptKey);
    if (!details?.operation || !details.materialIds) continue;
    const atMonth = integerValue(entry.attempt.atMonth);
    const actionEventId = stringValue(entry.attempt.eventId);
    const actionEntry = actionEventId ? actionById.get(actionEventId) : undefined;
    const actionEventIndex = actionEntry?.eventIndex;
    const actorId = stringValue(entry.campaign.actorId);
    if (atMonth === null || !actionEntry || actionEventIndex === undefined || !actorId) continue;
    const materialAttributionSourceFactIds = new Set([
      ...stringKeys(entry.attempt.sourceFactIds),
      ...stringKeys(details.candidate?.sourceFactIds),
    ]);
    const priorVerifiedEntities = [...validVerificationByAttempt.values()].filter((verification) => (
      verification.actorId === actorId
        && (verification.verifiedAtMonth < atMonth
          || (verification.verifiedAtMonth === atMonth
            && verification.verificationEventIndex < actionEventIndex))
        && (materialAttributionSourceFactIds.has(verification.responseEventId)
          || materialAttributionSourceFactIds.has(verification.verifiedEventId))
    ));
    const toolMaterialId = integerValue(entry.attempt.toolRoleMaterialId)
      ?? integerValue(entry.attempt.toolMaterialId)
      ?? details.materialIds[0];
    const inputMaterialId = integerValue(entry.attempt.inputRoleMaterialId)
      ?? integerValue(entry.attempt.inputMaterialId)
      ?? (details.operation === 'expose-local' ? details.materialIds[0] : details.materialIds[1]);
    if (details.operation === 'exert-air') {
      const verifiedMaterials = new Set(priorVerifiedEntities.map((verification) => verification.outputMaterialId));
      if (verifiedMaterials.has(toolMaterialId)) exertVerifiedResponseToolAttempts.add(entry.attemptKey);
      if (verifiedMaterials.has(inputMaterialId)) exertVerifiedResponseInputAttempts.add(entry.attemptKey);
    }

    const reasons = exactReasonKeys(entry.attempt.roleReasonKeys) ?? [];
    const attemptSourceFactIds = new Set(stringKeys(entry.attempt.sourceFactIds));
    const attemptSourceKeys = new Set(stringKeys(entry.attempt.sourceKeys));
    const actionSourceKeys = new Set(stringKeys(actionEntry.diff.projectHypothesisSourceKeys));
    const actionBasisMatches = roleBasisMatches(
      storedRoleBasis(entry.attempt),
      diffRoleBasis(actionEntry.diff),
      Array.isArray(entry.attempt.sourceKeys),
    );
    const causallySourcedEntities = priorVerifiedEntities.filter((verification) => (
      attemptSourceFactIds.has(verification.responseEventId)
        || attemptSourceFactIds.has(verification.verifiedEventId)
    ));
    const auditRoleAttribution = (
      role: 'tool' | 'input',
      materialId: number,
      sourceField: 'toolSourceKey' | 'inputSourceKey',
      diffSourceField: 'projectHypothesisToolSourceKey' | 'projectHypothesisInputSourceKey',
      exactAttempts: Set<string>,
    ) => {
      const legacyReason = `verified-response-as-${role}`;
      const exactReason = `exact-verified-response-as-${role}`;
      if (!reasons.includes(legacyReason) && !reasons.includes(exactReason)) return;
      const sourceKey = stringValue(entry.attempt[sourceField]);
      const actionSourceKey = stringValue(actionEntry.diff[diffSourceField]);
      const exactEntity = sourceKey ? causallySourcedEntities.find((verification) => (
        verification.outputMaterialId === materialId && verification.sourceKey === sourceKey
      )) : undefined;
      if (sourceKey && exactEntity && actionBasisMatches && actionSourceKey === sourceKey
        && attemptSourceKeys.has(sourceKey) && actionSourceKeys.has(sourceKey)) {
        exactAttempts.add(entry.attemptKey);
      } else {
        materialOnlyVerifiedResponseAttributionViolations.add(entry.attemptKey);
      }
    };
    auditRoleAttribution(
      'tool',
      toolMaterialId,
      'toolSourceKey',
      'projectHypothesisToolSourceKey',
      exactEntityVerifiedResponseToolAttempts,
    );
    auditRoleAttribution(
      'input',
      inputMaterialId,
      'inputSourceKey',
      'projectHypothesisInputSourceKey',
      exactEntityVerifiedResponseInputAttempts,
    );
  }

  const hypothesisDiffFields = [
    'projectHypothesisCampaignId', 'projectHypothesisProjectId', 'projectHypothesisActorId',
    'projectHypothesisCandidateKey', 'projectHypothesisOperation', 'projectHypothesisMaterialIds',
    'projectHypothesisToolMaterialId', 'projectHypothesisInputMaterialId',
    'projectHypothesisTargetMaterialId', 'projectHypothesisToolSourceKey',
    'projectHypothesisInputSourceKey', 'projectHypothesisAttemptOrdinal',
    'projectHypothesisQuestionKind', 'projectHypothesisRoleScore',
    'projectHypothesisToolRoleScore', 'projectHypothesisInputRoleScore',
    'projectHypothesisSurfaceRoleScore', 'projectHypothesisToolRoleMaterialId',
    'projectHypothesisInputRoleMaterialId', 'projectHypothesisSurfaceRoleMaterialId',
    'projectHypothesisRoleReasonKeys',
    'projectHypothesisBudget', 'projectHypothesisNoResponseBudget', 'projectHypothesisResponseBudget',
    'projectHypothesisOutcome', 'projectHypothesisSourceKeys', 'projectHypothesisHadReliableKnowledge',
  ];
  for (const actionEntry of actionEntries) {
    const { event, diff } = actionEntry;
    if (!hypothesisDiffFields.some((field) => field in diff)) continue;
    const matches = actionEntry.id ? attemptsByEventId.get(actionEntry.id) ?? [] : [];
    if (matches.length !== 1) actionMismatches.add(actionEntry.key);
    const diffProjectId = stringValue(diff.projectHypothesisProjectId);
    const diffActorId = stringValue(diff.projectHypothesisActorId);
    const diffCampaignId = stringValue(diff.projectHypothesisCampaignId);
    if (!diffProjectId || !projectById.has(diffProjectId)) unresolvedProjects.add('action:' + actionEntry.key);
    if (!diffActorId || !personIds.has(diffActorId)) unresolvedActors.add('action:' + actionEntry.key);
    if (!diffCampaignId || !campaignEntriesById.has(diffCampaignId)) {
      unresolvedCampaigns.add('action:' + actionEntry.key);
    } else if ((campaignEntriesById.get(diffCampaignId)?.length ?? 0) !== 1) {
      campaignMismatches.add(actionEntry.key);
    }
    const action = objectRecord(event.action);
    const explicitDiffOperation = operationValue(diff.projectHypothesisOperation);
    const inferredLegacyOperation = explicitDiffOperation ?? (
      diff.projectHypothesisOperation === undefined
        && action?.kind === 'act' && action.operation === 'combine'
        ? 'combine-inventory'
        : null
    );
    if (!inferredLegacyOperation || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(inferredLegacyOperation)) {
      operationMismatches.add(actionEntry.key);
      actionMismatches.add(actionEntry.key);
    }
    const projectedRoleBasis = diffRoleBasis(diff);
    const diffQuestion = questionValue(projectedRoleBasis.questionKind);
    if (hasNonFiniteRoleScore(projectedRoleBasis)) {
      nonFiniteRoleScores.add('action:' + actionEntry.key);
    }
    if (diffQuestion && (inferredLegacyOperation !== expectedQuestionOperation(diffQuestion)
      || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(expectedQuestionOperation(diffQuestion)))) {
      questionOperationMismatches.add('action:' + actionEntry.key);
    }
    if (stringKeys(diff.projectHypothesisSourceKeys).length === 0) missingSourceKeys.add('action:' + actionEntry.key);
    if (diff.projectHypothesisHadReliableKnowledge !== false) reliableKnowledgeViolations.add(actionEntry.key);
  }

  return {
    hypothesisCampaigns: campaignEntries.length,
    hypothesisCandidates: candidateEntries.length,
    hypothesisAttempts: attemptEntries.length,
    hypothesisResponses,
    hypothesisNoResponses,
    hypothesisExhaustedCampaigns: campaignEntries.filter((entry) => entry.campaign.status === 'exhausted').length,
    hypothesisFirstAttemptResponses,
    hypothesisFirstAttemptNoResponses,
    hypothesisCombineAttempts: operationCounts['combine-inventory'].attempts,
    hypothesisCombineResponses: operationCounts['combine-inventory'].responses,
    hypothesisCombineNoResponses: operationCounts['combine-inventory'].noResponses,
    hypothesisExertAttempts: operationCounts['exert-air'].attempts,
    hypothesisExertResponses: operationCounts['exert-air'].responses,
    hypothesisExertNoResponses: operationCounts['exert-air'].noResponses,
    hypothesisExposeAttempts: operationCounts['expose-local'].attempts,
    hypothesisExposeResponses: operationCounts['expose-local'].responses,
    hypothesisExposeNoResponses: operationCounts['expose-local'].noResponses,
    hypothesisConnectManipulatorShapesCandidates: questionCounts['connect-manipulator-shapes'].candidates,
    hypothesisConnectManipulatorShapesAttempts: questionCounts['connect-manipulator-shapes'].attempts,
    hypothesisConnectManipulatorShapesResponses: questionCounts['connect-manipulator-shapes'].responses,
    hypothesisConnectManipulatorShapesNoResponses: questionCounts['connect-manipulator-shapes'].noResponses,
    hypothesisConnectFlexibleLayersCandidates: questionCounts['connect-flexible-layers'].candidates,
    hypothesisConnectFlexibleLayersAttempts: questionCounts['connect-flexible-layers'].attempts,
    hypothesisConnectFlexibleLayersResponses: questionCounts['connect-flexible-layers'].responses,
    hypothesisConnectFlexibleLayersNoResponses: questionCounts['connect-flexible-layers'].noResponses,
    hypothesisSeekLocalHeatCandidates: questionCounts['seek-local-heat'].candidates,
    hypothesisSeekLocalHeatAttempts: questionCounts['seek-local-heat'].attempts,
    hypothesisSeekLocalHeatResponses: questionCounts['seek-local-heat'].responses,
    hypothesisSeekLocalHeatNoResponses: questionCounts['seek-local-heat'].noResponses,
    hypothesisShapePortableSurfaceCandidates: questionCounts['shape-portable-surface'].candidates,
    hypothesisShapePortableSurfaceAttempts: questionCounts['shape-portable-surface'].attempts,
    hypothesisShapePortableSurfaceResponses: questionCounts['shape-portable-surface'].responses,
    hypothesisShapePortableSurfaceNoResponses: questionCounts['shape-portable-surface'].noResponses,
    hypothesisTransformSubjectWithObservedHeatCandidates:
      questionCounts['transform-subject-with-observed-heat'].candidates,
    hypothesisTransformSubjectWithObservedHeatAttempts:
      questionCounts['transform-subject-with-observed-heat'].attempts,
    hypothesisTransformSubjectWithObservedHeatResponses:
      questionCounts['transform-subject-with-observed-heat'].responses,
    hypothesisTransformSubjectWithObservedHeatNoResponses:
      questionCounts['transform-subject-with-observed-heat'].noResponses,
    hypothesisCandidatesWithRoleBasis: candidatesWithRoleBasis,
    hypothesisAttemptsWithRoleBasis: attemptsWithRoleBasis,
    hypothesisCandidateRoleBasisCoverage: candidateEntries.length
      ? Math.round(candidatesWithRoleBasis / candidateEntries.length * 10_000) / 100
      : 100,
    hypothesisAttemptRoleBasisCoverage: attemptEntries.length
      ? Math.round(attemptsWithRoleBasis / attemptEntries.length * 10_000) / 100
      : 100,
    hypothesisCandidatesWithEntityRoleBasis: candidatesWithEntityRoleBasis,
    hypothesisAttemptsWithEntityRoleBasis: attemptsWithEntityRoleBasis,
    hypothesisActionDiffsWithEntityRoleBasis: actionDiffsWithEntityRoleBasis,
    hypothesisCandidateEntityRoleBasisCoverage: candidateEntries.length
      ? Math.round(candidatesWithEntityRoleBasis / candidateEntries.length * 10_000) / 100
      : 100,
    hypothesisAttemptEntityRoleBasisCoverage: attemptEntries.length
      ? Math.round(attemptsWithEntityRoleBasis / attemptEntries.length * 10_000) / 100
      : 100,
    hypothesisActionDiffEntityRoleBasisCoverage: attemptEntries.length
      ? Math.round(actionDiffsWithEntityRoleBasis / attemptEntries.length * 10_000) / 100
      : 100,
    hypothesisCandidatesMissingQuestionKind: candidatesMissingQuestionKind.size,
    hypothesisCandidatesMissingRoleBasis: candidatesMissingRoleBasis.size,
    hypothesisAttemptsMissingQuestionKind: attemptsMissingQuestionKind.size,
    hypothesisAttemptsMissingRoleBasis: attemptsMissingRoleBasis.size,
    hypothesisCandidateAttemptRoleBasisMismatches: candidateAttemptRoleBasisMismatches.size,
    hypothesisActionDiffRoleBasisMismatches: actionDiffRoleBasisMismatches.size,
    hypothesisNonFiniteRoleScores: nonFiniteRoleScores.size,
    hypothesisQuestionOperationMismatches: questionOperationMismatches.size,
    hypothesisExertVerifiedResponseToolAttempts: exertVerifiedResponseToolAttempts.size,
    hypothesisExertVerifiedResponseInputAttempts: exertVerifiedResponseInputAttempts.size,
    hypothesisExactEntityVerifiedResponseToolAttempts: exactEntityVerifiedResponseToolAttempts.size,
    hypothesisExactEntityVerifiedResponseInputAttempts: exactEntityVerifiedResponseInputAttempts.size,
    hypothesisMaterialOnlyVerifiedResponseAttributionViolations:
      materialOnlyVerifiedResponseAttributionViolations.size,
    hypothesisVerifiedResponses: verifiedResponses.size,
    hypothesisResponseDrivenTransitions: responseDrivenTransitions.size,
    hypothesisUniquePairs: uniqueSignatures.size,
    hypothesisUniqueSignatures: uniqueSignatures.size,
    hypothesisUnresolvedProjects: unresolvedProjects.size,
    hypothesisProjectMismatches: projectMismatches.size,
    hypothesisUnresolvedActors: unresolvedActors.size,
    hypothesisActorMismatches: actorMismatches.size,
    hypothesisUnresolvedCampaigns: unresolvedCampaigns.size,
    hypothesisCampaignMismatches: campaignMismatches.size,
    hypothesisUnresolvedActionEvents: unresolvedActionEvents.size,
    hypothesisActionMismatches: actionMismatches.size,
    hypothesisOperationMismatches: operationMismatches.size,
    hypothesisDuplicateProjectPairs: duplicateProjectSignatures.size,
    hypothesisDuplicateProjectSignatures: duplicateProjectSignatures.size,
    hypothesisBudgetExceeds: budgetExceeds.size,
    hypothesisTotalBudgetExceeds: totalBudgetExceeds.size,
    hypothesisNoResponseBudgetExceeds: noResponseBudgetExceeds.size,
    hypothesisResponseBudgetExceeds: responseBudgetExceeds.size,
    hypothesisAttemptOrdinalMismatches: attemptOrdinalMismatches.size,
    hypothesisActionDiffPairMismatches: actionDiffSignatureMismatches.size,
    hypothesisActionDiffSignatureMismatches: actionDiffSignatureMismatches.size,
    hypothesisActionDiffOutcomeMismatches: actionDiffOutcomeMismatches.size,
    hypothesisMissingSourceKeys: missingSourceKeys.size,
    hypothesisReliableKnowledgeViolations: reliableKnowledgeViolations.size,
  };
}
