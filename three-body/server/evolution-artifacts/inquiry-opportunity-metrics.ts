import type { SimulationState } from '../../src/game/eland/simulation';
import { Material, materialDefinition, materialHas } from '../../src/game/eland/domain/material';
import { objectRecord } from './object-record';

export interface InquiryOpportunityMetrics {
  inquiryOpportunityBasisProjects: number;
  inquiryOpportunityBasisCoverage: number;
  inquiryOpportunityFailedProjects: number;
  inquiryOpportunityTerminalBasisProjects: number;
  inquiryOpportunityTerminalBasisCoverage: number;
  inquiryOpportunityRenewalProjects: number;
  inquiryOpportunityRenewalKeys: number;
  inquiryOpportunityReopenWithoutRenewalViolations: number;
  inquiryOpportunityUnresolvedInheritedProjects: number;
  inquiryOpportunityInheritedActorMismatches: number;
  inquiryOpportunityInheritedFunctionMismatches: number;
  inquiryOpportunityInheritedStatusMismatches: number;
  inquiryOpportunityRenewalKeyMismatches: number;
  hypothesisReliableNoResponseExcessAttempts: number;
  inquiryOpportunityRenewalHypothesisProjects: number;
  inquiryOpportunityRenewalHypothesisCandidateCoverage: number;
  inquiryOpportunityRenewalHypothesisAttemptProjects: number;
  inquiryOpportunityRenewalHypothesisFirstAttemptCoverage: number;
  inquiryOpportunityConstructionRenewalHypothesisProjects: number;
  inquiryOpportunityConstructionRenewalHypothesisCandidateCoverage: number;
  inquiryOpportunityConstructionRenewalHypothesisAttemptProjects: number;
  inquiryOpportunityConstructionRenewalHypothesisFirstAttemptCoverage: number;
  inquiryOpportunitySourceBasisProjects: number;
  inquiryOpportunitySourceBasisCoverage: number;
  inquiryOpportunityRenewalCommitmentProjects: number;
  inquiryOpportunityRenewalCommitmentProjectCoverage: number;
  inquiryOpportunityRenewalCommitmentSourceCoverage: number;
  inquiryOpportunityUnresolvedSources: number;
  inquiryOpportunityRenewalCommitmentActorMismatches: number;
  inquiryOpportunityRenewalCommitmentFunctionMismatches: number;
  inquiryOpportunityRenewalCommitmentInheritedStatusMismatches: number;
  inquiryOpportunityRenewalFirstCandidateExactSourceCoverage: number;
  inquiryOpportunityRenewalFirstAttemptExactSourceCoverage: number;
  inquiryOpportunityRenewalFallbackBeforeCommitmentViolations: number;
  inquiryOpportunityMaterialOnlyCommitmentAttributionViolations: number;
  inquiryOpportunityConstructionRenewalFirstCandidateExactSourceCoverage: number;
  inquiryOpportunityConstructionRenewalFirstAttemptExactSourceCoverage: number;
  inquiryOpportunityConstructionRenewalFallbackBeforeCommitmentViolations: number;
  inquiryOpportunityConstructionMaterialOnlyCommitmentAttributionViolations: number;
}

export function inquiryOpportunityMetrics(state: SimulationState): InquiryOpportunityMetrics {
  type HypothesisOperation = 'combine-inventory' | 'exert-air' | 'expose-local';
  type OpportunityKind = 'material' | 'knowledge' | 'target' | 'verified-response' | 'ready-record-carrier';
  type OpportunitySource = {
    opportunityKey: string;
    kind: OpportunityKind;
    materialId: number | null;
    currentSourceKey: string | null;
    sourceKeys: string[];
    sourceFactIds: string[];
  };
  const rawState = state as unknown as {
    people?: unknown;
    projects?: unknown;
    world?: { past?: unknown };
  };
  const records = (value: unknown): Record<string, unknown>[] => (
    Array.isArray(value)
      ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
      : []
  );
  const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const stringKeys = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  );
  const exactStringKeys = (value: unknown): string[] | null => (
    Array.isArray(value)
      && value.every((item) => typeof item === 'string' && item.length > 0)
      ? value as string[]
      : null
  );
  const integerValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isInteger(value) ? value : null
  );
  const coverage = (covered: number, total: number): number => (
    total ? Math.round(covered / total * 10_000) / 100 : 100
  );
  const operationValue = (value: unknown): HypothesisOperation | null => (
    value === 'combine-inventory' || value === 'exert-air' || value === 'expose-local'
      ? value
      : null
  );
  const signatureFor = (
    operation: HypothesisOperation,
    attempt: Record<string, unknown>,
  ): string | null => {
    if (!Array.isArray(attempt.materialIds) || attempt.materialIds.length !== 2) return null;
    const first = integerValue(attempt.materialIds[0]);
    const second = integerValue(attempt.materialIds[1]);
    if (first === null || second === null) return null;
    if (operation === 'combine-inventory') {
      return first <= second ? `${first}+${second}` : `${second}+${first}`;
    }
    const target = integerValue(attempt.targetMaterialId);
    if (operation === 'exert-air') {
      return `exert-air:${first}>${second}@${target ?? Material.Air}`;
    }
    return `expose-local:${first}@${target ?? second}`;
  };

  const projects = records(rawState.projects).map((project, projectIndex) => ({ project, projectIndex }));
  const inquiryProjects = projects.filter(({ project }) => (
    project.kind === 'production' || project.kind === 'inquiry'
  ));
  const exhaustedSearchCampaigns = (project: Record<string, unknown>): Record<string, unknown>[] => (
    records(project.searchCampaigns).filter((campaign) => campaign.status === 'exhausted')
  );
  const hasHypothesisAttempts = (project: Record<string, unknown>): boolean => (
    records(objectRecord(project.hypothesisCampaign)?.attempts).length > 0
  );
  const isReopenConstraint = (project: Record<string, unknown>): boolean => (
    project.status === 'blocked'
      && (exhaustedSearchCampaigns(project).length > 0
        || hasHypothesisAttempts(project))
  );
  const failedProjects = projects.filter(({ project }) => isReopenConstraint(project));
  const reopenConstraintProjects = failedProjects;
  // A construction project joins the opportunity-source audit only after the
  // opportunity-memory/renewal gate has attached a basis. Ordinary first-attempt
  // constructions remain outside the production/inquiry opening-basis denominator.
  const sourceAuditProjects = projects.filter(({ project }) => (
    project.kind === 'production'
      || project.kind === 'inquiry'
      || objectRecord(project.inquiryOpportunityBasis) !== null
  ));
  const projectEntriesById = new Map<string, typeof projects>();
  for (const entry of projects) {
    const projectId = stringValue(entry.project.id);
    if (!projectId) continue;
    const matches = projectEntriesById.get(projectId) ?? [];
    matches.push(entry);
    projectEntriesById.set(projectId, matches);
  }
  const actionById = new Map(records(rawState.world?.past).flatMap((event) => {
    const eventId = stringValue(event.id);
    return eventId ? [[eventId, event] as const] : [];
  }));
  const opportunityKind = (value: unknown): OpportunityKind | null => (
    value === 'material' || value === 'knowledge' || value === 'target'
      || value === 'verified-response' || value === 'ready-record-carrier'
      ? value
      : null
  );
  const parseOpportunitySource = (
    value: unknown,
    opportunityKeys: ReadonlySet<string>,
  ): OpportunitySource | null => {
    const source = objectRecord(value);
    const opportunityKey = stringValue(source?.opportunityKey);
    const kind = opportunityKind(source?.kind);
    const sourceKeys = exactStringKeys(source?.sourceKeys);
    const sourceFactIds = exactStringKeys(source?.sourceFactIds);
    const materialId = integerValue(source?.materialId);
    if (!source || !opportunityKey || !kind || !sourceKeys?.length || sourceFactIds === null
      || !opportunityKeys.has(opportunityKey)
      || sourceFactIds.some((eventId) => !actionById.has(eventId))) return null;
    const currentMaterialSourceKey = sourceKeys[0] ?? null;
    const tangibleCurrentMaterialSource = currentMaterialSourceKey !== null
      && (currentMaterialSourceKey.startsWith('inventory:') || currentMaterialSourceKey.startsWith('drop:'));
    const searchSourcePrefix = materialId === null ? null : `search-source:${materialId}:`;
    const exactSearchSourceKey = searchSourcePrefix && opportunityKey.startsWith(searchSourcePrefix)
      ? opportunityKey.slice(searchSourcePrefix.length)
      : null;
    const valid = kind === 'material'
      ? materialId !== null
        && ((opportunityKey === `material:${materialId}` && tangibleCurrentMaterialSource)
          || (exactSearchSourceKey !== null
            && (exactSearchSourceKey.startsWith('inventory:') || exactSearchSourceKey.startsWith('drop:'))
            && exactSearchSourceKey === currentMaterialSourceKey))
      : kind === 'knowledge'
        ? opportunityKey.startsWith('knowledge:') && sourceKeys.includes(opportunityKey)
        : kind === 'target'
          ? sourceKeys.some((key) => opportunityKey === `target:${key}` && key.startsWith('voxel:'))
          : kind === 'verified-response'
            ? materialId !== null && opportunityKey.startsWith('response:')
              && sourceFactIds.includes(opportunityKey.slice('response:'.length))
              && sourceKeys.every((key) => key.startsWith('inventory:') || key.startsWith('voxel:'))
            : materialId !== null && opportunityKey.startsWith('ready-record-carrier:')
              && sourceKeys.some((key) => opportunityKey === `ready-record-carrier:${key}`
                && key.startsWith('inventory:'));
    return valid ? {
      opportunityKey,
      kind,
      materialId,
      currentSourceKey: kind === 'material' ? currentMaterialSourceKey : null,
      sourceKeys,
      sourceFactIds,
    } : null;
  };
  const inventorySourceActor = (sourceKey: string): string | null => {
    const match = /^inventory:([^:]+):.+$/.exec(sourceKey);
    return match?.[1] ?? null;
  };
  const sourceLineageMatches = (
    source: OpportunitySource,
    evidence: Record<string, unknown>,
  ): boolean => {
    const evidenceKeys = stringKeys(evidence.sourceKeys);
    if (source.sourceKeys.some((sourceKey) => evidenceKeys.includes(sourceKey))) return true;
    const evidenceFactIds = new Set(stringKeys(evidence.sourceFactIds));
    return source.sourceFactIds.length > 0
      && source.sourceFactIds.some((eventId) => evidenceFactIds.has(eventId));
  };
  const evidenceUsesOpportunitySource = (
    source: OpportunitySource,
    evidence: Record<string, unknown>,
  ): boolean => {
    if (source.kind === 'knowledge' || source.kind === 'ready-record-carrier') return false;
    const materialIds = Array.isArray(evidence.materialIds)
      ? evidence.materialIds.map(integerValue).filter((value): value is number => value !== null)
      : [];
    if (source.materialId !== null && source.kind !== 'target' && !materialIds.includes(source.materialId)) {
      return false;
    }
    if (source.kind === 'target' && source.materialId !== null
      && integerValue(evidence.targetMaterialId) !== source.materialId) return false;
    const exactSource = source.sourceKeys.some((sourceKey) => stringKeys(evidence.sourceKeys).includes(sourceKey));
    if (source.kind === 'material') {
      if (source.opportunityKey.startsWith('search-source:')) {
        return source.currentSourceKey !== null
          && stringKeys(evidence.sourceKeys).includes(source.currentSourceKey);
      }
      return sourceLineageMatches(source, evidence);
    }
    if (source.kind === 'target') return exactSource;
    return exactSource
      && source.sourceFactIds.some((eventId) => stringKeys(evidence.sourceFactIds).includes(eventId));
  };
  const hasCommitmentReason = (value: unknown): boolean => (
    stringKeys(value).includes('cross-project-renewal-opportunity')
  );
  const techniqueOutputMaterialId = (techniqueId: string): number | null => {
    const numeric = (value: string | undefined): number | null => (
      value && /^\d+$/.test(value) ? Number(value) : null
    );
    const inventoryPrefix = 'technique:combine-inventory:';
    if (techniqueId.startsWith(inventoryPrefix)) {
      const [, output, ...rest] = techniqueId.slice(inventoryPrefix.length).split(':');
      return rest.length === 0 ? numeric(output) : null;
    }
    const parts = techniqueId.split(':');
    if (parts[0] !== 'technique') return null;
    if (parts[1] === 'combine' && parts.length === 5) return numeric(parts[4]);
    if (parts[1] === 'exert' && parts.length === 6) return numeric(parts[5]);
    if (parts[1] === 'expose' && parts.length === 5) return numeric(parts[4]);
    return null;
  };
  const materialSupportsFunction = (desiredFunction: string, materialId: number): boolean => {
    if (desiredFunction === 'insulation') return materialHas(materialId, 'insulating');
    if (desiredFunction === 'safer-hunting') return materialHas(materialId, 'tool');
    if (desiredFunction === 'healing') return (materialDefinition(materialId).consume?.health ?? 0) > 0;
    if (desiredFunction === 'prepared-food') {
      return materialId === Material.CookedFood || materialHas(materialId, 'hot');
    }
    if (desiredFunction === 'durable-record') return materialHas(materialId, 'recordable');
    const exactOutputs = new Map<string, number[]>([
      ['efficient-production', [Material.StoneHoe, Material.WoodTool]],
      ['workshop-production', [Material.Workshop]],
      ['reserve-storage', [Material.Granary]],
      ['reliable-water', [Material.Cistern]],
      ['crop-processing', [Material.Mill]],
      ['community-coordination', [Material.CouncilHearth]],
      ['high-heat-processing', [Material.Kiln]],
      ['brick-firing', [Material.FiredBrick]],
      ['copper-charge', [Material.CopperCharge]],
      ['copper-smelting', [Material.Copper]],
      ['tin-charge', [Material.TinCharge]],
      ['tin-smelting', [Material.Tin]],
      ['bronze-alloying', [Material.Bronze]],
      ['bronze-tooling', [Material.BronzeTool]],
      ['bronze-workshop', [Material.Foundry]],
      ['civic-coordination', [Material.CivicHall]],
      ['iron-workshop', [Material.Smithy]],
      ['iron-charge', [Material.IronCharge]],
      ['iron-reduction', [Material.IronBloom]],
      ['iron-working', [Material.Iron]],
      ['iron-tooling', [Material.IronTool]],
      ['fortified-coordination', [Material.KeepCore]],
    ]);
    return exactOutputs.get(desiredFunction)?.includes(materialId) ?? false;
  };
  const personHasReliableFunctionalTechnique = (
    personId: string,
    desiredFunction: string,
    techniqueId: string,
  ): boolean => {
    const person = records(rawState.people).find((candidate) => candidate.id === personId);
    const fact = records(person?.knowledge).find((candidate) => candidate.id === techniqueId
      && candidate.kind === 'technique'
      && typeof candidate.confidence === 'number'
      && candidate.confidence >= 55);
    const outputMaterialId = techniqueOutputMaterialId(techniqueId);
    return Boolean(fact && outputMaterialId !== null
      && materialSupportsFunction(desiredFunction, outputMaterialId));
  };
  const terminalOpportunityBasis = (project: Record<string, unknown>): Record<string, unknown> | null => (
    objectRecord(project.terminalInquiryOpportunityBasis)
      ?? objectRecord(project.inquiryOpportunityBasis)
  );

  let basisProjects = 0;
  let terminalBasisProjects = 0;
  let renewalProjects = 0;
  let renewalKeys = 0;
  let sourceBasisProjects = 0;
  let renewalCommitmentProjects = 0;
  let renewalCommitmentCoveredKeys = 0;
  const reopenWithoutRenewal = new Set<string>();
  const unresolvedInheritedProjects = new Set<string>();
  const inheritedActorMismatches = new Set<string>();
  const inheritedFunctionMismatches = new Set<string>();
  const inheritedStatusMismatches = new Set<string>();
  const renewalKeyMismatches = new Set<string>();
  const unresolvedSources = new Set<string>();
  const renewalCommitmentActorMismatches = new Set<string>();
  const renewalCommitmentFunctionMismatches = new Set<string>();
  const renewalCommitmentInheritedStatusMismatches = new Set<string>();
  const sourceAuditByProjectIndex = new Map<number, {
    renewalKeys: string[];
    renewalSources: OpportunitySource[];
    coveredRenewalKeys: string[];
  }>();

  for (const { project, projectIndex } of sourceAuditProjects) {
    const projectId = stringValue(project.id) ?? `#${projectIndex}`;
    const basis = objectRecord(project.inquiryOpportunityBasis);
    if (basis) basisProjects += 1;
    const inheritedProjectIds = stringKeys(basis?.inheritedProjectIds);
    const projectRenewalKeys = stringKeys(basis?.renewalKeys);
    const opportunityKeys = new Set(stringKeys(basis?.opportunityKeys));
    const rawOpportunitySources = Array.isArray(basis?.opportunitySources)
      ? basis.opportunitySources
      : null;
    if (basis && rawOpportunitySources) sourceBasisProjects += 1;
    const parsedSources: OpportunitySource[] = [];
    for (const [sourceIndex, value] of (rawOpportunitySources ?? []).entries()) {
      const source = parseOpportunitySource(value, opportunityKeys);
      if (!source) unresolvedSources.add(`${projectId}\u0000source:${sourceIndex}`);
      else parsedSources.push(source);
    }
    const renewalSources = parsedSources.filter((source) => projectRenewalKeys.includes(source.opportunityKey));
    const coveredKeys = projectRenewalKeys.filter((renewalKey) => (
      renewalSources.some((source) => source.opportunityKey === renewalKey)
    ));
    sourceAuditByProjectIndex.set(projectIndex, {
      renewalKeys: projectRenewalKeys,
      renewalSources,
      coveredRenewalKeys: coveredKeys,
    });
    if (projectRenewalKeys.length > 0) {
      renewalProjects += 1;
      renewalKeys += projectRenewalKeys.length;
      renewalCommitmentCoveredKeys += coveredKeys.length;
      if (coveredKeys.length === projectRenewalKeys.length) renewalCommitmentProjects += 1;
      for (const renewalKey of projectRenewalKeys) {
        if (!coveredKeys.includes(renewalKey)) unresolvedSources.add(`${projectId}\u0000renewal:${renewalKey}`);
      }
      if (basis?.actorId !== project.ownerId) renewalCommitmentActorMismatches.add(projectId);
      if (basis?.desiredFunction !== project.desiredFunction) renewalCommitmentFunctionMismatches.add(projectId);
      const campaign = objectRecord(project.hypothesisCampaign);
      if (campaign && campaign.actorId !== project.ownerId) {
        renewalCommitmentActorMismatches.add(`${projectId}\u0000campaign`);
      }
      for (const source of renewalSources) {
        const sourceActor = source.currentSourceKey
          ? inventorySourceActor(source.currentSourceKey)
          : null;
        if (sourceActor && sourceActor !== project.ownerId) {
          renewalCommitmentActorMismatches.add(`${projectId}\u0000${source.currentSourceKey}`);
        }
      }
    }
    for (const renewalKey of projectRenewalKeys) {
      if (!opportunityKeys.has(renewalKey)) renewalKeyMismatches.add(`${projectId}\u0000${renewalKey}`);
    }

    for (const inheritedProjectId of inheritedProjectIds) {
      const referenceKey = `${projectId}\u0000${inheritedProjectId}`;
      const matches = projectEntriesById.get(inheritedProjectId) ?? [];
      if (matches.length !== 1) {
        unresolvedInheritedProjects.add(referenceKey);
        continue;
      }
      const inherited = matches[0].project;
      if (inherited.ownerId !== project.ownerId) {
        inheritedActorMismatches.add(referenceKey);
        if (projectRenewalKeys.length > 0) renewalCommitmentActorMismatches.add(referenceKey);
      }
      if (inherited.desiredFunction !== project.desiredFunction) {
        inheritedFunctionMismatches.add(referenceKey);
        if (projectRenewalKeys.length > 0) renewalCommitmentFunctionMismatches.add(referenceKey);
      }
      if (inherited.status !== 'blocked') {
        inheritedStatusMismatches.add(referenceKey);
        if (projectRenewalKeys.length > 0) renewalCommitmentInheritedStatusMismatches.add(referenceKey);
      }
    }
  }

  // Search exhaustion is shared by production, inquiry, and construction
  // projects. Audit the complete project stream rather than the narrower
  // hypothesis-metric subset above.
  for (const { project, projectIndex } of projects) {
    const projectId = stringValue(project.id) ?? `#${projectIndex}`;
    const basis = objectRecord(project.inquiryOpportunityBasis);
    const inheritedProjectIds = stringKeys(basis?.inheritedProjectIds);
    const createdAtMonth = integerValue(project.createdAtMonth);
    const priorFailures = createdAtMonth === null ? [] : reopenConstraintProjects.filter((prior) => (
      prior.projectIndex < projectIndex
        && prior.project.ownerId === project.ownerId
        && prior.project.desiredFunction === project.desiredFunction
        && integerValue(prior.project.blockedAtMonth) !== null
        && integerValue(prior.project.blockedAtMonth)! <= createdAtMonth
    ));
    const priorSearchCampaigns = priorFailures.flatMap(({ project: prior }) => (
      exhaustedSearchCampaigns(prior)
    ));
    const sourceAudit = sourceAuditByProjectIndex.get(projectIndex);
    const basisIdentityMatches = basis?.actorId === project.ownerId
      && basis?.desiredFunction === project.desiredFunction;
    const priorOpportunityKeys = new Set(priorFailures.flatMap(({ project: prior }) => (
      stringKeys(terminalOpportunityBasis(prior)?.opportunityKeys)
    )));
    const priorSearchMaterialIds = new Set(priorSearchCampaigns.flatMap((campaign) => (
      Array.isArray(campaign.materialIds)
        ? campaign.materialIds.map(integerValue).filter((value): value is number => value !== null)
        : []
    )));
    const priorMaterialSources = priorFailures.flatMap(({ project: prior }) => (
      records(terminalOpportunityBasis(prior)?.opportunitySources).filter((source) => (
        source.kind === 'material' && integerValue(source.materialId) !== null
      ))
    ));
    const priorSearchSourceFactIdsByMaterial = new Map<number, Set<string>>();
    for (const campaign of priorSearchCampaigns) {
      const sourceFactIds = stringKeys(campaign.sourceFactIds);
      for (const materialId of (Array.isArray(campaign.materialIds)
        ? campaign.materialIds.map(integerValue).filter((value): value is number => value !== null)
        : [])) {
        const known = priorSearchSourceFactIdsByMaterial.get(materialId) ?? new Set<string>();
        for (const eventId of sourceFactIds) known.add(eventId);
        priorSearchSourceFactIdsByMaterial.set(materialId, known);
      }
    }
    const priorTerminalSourceFactIds = new Set(priorFailures.flatMap(({ project: prior }) => (
      stringKeys(terminalOpportunityBasis(prior)?.sourceFactIds)
    )));
    const sourceIsNew = (source: OpportunitySource): boolean => {
      const matchesStoredSource = priorMaterialSources.some((prior) => {
        if (integerValue(prior.materialId) !== source.materialId) return false;
        const priorSourceKeys = stringKeys(prior.sourceKeys);
        if (source.sourceKeys.some((sourceKey) => priorSourceKeys.includes(sourceKey))) return true;
        const priorFactIds = new Set(stringKeys(prior.sourceFactIds));
        return source.sourceFactIds.length > 0
          && source.sourceFactIds.some((eventId) => priorFactIds.has(eventId));
      });
      if (matchesStoredSource) return false;
      if (source.materialId === null || !priorSearchMaterialIds.has(source.materialId)) return true;
      const campaignSourceFactIds = priorSearchSourceFactIdsByMaterial.get(source.materialId)
        ?? new Set<string>();
      return !source.sourceFactIds.some((eventId) => (
        campaignSourceFactIds.has(eventId) || priorTerminalSourceFactIds.has(eventId)
      ));
    };
    const priorHypothesisFailures = priorFailures.filter(({ project: prior }) => (
      hasHypothesisAttempts(prior)
    ));
    const sourceActorMatches = (source: OpportunitySource): boolean => {
      if (!source.currentSourceKey) return true;
      const actorId = inventorySourceActor(source.currentSourceKey);
      return actorId === null || actorId === project.ownerId;
    };
    const declaredRenewalIsNew = (source: OpportunitySource): boolean => {
      if (priorFailures.length === 0 || !basisIdentityMatches || !sourceActorMatches(source)
        || typeof project.ownerId !== 'string' || typeof project.desiredFunction !== 'string') return false;
      if (source.opportunityKey.startsWith('search-source:')) {
        return source.kind === 'material'
          && source.materialId !== null
          && priorSearchMaterialIds.has(source.materialId)
          && sourceIsNew(source);
      }
      if (source.kind === 'knowledge' && source.opportunityKey.startsWith('knowledge:')) {
        const techniqueId = source.opportunityKey.slice('knowledge:'.length);
        return !priorOpportunityKeys.has(source.opportunityKey)
          && personHasReliableFunctionalTechnique(
            project.ownerId,
            project.desiredFunction,
            techniqueId,
          );
      }
      return priorHypothesisFailures.length > 0
        && !priorOpportunityKeys.has(source.opportunityKey);
    };
    const hasValidDeclaredRenewal = Boolean(sourceAudit?.renewalSources.some(declaredRenewalIsNew));
    if ((priorFailures.length > 0 || inheritedProjectIds.length > 0) && !hasValidDeclaredRenewal) {
      reopenWithoutRenewal.add(projectId);
    }
  }

  for (const { project } of failedProjects) {
    if (objectRecord(project.terminalInquiryOpportunityBasis)) terminalBasisProjects += 1;
  }

  type RenewalHypothesisProject = (typeof projects)[number] & {
    campaign: Record<string, unknown>;
  };
  const renewalHypothesisProjectsFor = (
    entries: typeof projects,
  ): RenewalHypothesisProject[] => entries.flatMap((entry) => {
    const basis = objectRecord(entry.project.inquiryOpportunityBasis);
    const campaign = objectRecord(entry.project.hypothesisCampaign);
    return campaign && stringKeys(basis?.renewalKeys).length > 0 ? [{ ...entry, campaign }] : [];
  });
  const summarizeRenewalHypothesisScope = (entries: RenewalHypothesisProject[]) => {
    const candidateProjects = entries.filter(({ campaign }) => (
      records(campaign.candidates).some((candidate) => (
        stringKeys(candidate.reasonKeys).includes('cross-project-renewal-opportunity')
      ))
    )).length;
    const attemptProjects = entries.filter(({ campaign }) => (
      records(campaign.attempts).length > 0
    ));
    const firstAttempts = attemptProjects.filter(({ campaign }) => {
      const firstAttempt = records(campaign.attempts)[0];
      const eventId = stringValue(firstAttempt?.eventId);
      const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
      return stringKeys(diff?.projectHypothesisReasonKeys)
        .includes('cross-project-renewal-opportunity');
    }).length;
    return { candidateProjects, attemptProjects, firstAttempts };
  };
  // Preserve the established production/inquiry denominator. Construction
  // renewal hypotheses are reported separately so their new audit cannot hide
  // a regression in the legacy scope.
  const renewalHypothesisProjects = renewalHypothesisProjectsFor(inquiryProjects);
  const constructionRenewalHypothesisProjects = renewalHypothesisProjectsFor(
    projects.filter(({ project }) => project.kind === 'construction'),
  );
  const renewalHypothesisSummary = summarizeRenewalHypothesisScope(renewalHypothesisProjects);
  const constructionRenewalHypothesisSummary = summarizeRenewalHypothesisScope(
    constructionRenewalHypothesisProjects,
  );

  const exactCommitmentCandidate = (
    candidate: Record<string, unknown>,
    sources: OpportunitySource[],
  ): boolean => hasCommitmentReason(candidate.reasonKeys)
    && sources.some((source) => evidenceUsesOpportunitySource(source, candidate));
  const diffEvidence = (diff: Record<string, unknown>): Record<string, unknown> => ({
    materialIds: diff.projectHypothesisMaterialIds,
    targetMaterialId: diff.projectHypothesisTargetMaterialId,
    sourceKeys: diff.projectHypothesisSourceKeys,
    sourceFactIds: diff.projectHypothesisSourceFactIds,
  });
  const exactCommitmentAttempt = (
    campaign: Record<string, unknown>,
    attempt: Record<string, unknown>,
    sources: OpportunitySource[],
  ): boolean => {
    const candidateKey = stringValue(attempt.candidateKey);
    const candidate = records(campaign.candidates).find((item) => stringValue(item.key) === candidateKey);
    const eventId = stringValue(attempt.eventId);
    const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
    if (!candidate || !diff || !hasCommitmentReason(candidate.reasonKeys)
      || !hasCommitmentReason(diff.projectHypothesisReasonKeys)) return false;
    const projected = diffEvidence(diff);
    return sources.some((source) => evidenceUsesOpportunitySource(source, candidate)
      && evidenceUsesOpportunitySource(source, attempt)
      && evidenceUsesOpportunitySource(source, projected));
  };
  const materialOnlyAttribution = (
    evidence: Record<string, unknown>,
    reasonKeys: unknown,
    sources: OpportunitySource[],
  ): boolean => {
    if (!hasCommitmentReason(reasonKeys)) return false;
    const materialIds = Array.isArray(evidence.materialIds)
      ? evidence.materialIds.map(integerValue).filter((value): value is number => value !== null)
      : [];
    const sameMaterial = sources.some((source) => source.kind === 'material'
      && source.materialId !== null && materialIds.includes(source.materialId));
    return sameMaterial && !sources.some((source) => evidenceUsesOpportunitySource(source, evidence));
  };

  const auditExactSourceCommitments = (entries: RenewalHypothesisProject[]) => {
    const exactSourceProjects = entries.filter(({ projectIndex }) => (
      sourceAuditByProjectIndex.get(projectIndex)?.renewalKeys.some((renewalKey) => (
        renewalKey.startsWith('material:')
          || renewalKey.startsWith('search-source:')
          || renewalKey.startsWith('target:')
          || renewalKey.startsWith('response:')
      ))
    ));
    let firstCandidateExactSourceProjects = 0;
    let firstAttemptExactSourceProjects = 0;
    let firstAttemptProjects = 0;
    const fallbackBeforeCommitmentViolations = new Set<string>();
    const materialOnlyCommitmentAttributionViolations = new Set<string>();
    for (const { project, projectIndex, campaign } of exactSourceProjects) {
      const projectId = stringValue(project.id) ?? `#${projectIndex}`;
      const sources = sourceAuditByProjectIndex.get(projectIndex)?.renewalSources
        .filter((source) => source.kind === 'material'
          || source.kind === 'target'
          || source.kind === 'verified-response') ?? [];
      const candidates = records(campaign.candidates);
      const firstCommitmentCandidate = candidates.find((candidate) => hasCommitmentReason(candidate.reasonKeys));
      if (firstCommitmentCandidate && exactCommitmentCandidate(firstCommitmentCandidate, sources)) {
        firstCandidateExactSourceProjects += 1;
      }
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (materialOnlyAttribution(candidate, candidate.reasonKeys, sources)) {
          materialOnlyCommitmentAttributionViolations.add(`${projectId}\u0000candidate:${candidateIndex}`);
        }
      }

      const attempts = records(campaign.attempts);
      if (attempts.length > 0) {
        firstAttemptProjects += 1;
        if (exactCommitmentAttempt(campaign, attempts[0], sources)) {
          firstAttemptExactSourceProjects += 1;
        }
      }
      let commitmentAttempted = false;
      for (const [attemptIndex, attempt] of attempts.entries()) {
        const exactAttempt = exactCommitmentAttempt(campaign, attempt, sources);
        if (!commitmentAttempted && !exactAttempt) {
          fallbackBeforeCommitmentViolations.add(`${projectId}\u0000attempt:${attemptIndex}`);
        }
        if (exactAttempt) commitmentAttempted = true;
        const eventId = stringValue(attempt.eventId);
        const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
        if (materialOnlyAttribution(attempt, diff?.projectHypothesisReasonKeys, sources)
          || (diff && materialOnlyAttribution(
            diffEvidence(diff),
            diff.projectHypothesisReasonKeys,
            sources,
          ))) {
          materialOnlyCommitmentAttributionViolations.add(`${projectId}\u0000attempt:${attemptIndex}`);
        }
      }
    }
    return {
      exactSourceProjects,
      firstCandidateExactSourceProjects,
      firstAttemptExactSourceProjects,
      firstAttemptProjects,
      fallbackBeforeCommitmentViolations,
      materialOnlyCommitmentAttributionViolations,
    };
  };
  const exactSourceCommitmentAudit = auditExactSourceCommitments(renewalHypothesisProjects);
  const constructionExactSourceCommitmentAudit = auditExactSourceCommitments(
    constructionRenewalHypothesisProjects,
  );

  const noResponseCounts = new Map<string, number>();
  for (const { project } of inquiryProjects) {
    const campaign = objectRecord(project.hypothesisCampaign);
    const actorId = stringValue(campaign?.actorId);
    const desiredFunction = stringValue(project.desiredFunction);
    if (!campaign || !actorId || !desiredFunction) continue;
    for (const attempt of records(campaign.attempts)) {
      if (attempt.outcome !== 'no-response') continue;
      const operation = operationValue(attempt.operation);
      const signature = operation ? signatureFor(operation, attempt) : null;
      if (!operation || !signature) continue;
      const key = `${actorId}\u0000${desiredFunction}\u0000${operation}\u0000${signature}`;
      noResponseCounts.set(key, (noResponseCounts.get(key) ?? 0) + 1);
    }
  }
  const reliableNoResponseExcessAttempts = [...noResponseCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 2), 0);

  return {
    inquiryOpportunityBasisProjects: basisProjects,
    inquiryOpportunityBasisCoverage: coverage(basisProjects, sourceAuditProjects.length),
    inquiryOpportunityFailedProjects: failedProjects.length,
    inquiryOpportunityTerminalBasisProjects: terminalBasisProjects,
    inquiryOpportunityTerminalBasisCoverage: coverage(terminalBasisProjects, failedProjects.length),
    inquiryOpportunityRenewalProjects: renewalProjects,
    inquiryOpportunityRenewalKeys: renewalKeys,
    inquiryOpportunityReopenWithoutRenewalViolations: reopenWithoutRenewal.size,
    inquiryOpportunityUnresolvedInheritedProjects: unresolvedInheritedProjects.size,
    inquiryOpportunityInheritedActorMismatches: inheritedActorMismatches.size,
    inquiryOpportunityInheritedFunctionMismatches: inheritedFunctionMismatches.size,
    inquiryOpportunityInheritedStatusMismatches: inheritedStatusMismatches.size,
    inquiryOpportunityRenewalKeyMismatches: renewalKeyMismatches.size,
    hypothesisReliableNoResponseExcessAttempts: reliableNoResponseExcessAttempts,
    inquiryOpportunityRenewalHypothesisProjects: renewalHypothesisProjects.length,
    inquiryOpportunityRenewalHypothesisCandidateCoverage: coverage(
      renewalHypothesisSummary.candidateProjects,
      renewalHypothesisProjects.length,
    ),
    inquiryOpportunityRenewalHypothesisAttemptProjects:
      renewalHypothesisSummary.attemptProjects.length,
    inquiryOpportunityRenewalHypothesisFirstAttemptCoverage: coverage(
      renewalHypothesisSummary.firstAttempts,
      renewalHypothesisSummary.attemptProjects.length,
    ),
    inquiryOpportunityConstructionRenewalHypothesisProjects:
      constructionRenewalHypothesisProjects.length,
    inquiryOpportunityConstructionRenewalHypothesisCandidateCoverage: coverage(
      constructionRenewalHypothesisSummary.candidateProjects,
      constructionRenewalHypothesisProjects.length,
    ),
    inquiryOpportunityConstructionRenewalHypothesisAttemptProjects:
      constructionRenewalHypothesisSummary.attemptProjects.length,
    inquiryOpportunityConstructionRenewalHypothesisFirstAttemptCoverage: coverage(
      constructionRenewalHypothesisSummary.firstAttempts,
      constructionRenewalHypothesisSummary.attemptProjects.length,
    ),
    inquiryOpportunitySourceBasisProjects: sourceBasisProjects,
    inquiryOpportunitySourceBasisCoverage: coverage(sourceBasisProjects, basisProjects),
    inquiryOpportunityRenewalCommitmentProjects: renewalCommitmentProjects,
    inquiryOpportunityRenewalCommitmentProjectCoverage: coverage(
      renewalCommitmentProjects,
      renewalProjects,
    ),
    inquiryOpportunityRenewalCommitmentSourceCoverage: coverage(
      renewalCommitmentCoveredKeys,
      renewalKeys,
    ),
    inquiryOpportunityUnresolvedSources: unresolvedSources.size,
    inquiryOpportunityRenewalCommitmentActorMismatches: renewalCommitmentActorMismatches.size,
    inquiryOpportunityRenewalCommitmentFunctionMismatches: renewalCommitmentFunctionMismatches.size,
    inquiryOpportunityRenewalCommitmentInheritedStatusMismatches:
      renewalCommitmentInheritedStatusMismatches.size,
    inquiryOpportunityRenewalFirstCandidateExactSourceCoverage: coverage(
      exactSourceCommitmentAudit.firstCandidateExactSourceProjects,
      exactSourceCommitmentAudit.exactSourceProjects.length,
    ),
    inquiryOpportunityRenewalFirstAttemptExactSourceCoverage: coverage(
      exactSourceCommitmentAudit.firstAttemptExactSourceProjects,
      exactSourceCommitmentAudit.firstAttemptProjects,
    ),
    inquiryOpportunityRenewalFallbackBeforeCommitmentViolations:
      exactSourceCommitmentAudit.fallbackBeforeCommitmentViolations.size,
    inquiryOpportunityMaterialOnlyCommitmentAttributionViolations:
      exactSourceCommitmentAudit.materialOnlyCommitmentAttributionViolations.size,
    inquiryOpportunityConstructionRenewalFirstCandidateExactSourceCoverage: coverage(
      constructionExactSourceCommitmentAudit.firstCandidateExactSourceProjects,
      constructionExactSourceCommitmentAudit.exactSourceProjects.length,
    ),
    inquiryOpportunityConstructionRenewalFirstAttemptExactSourceCoverage: coverage(
      constructionExactSourceCommitmentAudit.firstAttemptExactSourceProjects,
      constructionExactSourceCommitmentAudit.firstAttemptProjects,
    ),
    inquiryOpportunityConstructionRenewalFallbackBeforeCommitmentViolations:
      constructionExactSourceCommitmentAudit.fallbackBeforeCommitmentViolations.size,
    inquiryOpportunityConstructionMaterialOnlyCommitmentAttributionViolations:
      constructionExactSourceCommitmentAudit.materialOnlyCommitmentAttributionViolations.size,
  };
}
