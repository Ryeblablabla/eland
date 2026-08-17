import {
  Material,
  MATERIAL_PALETTE,
  materialDefinition,
  type MaterialId,
  type MaterialTag,
} from '../domain/material';
import type { ActionFact, DropState } from '../domain/model';
import type { PersonState } from '../domain/person';
import {
  inventoryNoResponseFactId,
  knowsReliableNoResponse,
  voxelNoResponseFactId,
} from '../domain/interaction-knowledge';
import type {
  ProjectHypothesisCampaign,
  ProjectHypothesisCandidate,
  ProjectHypothesisOperation,
  ProjectHypothesisQuestionKind,
  ProjectInquiryOpportunitySource,
  ProjectState,
} from '../domain/project';
import { seededFraction } from '../world/generator';

export const PROJECT_HYPOTHESIS_ATTEMPT_BUDGET = 7;
export const PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET = 4;
export const PROJECT_HYPOTHESIS_RESPONSE_BUDGET = 3;
const MAX_STORED_CANDIDATES_PER_OPERATION = 12;

export interface ProjectHypothesisRequest {
  operation: ProjectHypothesisOperation;
  questionKind?: ProjectHypothesisQuestionKind;
  /** Exert/expose are grounded in an actual voxel selected by the project compiler. */
  targetMaterialId?: MaterialId;
  targetSourceFactIds?: string[];
  targetSourceKeys?: string[];
  /** Exact held entities that created the present project dilemma. */
  subjectSourceKeys?: string[];
}

interface LocalMaterialEvidence {
  materialId: MaterialId;
  quantity: number;
  heldQuantity: number;
  sourceFactIds: string[];
  sourceKeys: string[];
  sourceFactIdsByKey: Record<string, string[]>;
  sourceLineageKeysByKey: Record<string, string[]>;
}

interface RoleScoreBasis {
  score: number;
  reasonKeys: string[];
  sourceFactIds: string[];
  sourceKey?: string;
}

interface VerifiedResponseEntity {
  materialId: MaterialId;
  sourceKey: string;
  sourceFactIds: string[];
}

interface DirectionalRoleExperience {
  toolScore: number;
  inputScore: number;
  reasonKeys: string[];
  sourceFactIds: string[];
}

type NormalizedProjectHypothesisRequest = Omit<ProjectHypothesisRequest, 'questionKind'> & {
  questionKind: ProjectHypothesisQuestionKind;
};

function projectMaterialFocus(project: ProjectState): Array<{
  operation: ProjectHypothesisOperation;
  materials: [MaterialId, MaterialId];
  targetMaterialIds?: MaterialId[];
}> {
  const combine = (...materials: Array<[MaterialId, MaterialId]>) => materials.map((pair) => ({
    operation: 'combine-inventory' as const,
    materials: [...pair].sort((left, right) => left - right) as [MaterialId, MaterialId],
  }));
  if (project.desiredFunction === 'efficient-production') return combine(
    [Material.Wood, Material.Rope], [Material.StoneTool, Material.Plank],
  );
  if (project.desiredFunction === 'workshop-production') return combine([Material.Plank, Material.WoodTablet]);
  if (project.desiredFunction === 'crop-processing') return combine([Material.Stone, Material.Plank]);
  if (project.desiredFunction === 'community-coordination') return combine([Material.Plank, Material.Rope]);
  if (project.desiredFunction === 'high-heat-processing') return combine([Material.Clay, Material.Stone]);
  if (project.desiredFunction === 'copper-charge') return [
    ...combine([Material.CopperOre, Material.Charcoal]),
    { operation: 'expose-local', materials: [Material.Wood, Material.Kiln], targetMaterialIds: [Material.Fire, Material.Kiln, Material.Foundry] },
  ];
  if (project.desiredFunction === 'tin-charge') return [
    ...combine([Material.TinOre, Material.Charcoal]),
    { operation: 'expose-local', materials: [Material.Wood, Material.Kiln], targetMaterialIds: [Material.Fire, Material.Kiln, Material.Foundry] },
  ];
  if (project.desiredFunction === 'bronze-alloying') return combine([Material.Copper, Material.Tin]);
  if (project.desiredFunction === 'bronze-tooling') return combine([Material.Bronze, Material.Wood]);
  if (project.desiredFunction === 'bronze-workshop') return combine([Material.Bronze, Material.Stone]);
  if (project.desiredFunction === 'civic-coordination') return combine([Material.FiredBrick, Material.WoodTablet]);
  if (project.desiredFunction === 'iron-workshop') return combine([Material.Bronze, Material.FiredBrick]);
  if (project.desiredFunction === 'iron-charge') return combine([Material.IronOre, Material.Charcoal]);
  if (project.desiredFunction === 'iron-working') return combine([Material.IronBloom, Material.Charcoal]);
  if (project.desiredFunction === 'iron-tooling') return combine([Material.Iron, Material.Wood]);
  if (project.desiredFunction === 'fortified-coordination') return combine([Material.Iron, Material.FiredBrick]);
  if (project.desiredFunction === 'brick-firing') return [{
    operation: 'expose-local', materials: [Material.Clay, Material.Kiln], targetMaterialIds: [Material.Fire, Material.Kiln, Material.Foundry],
  }];
  if (project.desiredFunction === 'copper-smelting') return [{
    operation: 'expose-local', materials: [Material.CopperCharge, Material.Kiln], targetMaterialIds: [Material.Kiln, Material.Foundry],
  }];
  if (project.desiredFunction === 'tin-smelting') return [{
    operation: 'expose-local', materials: [Material.TinCharge, Material.Kiln], targetMaterialIds: [Material.Kiln, Material.Foundry],
  }];
  if (project.desiredFunction === 'iron-reduction') return [{
    operation: 'expose-local', materials: [Material.IronCharge, Material.Smithy], targetMaterialIds: [Material.Smithy],
  }];
  return [];
}

function candidateMatchesProjectFocus(project: ProjectState, candidate: ProjectHypothesisCandidate): boolean {
  return projectMaterialFocus(project).some((focus) => {
    if (focus.operation !== candidate.operation) return false;
    if (candidate.operation === 'combine-inventory') {
      return focus.materials[0] === candidate.materialIds[0] && focus.materials[1] === candidate.materialIds[1];
    }
    return candidate.inputMaterialId === focus.materials[0]
      && Boolean(candidate.targetMaterialId !== undefined && focus.targetMaterialIds?.includes(candidate.targetMaterialId));
  });
}

function mergeEvidence(
  map: Map<MaterialId, LocalMaterialEvidence>,
  materialId: MaterialId,
  quantity: number,
  sourceFactIds: string[],
  sourceKey: string,
  held: boolean,
  sourceLineageKeys: string[] = [],
): void {
  if (quantity <= 0) return;
  const existing = map.get(materialId) ?? {
    materialId,
    quantity: 0,
    heldQuantity: 0,
    sourceFactIds: [],
    sourceKeys: [],
    sourceFactIdsByKey: {},
    sourceLineageKeysByKey: {},
  };
  existing.quantity += quantity;
  if (held) existing.heldQuantity += quantity;
  existing.sourceFactIds = [...new Set([...existing.sourceFactIds, ...sourceFactIds])];
  existing.sourceKeys = [...new Set([...existing.sourceKeys, sourceKey])];
  existing.sourceFactIdsByKey[sourceKey] = [...new Set([
    ...(existing.sourceFactIdsByKey[sourceKey] ?? []),
    ...sourceFactIds,
  ])];
  existing.sourceLineageKeysByKey[sourceKey] = [...new Set([
    ...(existing.sourceLineageKeysByKey[sourceKey] ?? []),
    ...sourceLineageKeys,
  ])];
  map.set(materialId, existing);
}

function localMaterialEvidence(person: PersonState, visibleDrops: DropState[]): LocalMaterialEvidence[] {
  const evidence = new Map<MaterialId, LocalMaterialEvidence>();
  for (const stack of person.inventory) {
    mergeEvidence(
      evidence,
      stack.materialId,
      stack.quantity,
      stack.sourceEventIds,
      `inventory:${person.id}:${stack.id}`,
      true,
      stack.sourceLineageKeys ?? [],
    );
  }
  for (const drop of visibleDrops) {
    mergeEvidence(
      evidence,
      drop.materialId,
      drop.quantity,
      drop.sourceEventIds,
      `drop:${drop.id}`,
      false,
      drop.sourceLineageKeys ?? [],
    );
  }
  return [...evidence.values()].sort((left, right) => left.materialId - right.materialId);
}

function hasTag(materialId: MaterialId, tag: MaterialTag): boolean {
  return materialDefinition(materialId).tags.includes(tag);
}

function addReason(reasons: string[], condition: boolean, key: string): number {
  if (!condition) return 0;
  reasons.push(key);
  return 1;
}

function rounded(score: number): number {
  return Math.round(score * 100) / 100;
}

function ensureAggregateNoFitReason(reasons: string[], score: number): void {
  if (score !== 0 || reasons.some((reason) => reason.startsWith('role-') && reason.endsWith('-no-observed-fit'))) return;
  reasons.push('role-aggregate-no-observed-fit');
}

function questionKindFor(
  project: ProjectState,
  operation: ProjectHypothesisOperation,
): ProjectHypothesisQuestionKind {
  if (operation === 'expose-local') return 'transform-subject-with-observed-heat';
  if (operation === 'exert-air') return project.desiredFunction === 'prepared-food'
    ? 'seek-local-heat'
    : 'shape-portable-surface';
  return project.desiredFunction === 'insulation' || project.desiredFunction === 'healing'
    ? 'connect-flexible-layers'
    : 'connect-manipulator-shapes';
}

function questionSourceFactIds(project: ProjectState): string[] {
  return [...new Set([
    ...project.triggerFactIds,
    ...(project.pressureBasis?.sourceFactIds ?? []),
  ])];
}

function questionSourceKey(project: ProjectState, questionKind: ProjectHypothesisQuestionKind): string {
  return `project-question:${project.id}:${questionKind}`;
}

const REGISTERED_MATERIAL_IDS = new Set(MATERIAL_PALETTE.map((material) => material.id));

function exactMaterialIds(factId: string, pattern: RegExp): number[] | null {
  const match = factId.match(pattern);
  if (!match) return null;
  const values = match.slice(1).map((part) => (/^(?:0|[1-9]\d*)$/.test(part) ? Number(part) : Number.NaN));
  return values.every((value) => Number.isSafeInteger(value) && REGISTERED_MATERIAL_IDS.has(value))
    ? values
    : null;
}

function exertTechniqueDirection(factId: string): [MaterialId, MaterialId, MaterialId] | null {
  const values = exactMaterialIds(factId, /^technique:exert:(\d+):(\d+):(\d+):(\d+)$/);
  return values ? [values[0], values[1], values[2]] : null;
}

function exertNoResponseDirection(factId: string): [MaterialId, MaterialId, MaterialId] | null {
  const values = exactMaterialIds(factId, /^observation:no-response:exert:(\d+):(\d+):(\d+)$/);
  return values ? [values[0], values[1], values[2]] : null;
}

function exposeTechniqueDirection(factId: string): [MaterialId, MaterialId] | null {
  const values = exactMaterialIds(factId, /^technique:expose:(\d+):(\d+):(\d+)$/);
  return values ? [values[0], values[1]] : null;
}

function exposeNoResponseDirection(factId: string): [MaterialId, MaterialId] | null {
  const values = exactMaterialIds(factId, /^observation:no-response:expose:(\d+):(\d+)$/);
  return values ? [values[0], values[1]] : null;
}

function sourceFactIdsFor(evidence: LocalMaterialEvidence, sourceKey: string | undefined): string[] {
  return sourceKey ? evidence.sourceFactIdsByKey[sourceKey] ?? [] : [];
}

function sourceLineageKeysFor(evidence: LocalMaterialEvidence, sourceKey: string | undefined): string[] {
  return sourceKey ? evidence.sourceLineageKeysByKey[sourceKey] ?? [] : [];
}

function availableSourceKeys(evidence: LocalMaterialEvidence, heldOnly: boolean): string[] {
  return evidence.sourceKeys
    .filter((key) => !heldOnly || key.startsWith('inventory:'))
    .sort((left, right) => {
      const leftHeld = left.startsWith('inventory:');
      const rightHeld = right.startsWith('inventory:');
      if (leftHeld !== rightHeld) return leftHeld ? -1 : 1;
      return left.localeCompare(right);
    });
}

function selectedSourceKey(
  evidence: LocalMaterialEvidence,
  heldOnly: boolean,
  preferredKeys: readonly string[] = [],
): string | undefined {
  const available = availableSourceKeys(evidence, heldOnly);
  const availableSet = new Set(available);
  return preferredKeys.find((key) => availableSet.has(key)) ?? available[0];
}

/**
 * Reads only the input/role side of a person's own facts. Technique output
 * segments are deliberately ignored, so this cannot reconstruct a recipe.
 */
function directionalRoleExperience(
  person: PersonState,
  operation: 'exert-air' | 'expose-local',
  toolMaterialId: MaterialId | undefined,
  inputMaterialId: MaterialId,
  targetMaterialId?: MaterialId,
): DirectionalRoleExperience {
  let toolScore = 0;
  let inputScore = 0;
  const reasonKeys: string[] = [];
  const sourceFactIds: string[] = [];
  for (const fact of person.knowledge) {
    if (operation === 'exert-air') {
      const response = fact.kind === 'technique'
        ? exertTechniqueDirection(fact.id)
        : null;
      if (response) {
        const [knownTool, knownInput, knownTarget] = response;
        const contextMatches = targetMaterialId === undefined || knownTarget === targetMaterialId;
        if (contextMatches && knownTool === toolMaterialId) {
          toolScore += fact.confidence >= 55 ? 2 : 1;
          reasonKeys.push(fact.confidence >= 55 ? 'personal-verified-tool-response' : 'personal-tentative-tool-response');
          sourceFactIds.push(...fact.sourceEventIds);
        }
        if (contextMatches && knownInput === inputMaterialId) {
          inputScore += fact.confidence >= 55 ? 2 : 1;
          reasonKeys.push(fact.confidence >= 55 ? 'personal-verified-input-response' : 'personal-tentative-input-response');
          sourceFactIds.push(...fact.sourceEventIds);
        }
        continue;
      }
      const noResponse = fact.kind === 'observation'
        ? exertNoResponseDirection(fact.id)
        : null;
      if (!noResponse) continue;
      const [knownTool, knownInput, knownTarget] = noResponse;
      if (targetMaterialId !== undefined && knownTarget !== targetMaterialId) continue;
      const repetitions = Math.min(3, Math.max(1, fact.sourceEventIds.length));
      if (knownTool === toolMaterialId) {
        toolScore -= repetitions * 1.25;
        reasonKeys.push('personal-tool-role-no-response');
        sourceFactIds.push(...fact.sourceEventIds);
      }
      if (knownInput === inputMaterialId) {
        inputScore -= repetitions * 1.25;
        reasonKeys.push('personal-input-role-no-response');
        sourceFactIds.push(...fact.sourceEventIds);
      }
      continue;
    }

    const response = fact.kind === 'technique'
      ? exposeTechniqueDirection(fact.id)
      : null;
    if (response) {
      const [knownInput, knownTarget] = response;
      if (knownInput === inputMaterialId
        && (targetMaterialId === undefined || knownTarget === targetMaterialId)) {
        inputScore += fact.confidence >= 55 ? 2 : 1;
        reasonKeys.push(fact.confidence >= 55 ? 'personal-verified-input-response' : 'personal-tentative-input-response');
        sourceFactIds.push(...fact.sourceEventIds);
      }
      continue;
    }
    const noResponse = fact.kind === 'observation'
      ? exposeNoResponseDirection(fact.id)
      : null;
    if (!noResponse) continue;
    const [knownInput, knownTarget] = noResponse;
    if (knownInput !== inputMaterialId
      || (targetMaterialId !== undefined && knownTarget !== targetMaterialId)) continue;
    const repetitions = Math.min(3, Math.max(1, fact.sourceEventIds.length));
    inputScore -= repetitions * 1.25;
    reasonKeys.push('personal-exact-direction-no-response');
    sourceFactIds.push(...fact.sourceEventIds);
  }
  return {
    toolScore: rounded(toolScore),
    inputScore: rounded(inputScore),
    reasonKeys: [...new Set(reasonKeys)],
    sourceFactIds: [...new Set(sourceFactIds)],
  };
}

function verifiedResponseEvidence(campaign: ProjectHypothesisCampaign): Map<string, VerifiedResponseEntity> {
  const evidence = new Map<string, VerifiedResponseEntity>();
  for (const attempt of campaign.attempts) {
    if (attempt.outcome !== 'response' || !attempt.verifiedEventId || attempt.outputMaterialId === undefined
      || !attempt.responseRef) continue;
    const sourceKey = attempt.responseRef.kind === 'inventory-stack'
      ? `inventory:${campaign.actorId}:${attempt.responseRef.stackId}`
      : `voxel:${attempt.responseRef.position.x}:${attempt.responseRef.position.y}:${attempt.responseRef.position.z}:${attempt.responseRef.materialId}`;
    evidence.set(sourceKey, {
      materialId: attempt.outputMaterialId,
      sourceKey,
      sourceFactIds: [attempt.eventId, attempt.verifiedEventId],
    });
  }
  return evidence;
}

function toolRoleBasis(
  person: PersonState,
  evidence: LocalMaterialEvidence,
  inputMaterialId: MaterialId,
  targetMaterialId: MaterialId | undefined,
  verifiedResponses: ReadonlyMap<string, VerifiedResponseEntity>,
  heldOnly = true,
  preferredSourceKeys: readonly string[] = [],
): RoleScoreBasis {
  const materialId = evidence.materialId;
  const material = materialDefinition(materialId);
  const reasons: string[] = [];
  const exactVerifiedKeys = [...verifiedResponses]
    .filter(([, response]) => response.materialId === materialId)
    .map(([sourceKey]) => sourceKey);
  const sourceKey = selectedSourceKey(evidence, heldOnly, [...preferredSourceKeys, ...exactVerifiedKeys]);
  const verified = sourceKey ? verifiedResponses.get(sourceKey) : undefined;
  let score = material.hardness * 0.75;
  if (material.hardness >= 3) reasons.push('role-tool-hardness');
  score += addReason(reasons, material.phase === 'solid' && hasTag(materialId, 'solid'), 'role-tool-solid') * 3;
  score += addReason(reasons, material.mass <= 1.5, 'role-tool-portable') * 4;
  score -= addReason(reasons, material.mass > 1.5, 'role-tool-heavy') * 2;
  const experience = directionalRoleExperience(person, 'exert-air', materialId, inputMaterialId, targetMaterialId);
  score += experience.toolScore;
  if (verified && material.mass <= 1.5 && material.hardness >= 5) {
    score += 3;
    reasons.push('exact-verified-response-as-tool');
  }
  return {
    score: rounded(score),
    reasonKeys: [...new Set([...reasons, ...experience.reasonKeys.filter((key) => key.includes('tool'))])],
    sourceFactIds: [...new Set([
      ...sourceFactIdsFor(evidence, sourceKey),
      ...experience.sourceFactIds,
      ...(verified?.sourceFactIds ?? []),
    ])],
    ...(sourceKey ? { sourceKey } : {}),
  };
}

function inputRoleBasis(
  person: PersonState,
  questionKind: ProjectHypothesisQuestionKind,
  evidence: LocalMaterialEvidence,
  toolMaterialId: MaterialId | undefined,
  targetMaterialId: MaterialId | undefined,
  verifiedResponses: ReadonlyMap<string, VerifiedResponseEntity>,
  subjectSourceKeys: ReadonlySet<string> = new Set(),
  preferredSourceKeys: readonly string[] = [],
): RoleScoreBasis {
  const materialId = evidence.materialId;
  const material = materialDefinition(materialId);
  const reasons: string[] = [];
  const exactVerifiedKeys = [...verifiedResponses]
    .filter(([, response]) => response.materialId === materialId)
    .map(([sourceKey]) => sourceKey);
  const preferredKeys = [...preferredSourceKeys, ...subjectSourceKeys, ...exactVerifiedKeys];
  const sourceKey = selectedSourceKey(evidence, false, preferredKeys);
  const verified = sourceKey ? verifiedResponses.get(sourceKey) : undefined;
  let score = 0;
  if (questionKind === 'seek-local-heat') {
    score += addReason(reasons, hasTag(materialId, 'fiber'), 'role-input-fiber-shape') * 5;
    score += addReason(reasons, hasTag(materialId, 'plant'), 'role-input-plant-shape') * 3;
    score += addReason(reasons, material.mass <= 0.5, 'role-input-light') * 2;
    score += addReason(reasons, material.hardness <= 2, 'role-input-soft') * 2;
    score += addReason(reasons, material.phase === 'solid', 'role-input-solid-phase') * 1;
    score -= addReason(reasons, material.hardness >= 7, 'role-input-very-hard-penalty') * 2;
  } else if (questionKind === 'shape-portable-surface') {
    score += addReason(reasons, material.phase === 'solid' && hasTag(materialId, 'solid'), 'role-surface-solid') * 4;
    score += addReason(reasons, material.mass <= 1.5, 'role-surface-portable') * 3;
    score += addReason(reasons, material.hardness >= 2 && material.hardness <= 5, 'role-surface-middle-hardness') * 4;
    score -= addReason(reasons, material.hardness >= 7, 'role-surface-very-hard-penalty') * 2;
  } else if (questionKind === 'connect-manipulator-shapes') {
    score += addReason(reasons, material.phase === 'solid' && hasTag(materialId, 'solid'), 'role-input-solid-shape') * 3;
    score += addReason(reasons, material.mass <= 1.5, 'role-input-portable-shape') * 3;
    score += addReason(reasons, material.hardness >= 2 && material.hardness <= 5, 'role-input-middle-hardness') * 3;
    score += addReason(reasons, hasTag(materialId, 'fiber') || hasTag(materialId, 'plant'), 'role-input-bindable-shape') * 2;
    score += addReason(reasons, material.mass <= 0.5, 'role-input-light-shape');
  } else if (questionKind === 'connect-flexible-layers') {
    score += addReason(reasons, hasTag(materialId, 'fiber'), 'role-input-flexible-layer') * 4;
    score += addReason(reasons, hasTag(materialId, 'plant'), 'role-input-plant-layer') * 2;
    score += addReason(reasons, material.hardness <= 2, 'role-input-soft-layer') * 2;
    score += addReason(reasons, material.mass <= 0.5, 'role-input-light-layer') * 2;
  } else {
    score += addReason(reasons, sourceKey !== undefined && subjectSourceKeys.has(sourceKey), 'project-source-bound-subject') * 4;
    score += addReason(reasons, material.mass <= 1.5, 'role-input-portable-subject');
  }
  const operation = questionKind === 'transform-subject-with-observed-heat' ? 'expose-local' : 'exert-air';
  const experience = directionalRoleExperience(person, operation, toolMaterialId, materialId, targetMaterialId);
  score += experience.inputScore;
  if (verified) {
    score += 2;
    reasons.push('exact-verified-response-as-input');
  }
  if (reasons.length === 0) reasons.push(questionKind === 'shape-portable-surface'
    ? 'role-surface-no-observed-fit'
    : 'role-input-no-observed-fit');
  return {
    score: rounded(score),
    reasonKeys: [...new Set([...reasons, ...experience.reasonKeys.filter((key) => key.includes('input') || key.includes('exact'))])],
    sourceFactIds: [...new Set([
      ...experience.sourceFactIds,
      ...sourceFactIdsFor(evidence, sourceKey),
      ...(verified?.sourceFactIds ?? []),
    ])],
    ...(sourceKey ? { sourceKey } : {}),
  };
}

/** Uses coarse observable affordances only; it deliberately has no access to interaction rules. */
function flexibleLayerAffordanceScore(materialId: MaterialId, reasons: string[]): number {
  const material = materialDefinition(materialId);
  return (
    addReason(reasons, hasTag(materialId, 'fiber'), 'flexible-fiber') * 6
    + addReason(reasons, hasTag(materialId, 'plant'), 'pliant-plant') * 2
    + addReason(reasons, material.hardness <= 3, 'soft-to-touch') * 2
    + addReason(reasons, material.mass <= 1.1, 'lightweight')
  );
}

function canonicalPair(left: MaterialId, right: MaterialId): [MaterialId, MaterialId] {
  return left <= right ? [left, right] : [right, left];
}

/** Kept as a compatibility helper for v22 observers and tests. */
export function projectHypothesisPairKey(materialIds: readonly [MaterialId, MaterialId]): string {
  return `${materialIds[0]}+${materialIds[1]}`;
}

export function projectHypothesisCandidateKey(
  operation: ProjectHypothesisOperation,
  materialIds: readonly [MaterialId, MaterialId],
  targetMaterialId?: MaterialId,
): string {
  if (operation === 'combine-inventory') return projectHypothesisPairKey(canonicalPair(materialIds[0], materialIds[1]));
  if (operation === 'exert-air') return `exert-air:${materialIds[0]}>${materialIds[1]}@${targetMaterialId ?? materialIds[1]}`;
  return `expose-local:${materialIds[0]}@${targetMaterialId ?? materialIds[1]}`;
}

function pairScore(pair: [MaterialId, MaterialId]): { score: number; reasonKeys: string[] } {
  const reasons: string[] = [];
  const [left, right] = pair;
  let score = flexibleLayerAffordanceScore(left, reasons)
    + flexibleLayerAffordanceScore(right, reasons);
  const leftDefinition = materialDefinition(left);
  const rightDefinition = materialDefinition(right);
  const oneFiber = hasTag(left, 'fiber') || hasTag(right, 'fiber');
  const oneSolid = hasTag(left, 'solid') || hasTag(right, 'solid');
  const onePlant = hasTag(left, 'plant') || hasTag(right, 'plant');
  if (oneFiber && (oneSolid || onePlant)) {
    score += 3;
    reasons.push('binding-complement');
  }
  if (oneSolid && Math.abs(leftDefinition.hardness - rightDefinition.hardness) >= 2) {
    score += 2;
    reasons.push('hard-soft-complement');
  }
  if (Math.abs(leftDefinition.hardness - rightDefinition.hardness) >= 3) {
    score += 2;
    reasons.push('hardness-contrast');
  }
  if (left === right) {
    score += hasTag(left, 'fiber') ? 2 : -2;
    reasons.push('repeatable-same-material');
  } else {
    score += 1;
    reasons.push('different-shapes');
  }
  return { score: rounded(score), reasonKeys: [...new Set(reasons)] };
}

function rankedCandidate(
  seed: number,
  person: PersonState,
  project: ProjectState,
  candidate: Omit<ProjectHypothesisCandidate, 'observableScore' | 'seededRank'>,
  score: number,
): ProjectHypothesisCandidate {
  const perturbation = (seededFraction(
    seed,
    `project-hypothesis:${person.id}:${project.id}:${candidate.key}`,
  ) - 0.5) * 3;
  return {
    ...candidate,
    observableScore: Math.round(score * 100) / 100,
    seededRank: Math.round((score + perturbation) * 100) / 100,
  };
}

function renewalOpportunitySources(project: ProjectState) {
  const basis = project.inquiryOpportunityBasis;
  if (!basis?.renewalKeys.length) return [];
  const renewalKeys = new Set(basis.renewalKeys);
  return (basis.opportunitySources ?? []).filter((source) => renewalKeys.has(source.opportunityKey));
}

function renewalPreferredSourceKeys(project: ProjectState, evidence: LocalMaterialEvidence): string[] {
  const sources = renewalOpportunitySources(project)
    .filter((source) => source.materialId === evidence.materialId
      && (source.kind === 'material' || source.kind === 'verified-response'));
  return evidence.sourceKeys.filter((sourceKey) => sources.some((source) => (
    source.sourceKeys.includes(sourceKey)
      || sourceLineageKeysFor(evidence, sourceKey)
        .some((lineageKey) => source.sourceKeys.includes(lineageKey))
      || (source.sourceFactIds.length > 0 && sourceFactIdsFor(evidence, sourceKey)
        .some((eventId) => source.sourceFactIds.includes(eventId)))
  )));
}

function candidateMatchesRenewalSource(
  source: ProjectInquiryOpportunitySource,
  candidate: ProjectHypothesisCandidate,
  evidence: LocalMaterialEvidence[],
): boolean {
  if (source.kind === 'material') {
    if (source.materialId === undefined || !candidate.materialIds.includes(source.materialId)) return false;
    const materialEvidence = evidence.find((item) => item.materialId === source.materialId);
    return materialEvidence?.sourceKeys.some((sourceKey) => candidate.sourceKeys.includes(sourceKey)
      && (
        source.sourceKeys.includes(sourceKey)
          || sourceLineageKeysFor(materialEvidence, sourceKey)
            .some((lineageKey) => source.sourceKeys.includes(lineageKey))
          || (source.sourceFactIds.length > 0 && sourceFactIdsFor(materialEvidence, sourceKey)
            .some((eventId) => source.sourceFactIds.includes(eventId)))
      )) ?? false;
  }
  if (source.kind === 'target') return source.sourceKeys.some((sourceKey) => candidate.sourceKeys.includes(sourceKey));
  if (source.kind === 'verified-response') return source.sourceKeys.some((sourceKey) => candidate.sourceKeys.includes(sourceKey))
    && source.sourceFactIds.some((eventId) => candidate.sourceFactIds.includes(eventId));
  return false;
}

function matchingRenewalOpportunitySources(
  project: ProjectState,
  candidate: ProjectHypothesisCandidate,
  evidence: LocalMaterialEvidence[],
): ProjectInquiryOpportunitySource[] {
  return renewalOpportunitySources(project)
    .filter((source) => candidateMatchesRenewalSource(source, candidate, evidence));
}

function candidateUsesRenewalOpportunity(
  project: ProjectState,
  candidate: ProjectHypothesisCandidate,
  evidence: LocalMaterialEvidence[],
): boolean {
  const renewalKeys = project.inquiryOpportunityBasis?.renewalKeys ?? [];
  if (!renewalKeys.length) return false;
  const sourced = renewalOpportunitySources(project);
  if (sourced.length) return matchingRenewalOpportunitySources(project, candidate, evidence).length > 0;
  return renewalKeys.some((key) => {
    if (key.startsWith('material:')) {
      const materialId = Number(key.slice('material:'.length));
      return Number.isSafeInteger(materialId) && candidate.materialIds.includes(materialId);
    }
    if (key.startsWith('target:')) return candidate.sourceKeys.includes(key.slice('target:'.length));
    if (key.startsWith('response:')) return candidate.sourceFactIds.includes(key.slice('response:'.length));
    return false;
  });
}

function combineCandidates(
  seed: number,
  person: PersonState,
  project: ProjectState,
  evidence: LocalMaterialEvidence[],
  request: NormalizedProjectHypothesisRequest,
  verifiedResponses: ReadonlyMap<string, VerifiedResponseEntity>,
): ProjectHypothesisCandidate[] {
  const candidates: ProjectHypothesisCandidate[] = [];
  for (let leftIndex = 0; leftIndex < evidence.length; leftIndex += 1) {
    for (let rightIndex = leftIndex; rightIndex < evidence.length; rightIndex += 1) {
      const left = evidence[leftIndex];
      const right = evidence[rightIndex];
      if (left.materialId === right.materialId && left.quantity < 2) continue;
      const pair = canonicalPair(left.materialId, right.materialId);
      const questionSources = questionSourceFactIds(project);
      let toolRoleMaterialId: MaterialId | undefined;
      let inputRoleMaterialId: MaterialId | undefined;
      let toolRoleScore: number | undefined;
      let inputRoleScore: number | undefined;
      let roleScore = 0;
      let roleReasonKeys: string[] = [];
      let roleSourceFactIds: string[] = [];
      let toolSourceKey: string | undefined;
      let inputSourceKey: string | undefined;
      let basisSourceKeys: string[] = [];
      if (request.questionKind === 'connect-flexible-layers') {
        const leftInput = inputRoleBasis(
          person, request.questionKind, left, undefined, undefined, verifiedResponses, new Set(),
          renewalPreferredSourceKeys(project, left),
        );
        const rightInput = inputRoleBasis(
          person, request.questionKind, right, undefined, undefined, verifiedResponses, new Set(),
          renewalPreferredSourceKeys(project, right),
        );
        const scored = pairScore(pair);
        inputRoleMaterialId = leftInput.score >= rightInput.score ? pair[0] : pair[1];
        inputSourceKey = leftInput.score >= rightInput.score ? leftInput.sourceKey : rightInput.sourceKey;
        toolRoleScore = 0;
        inputRoleScore = rounded(leftInput.score + rightInput.score);
        roleScore = rounded(Math.max(scored.score, inputRoleScore));
        roleReasonKeys = [...new Set([
          'role-no-manipulator-required',
          ...scored.reasonKeys,
          ...leftInput.reasonKeys,
          ...rightInput.reasonKeys,
        ])];
        roleSourceFactIds = [...new Set([...leftInput.sourceFactIds, ...rightInput.sourceFactIds])];
        basisSourceKeys = [leftInput.sourceKey, rightInput.sourceKey].filter((key): key is string => Boolean(key));
      } else {
        const leftTool = toolRoleBasis(
          person, left, pair[1], undefined, verifiedResponses, false,
          renewalPreferredSourceKeys(project, left),
        );
        const rightInput = inputRoleBasis(
          person, request.questionKind, right, pair[0], undefined, verifiedResponses, new Set(),
          renewalPreferredSourceKeys(project, right),
        );
        const rightTool = toolRoleBasis(
          person, right, pair[0], undefined, verifiedResponses, false,
          renewalPreferredSourceKeys(project, right),
        );
        const leftInput = inputRoleBasis(
          person, request.questionKind, left, pair[1], undefined, verifiedResponses, new Set(),
          renewalPreferredSourceKeys(project, left),
        );
        const leftDirectionScore = leftTool.score + rightInput.score;
        const rightDirectionScore = rightTool.score + leftInput.score;
        const useLeftAsTool = leftDirectionScore >= rightDirectionScore;
        const selectedTool = useLeftAsTool ? leftTool : rightTool;
        const selectedInput = useLeftAsTool ? rightInput : leftInput;
        toolRoleMaterialId = useLeftAsTool ? pair[0] : pair[1];
        inputRoleMaterialId = useLeftAsTool ? pair[1] : pair[0];
        toolSourceKey = selectedTool.sourceKey;
        inputSourceKey = selectedInput.sourceKey;
        toolRoleScore = selectedTool.score;
        inputRoleScore = selectedInput.score;
        roleScore = selectedTool.score + selectedInput.score;
        roleReasonKeys = [...new Set([...selectedTool.reasonKeys, ...selectedInput.reasonKeys])];
        roleSourceFactIds = [...new Set([...selectedTool.sourceFactIds, ...selectedInput.sourceFactIds])];
        basisSourceKeys = [toolSourceKey, inputSourceKey].filter((key): key is string => Boolean(key));
        const hardnessDifference = materialDefinition(toolRoleMaterialId).hardness
          - materialDefinition(inputRoleMaterialId).hardness;
        if (hardnessDifference >= 2) {
          roleScore += 2;
          roleReasonKeys.push('role-shape-hard-soft-complement');
        }
        if (pair[0] === pair[1]) {
          roleScore -= 8;
          roleReasonKeys.push('role-shape-same-rigid-penalty');
        } else {
          roleScore += 1;
          roleReasonKeys.push('role-shape-different-forms');
        }
        roleScore = rounded(roleScore);
      }
      ensureAggregateNoFitReason(roleReasonKeys, roleScore);
      const reasons = [...new Set(['grounded-operation-question', ...roleReasonKeys])];
      if (roleReasonKeys.some((reason) => reason.startsWith('exact-verified-response-as-'))) {
        reasons.push('verified-response-material');
      }
      const key = projectHypothesisCandidateKey('combine-inventory', pair);
      candidates.push(rankedCandidate(seed, person, project, {
        key,
        operation: 'combine-inventory',
        questionKind: request.questionKind,
        materialIds: pair,
        ...(toolSourceKey ? { toolSourceKey } : {}),
        ...(inputSourceKey ? { inputSourceKey } : {}),
        ...(toolRoleMaterialId === undefined ? {} : { toolRoleMaterialId }),
        ...(inputRoleMaterialId === undefined ? {} : { inputRoleMaterialId }),
        roleScore,
        ...(toolRoleScore === undefined ? {} : { toolRoleScore }),
        ...(inputRoleScore === undefined ? {} : { inputRoleScore }),
        roleReasonKeys: [...new Set(roleReasonKeys)],
        reasonKeys: [...new Set(reasons)],
        sourceFactIds: [...new Set([
          ...questionSources,
          ...roleSourceFactIds,
        ])],
        sourceKeys: [...new Set([
          ...basisSourceKeys,
          questionSourceKey(project, request.questionKind),
        ])],
      }, roleScore));
    }
  }
  return candidates;
}

function exertCandidates(
  seed: number,
  person: PersonState,
  project: ProjectState,
  evidence: LocalMaterialEvidence[],
  request: NormalizedProjectHypothesisRequest,
  verifiedResponses: ReadonlyMap<string, VerifiedResponseEntity>,
): ProjectHypothesisCandidate[] {
  if (request.targetMaterialId === undefined) return [];
  const candidates: ProjectHypothesisCandidate[] = [];
  const tools = evidence.filter((item) => item.heldQuantity > 0
    && materialDefinition(item.materialId).phase === 'solid'
    && materialDefinition(item.materialId).hardness >= 3);
  for (const tool of tools) {
    for (const input of evidence) {
      if (tool.materialId === input.materialId && tool.heldQuantity < 2) continue;
      const toolBasis = toolRoleBasis(
        person,
        tool,
        input.materialId,
        request.targetMaterialId,
        verifiedResponses,
        true,
        renewalPreferredSourceKeys(project, tool),
      );
      const inputBasis = inputRoleBasis(
        person,
        request.questionKind,
        input,
        tool.materialId,
        request.targetMaterialId,
        verifiedResponses,
        new Set(request.subjectSourceKeys ?? []),
        renewalPreferredSourceKeys(project, input),
      );
      const roleReasons = [...new Set([...toolBasis.reasonKeys, ...inputBasis.reasonKeys])];
      let roleScore = toolBasis.score + inputBasis.score;
      if (materialDefinition(tool.materialId).hardness - materialDefinition(input.materialId).hardness >= 2) {
        roleScore += 3;
        roleReasons.push('role-hard-tool-soft-input');
      }
      roleScore = rounded(roleScore);
      ensureAggregateNoFitReason(roleReasons, roleScore);
      const reasons = [...new Set(['grounded-operation-question', 'held-role-tool', 'adjacent-supported-target', ...roleReasons])];
      const materialIds: [MaterialId, MaterialId] = [tool.materialId, input.materialId];
      if (roleReasons.some((reason) => reason.startsWith('exact-verified-response-as-'))) {
        reasons.push('verified-response-material');
      }
      const key = projectHypothesisCandidateKey('exert-air', materialIds, request.targetMaterialId);
      candidates.push(rankedCandidate(seed, person, project, {
        key,
        operation: 'exert-air',
        questionKind: request.questionKind,
        materialIds,
        toolMaterialId: tool.materialId,
        inputMaterialId: input.materialId,
        targetMaterialId: request.targetMaterialId,
        ...(toolBasis.sourceKey ? { toolSourceKey: toolBasis.sourceKey } : {}),
        ...(inputBasis.sourceKey ? { inputSourceKey: inputBasis.sourceKey } : {}),
        toolRoleMaterialId: tool.materialId,
        inputRoleMaterialId: input.materialId,
        ...(request.questionKind === 'shape-portable-surface'
          ? { surfaceRoleMaterialId: input.materialId, surfaceRoleScore: inputBasis.score }
          : {}),
        roleScore,
        toolRoleScore: toolBasis.score,
        inputRoleScore: inputBasis.score,
        roleReasonKeys: [...new Set(roleReasons)],
        reasonKeys: [...new Set(reasons)],
        sourceFactIds: [...new Set([
          ...questionSourceFactIds(project),
          ...toolBasis.sourceFactIds,
          ...inputBasis.sourceFactIds,
          ...(request.targetSourceFactIds ?? []),
        ])],
        sourceKeys: [...new Set([
          ...(toolBasis.sourceKey ? [toolBasis.sourceKey] : []),
          ...(inputBasis.sourceKey ? [inputBasis.sourceKey] : []),
          ...(request.targetSourceKeys ?? []),
          questionSourceKey(project, request.questionKind),
        ])],
      }, roleScore));
    }
  }
  return candidates;
}

function exposeCandidates(
  seed: number,
  person: PersonState,
  project: ProjectState,
  evidence: LocalMaterialEvidence[],
  request: NormalizedProjectHypothesisRequest,
  verifiedResponses: ReadonlyMap<string, VerifiedResponseEntity>,
): ProjectHypothesisCandidate[] {
  if (request.targetMaterialId === undefined) return [];
  return evidence.map((input) => {
    const materialIds: [MaterialId, MaterialId] = [input.materialId, request.targetMaterialId!];
    const inputBasis = inputRoleBasis(
      person,
      request.questionKind,
      input,
      undefined,
      request.targetMaterialId,
      verifiedResponses,
      new Set(request.subjectSourceKeys ?? []),
      renewalPreferredSourceKeys(project, input),
    );
    let roleScore = inputBasis.score;
    const reasons = ['grounded-operation-question', 'observed-local-target', ...inputBasis.reasonKeys];
    const targetVerified = (request.targetSourceKeys ?? [])
      .map((sourceKey) => verifiedResponses.get(sourceKey))
      .find((response) => response?.materialId === request.targetMaterialId);
    if (targetVerified) {
      roleScore += 2;
      reasons.push('verified-response-material', 'exact-verified-response-as-target');
    }
    roleScore = rounded(roleScore);
    const roleReasons = [...inputBasis.reasonKeys];
    ensureAggregateNoFitReason(roleReasons, roleScore);
    const key = projectHypothesisCandidateKey('expose-local', materialIds, request.targetMaterialId);
    return rankedCandidate(seed, person, project, {
      key,
      operation: 'expose-local',
      questionKind: request.questionKind,
      materialIds,
      inputMaterialId: input.materialId,
      targetMaterialId: request.targetMaterialId,
      ...(inputBasis.sourceKey ? { inputSourceKey: inputBasis.sourceKey } : {}),
      inputRoleMaterialId: input.materialId,
      roleScore,
      inputRoleScore: inputBasis.score,
      roleReasonKeys: [...new Set(roleReasons)],
      reasonKeys: [...new Set(reasons)],
      sourceFactIds: [...new Set([
        ...questionSourceFactIds(project),
        ...inputBasis.sourceFactIds,
        ...(targetVerified?.sourceFactIds ?? []),
        ...(request.targetSourceFactIds ?? []),
      ])],
      sourceKeys: [...new Set([
        ...(inputBasis.sourceKey ? [inputBasis.sourceKey] : []),
        ...(request.targetSourceKeys ?? []),
        questionSourceKey(project, request.questionKind),
      ])],
    }, roleScore);
  });
}

function observableCandidates(
  seed: number,
  person: PersonState,
  project: ProjectState,
  evidence: LocalMaterialEvidence[],
  request: NormalizedProjectHypothesisRequest,
  campaign: ProjectHypothesisCampaign,
): ProjectHypothesisCandidate[] {
  const verifiedResponses = verifiedResponseEvidence(campaign);
  const candidates = request.operation === 'combine-inventory'
    ? combineCandidates(seed, person, project, evidence, request, verifiedResponses)
    : request.operation === 'exert-air'
      ? exertCandidates(seed, person, project, evidence, request, verifiedResponses)
      : exposeCandidates(seed, person, project, evidence, request, verifiedResponses);
  return candidates.map((candidate) => {
    if (!candidateUsesRenewalOpportunity(project, candidate, evidence)) return candidate;
    const matchedSources = matchingRenewalOpportunitySources(project, candidate, evidence);
    return {
      ...candidate,
      reasonKeys: [...new Set([...candidate.reasonKeys, 'cross-project-renewal-opportunity'])],
      sourceFactIds: [...new Set([
        ...candidate.sourceFactIds,
        ...(matchedSources.length
          ? matchedSources.flatMap((source) => source.sourceFactIds)
          : project.inquiryOpportunityBasis?.sourceFactIds ?? []),
      ])],
      sourceKeys: [...new Set([
        ...candidate.sourceKeys,
        ...matchedSources.flatMap((source) => source.sourceKeys),
      ])],
    };
  }).map((candidate) => candidateMatchesProjectFocus(project, candidate) ? {
    ...candidate,
    seededRank: candidate.seededRank + 100,
    reasonKeys: [...new Set([...candidate.reasonKeys, 'project-material-focus'])],
  } : candidate).sort((left, right) => right.seededRank - left.seededRank
    || right.observableScore - left.observableScore
    || left.key.localeCompare(right.key));
}

function candidateGrounded(candidate: ProjectHypothesisCandidate, evidence: LocalMaterialEvidence[]): boolean {
  const quantities = new Map(evidence.map((item) => [item.materialId, item.quantity]));
  const held = new Map(evidence.map((item) => [item.materialId, item.heldQuantity]));
  const sourceKeys = new Set(evidence.flatMap((item) => item.sourceKeys));
  if (candidate.reasonKeys.includes('verified-response-material')) {
    if (candidate.roleReasonKeys.includes('exact-verified-response-as-tool')
      && (!candidate.toolSourceKey || !sourceKeys.has(candidate.toolSourceKey))) return false;
    if (candidate.roleReasonKeys.includes('exact-verified-response-as-input')
      && (!candidate.inputSourceKey || !sourceKeys.has(candidate.inputSourceKey))) return false;
  }
  if (candidate.operation === 'combine-inventory') return candidate.materialIds[0] === candidate.materialIds[1]
    ? (quantities.get(candidate.materialIds[0]) ?? 0) >= 2
    : candidate.materialIds.every((materialId) => (quantities.get(materialId) ?? 0) >= 1);
  if (candidate.operation === 'exert-air') {
    const toolMaterialId = candidate.toolMaterialId ?? candidate.materialIds[0];
    const inputMaterialId = candidate.inputMaterialId ?? candidate.materialIds[1];
    if ((held.get(toolMaterialId) ?? 0) < 1 || (quantities.get(inputMaterialId) ?? 0) < 1) return false;
    return toolMaterialId !== inputMaterialId || (held.get(toolMaterialId) ?? 0) >= 2;
  }
  return (quantities.get(candidate.inputMaterialId ?? candidate.materialIds[0]) ?? 0) >= 1;
}

function combineTechniqueInputs(factId: string): [MaterialId, MaterialId] | null {
  const match = factId.match(/^technique:combine-inventory:((?:\d+x\d+)(?:\+\d+x\d+)*):(\d+)$/);
  if (!match) return null;
  const output = /^(?:0|[1-9]\d*)$/.test(match[2]) ? Number(match[2]) : Number.NaN;
  if (!Number.isSafeInteger(output) || !REGISTERED_MATERIAL_IDS.has(output)) return null;
  const counts = new Map<MaterialId, number>();
  for (const part of match[1].split('+')) {
    const input = part.match(/^(\d+)x([1-9]\d*)$/);
    if (!input) return null;
    const materialId = Number(input[1]);
    const quantity = Number(input[2]);
    if (!Number.isSafeInteger(materialId) || !REGISTERED_MATERIAL_IDS.has(materialId)
      || !Number.isSafeInteger(quantity) || quantity > 2) return null;
    counts.set(materialId, (counts.get(materialId) ?? 0) + quantity);
  }
  if ([...counts.values()].reduce((sum, quantity) => sum + quantity, 0) !== 2) return null;
  const canonical = [...counts]
    .sort(([left], [right]) => left - right)
    .map(([materialId, quantity]) => `${materialId}x${quantity}`)
    .join('+');
  if (canonical !== match[1]) return null;
  const materialIds: MaterialId[] = [];
  for (const [materialId, quantity] of counts) {
    materialIds.push(materialId);
    if (quantity === 2) materialIds.push(materialId);
  }
  materialIds.sort((left, right) => left - right);
  return [materialIds[0], materialIds[1]];
}

function reliableKnowledgeForCandidate(person: PersonState, candidate: ProjectHypothesisCandidate): string | null {
  for (const fact of person.knowledge) {
    if (fact.confidence < 55 || fact.kind !== 'technique') continue;
    if (candidate.operation === 'combine-inventory') {
      const materialIds = combineTechniqueInputs(fact.id);
      if (materialIds && projectHypothesisPairKey(materialIds) === candidate.key) return fact.id;
    }
    if (candidate.operation === 'exert-air') {
      const direction = exertTechniqueDirection(fact.id);
      if (!direction) continue;
      const [tool, input, target] = direction;
      if (tool === candidate.toolMaterialId
        && input === candidate.inputMaterialId
        && target === candidate.targetMaterialId) return fact.id;
    }
    if (candidate.operation === 'expose-local') {
      const direction = exposeTechniqueDirection(fact.id);
      if (!direction) continue;
      const [input, target] = direction;
      if (input === candidate.inputMaterialId && target === candidate.targetMaterialId) return fact.id;
    }
  }
  return null;
}

function noResponseFactId(candidate: ProjectHypothesisCandidate): string {
  if (candidate.operation === 'combine-inventory') return inventoryNoResponseFactId([...candidate.materialIds]);
  if (candidate.operation === 'exert-air') return voxelNoResponseFactId(
    'exert',
    candidate.inputMaterialId ?? candidate.materialIds[1],
    candidate.targetMaterialId ?? candidate.materialIds[1],
    candidate.toolMaterialId ?? candidate.materialIds[0],
  );
  return voxelNoResponseFactId(
    'expose',
    candidate.inputMaterialId ?? candidate.materialIds[0],
    candidate.targetMaterialId ?? candidate.materialIds[1],
  );
}

function limitReason(campaign: ProjectHypothesisCampaign): ProjectHypothesisCampaign['endingReason'] | null {
  const noResponses = campaign.attempts.filter((attempt) => attempt.outcome === 'no-response').length;
  const responses = campaign.attempts.filter((attempt) => attempt.outcome === 'response').length;
  if (noResponses >= (campaign.noResponseBudget ?? PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET)) {
    return 'no-response-budget-exhausted';
  }
  if (responses >= (campaign.responseBudget ?? PROJECT_HYPOTHESIS_RESPONSE_BUDGET)) {
    return 'response-stage-budget-exhausted';
  }
  if (campaign.attempts.length >= campaign.budget) return 'total-attempt-budget-exhausted';
  return null;
}

function exhaustCampaign(campaign: ProjectHypothesisCampaign, atMonth: number): void {
  const reason = limitReason(campaign);
  if (!reason || campaign.status !== 'active') return;
  campaign.status = 'exhausted';
  campaign.endedAt = atMonth;
  campaign.endingReason = reason;
  delete campaign.activeCandidateKey;
}

function normalizedRequest(
  project: ProjectState,
  request?: ProjectHypothesisRequest,
): NormalizedProjectHypothesisRequest {
  const operation = request?.operation ?? 'combine-inventory';
  return {
    ...request,
    operation,
    questionKind: request?.questionKind ?? questionKindFor(project, operation),
  };
}

export function refreshProjectHypothesisCampaign(
  seed: number,
  atMonth: number,
  person: PersonState,
  project: ProjectState,
  visibleDrops: DropState[],
  requestInput?: ProjectHypothesisRequest,
): ProjectHypothesisCampaign {
  const request = normalizedRequest(project, requestInput);
  const evidence = localMaterialEvidence(person, visibleDrops);
  const campaign = project.hypothesisCampaign ?? {
    version: 'project-hypothesis-campaign-v2' as const,
    id: `project-hypothesis:${project.id}:${person.id}`,
    projectId: project.id,
    actorId: person.id,
    openedAt: atMonth,
    budget: PROJECT_HYPOTHESIS_ATTEMPT_BUDGET,
    noResponseBudget: PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET,
    responseBudget: PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
    observedMaterialIds: [],
    sourceFactIds: [],
    sourceKeys: [],
    candidates: [],
    attempts: [],
    status: 'active' as const,
  };
  project.hypothesisCampaign = campaign;
  if (campaign.version === 'project-hypothesis-campaign-v1') {
    campaign.version = 'project-hypothesis-campaign-v2';
    if (campaign.status === 'active') campaign.budget = Math.max(campaign.budget, PROJECT_HYPOTHESIS_ATTEMPT_BUDGET);
  }
  campaign.noResponseBudget ??= PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET;
  campaign.responseBudget ??= PROJECT_HYPOTHESIS_RESPONSE_BUDGET;
  if (campaign.status !== 'active') return campaign;
  campaign.observedMaterialIds = [...new Set([
    ...campaign.observedMaterialIds,
    ...evidence.map((item) => item.materialId),
  ])].sort((left, right) => left - right);
  campaign.sourceFactIds = [...new Set([
    ...campaign.sourceFactIds,
    ...evidence.flatMap((item) => item.sourceFactIds),
    ...(request.targetSourceFactIds ?? []),
  ])];
  campaign.sourceKeys = [...new Set([
    ...campaign.sourceKeys,
    ...evidence.flatMap((item) => item.sourceKeys),
    ...(request.targetSourceKeys ?? []),
  ])];
  const generated = observableCandidates(seed, person, project, evidence, request, campaign);
  const preservedKeys = new Set([
    ...campaign.attempts.map((attempt) => attempt.candidateKey),
    ...(campaign.activeCandidateKey ? [campaign.activeCandidateKey] : []),
  ]);
  const merged = new Map(campaign.candidates.map((candidate) => [candidate.key, candidate]));
  for (const candidate of generated) {
    const existing = merged.get(candidate.key);
    merged.set(candidate.key, existing && preservedKeys.has(candidate.key) ? existing : candidate);
  }
  const sorted = [...merged.values()].sort((left, right) => right.seededRank - left.seededRank
    || right.observableScore - left.observableScore
    || left.key.localeCompare(right.key));
  campaign.candidates = [...new Set(sorted.map((candidate) => candidate.operation))].flatMap((operation) => {
    const candidates = sorted.filter((candidate) => candidate.operation === operation);
    return [
      ...candidates.filter((candidate) => preservedKeys.has(candidate.key)),
      ...candidates.filter((candidate) => !preservedKeys.has(candidate.key)),
    ].filter((candidate, index, all) => all.findIndex((item) => item.key === candidate.key) === index)
      .slice(0, Math.max(
        MAX_STORED_CANDIDATES_PER_OPERATION,
        candidates.filter((candidate) => preservedKeys.has(candidate.key)).length,
      ));
  });
  exhaustCampaign(campaign, atMonth);
  return campaign;
}

export function nextProjectHypothesisCandidate(
  seed: number,
  atMonth: number,
  person: PersonState,
  project: ProjectState,
  visibleDrops: DropState[],
  requestInput?: ProjectHypothesisRequest,
): ProjectHypothesisCandidate | null {
  const request = normalizedRequest(project, requestInput);
  const campaign = refreshProjectHypothesisCampaign(seed, atMonth, person, project, visibleDrops, request);
  if (campaign.status !== 'active') return null;
  const evidence = localMaterialEvidence(person, visibleDrops);
  const attempted = new Set(campaign.attempts.map((attempt) => attempt.candidateKey));
  const allowed = (candidate: ProjectHypothesisCandidate) => candidate.operation === request.operation
    && !attempted.has(candidate.key)
    && !knowsReliableNoResponse(person, noResponseFactId(candidate))
    && reliableKnowledgeForCandidate(person, candidate) === null
    && candidateGrounded(candidate, evidence);
  const renewalAttempted = campaign.attempts.some((attempt) => {
    const attemptedCandidate = campaign.candidates.find((candidate) => candidate.key === attempt.candidateKey);
    return Boolean(attemptedCandidate?.reasonKeys.includes('cross-project-renewal-opportunity'));
  });
  const commitmentPending = renewalOpportunitySources(project).length > 0 && !renewalAttempted;
  const active = campaign.activeCandidateKey
    ? campaign.candidates.find((candidate) => candidate.key === campaign.activeCandidateKey)
    : undefined;
  if (active && allowed(active)
    && (!commitmentPending || active.reasonKeys.includes('cross-project-renewal-opportunity'))) return active;
  delete campaign.activeCandidateKey;
  const selectedRenewal = campaign.candidates.find((candidate) => allowed(candidate)
    && candidate.reasonKeys.includes('cross-project-renewal-opportunity'));
  const selected = selectedRenewal ?? (commitmentPending ? undefined : campaign.candidates.find(allowed));
  if (!selected) return null;
  campaign.activeCandidateKey = selected.key;
  return selected;
}

function factSignature(fact: ActionFact): {
  operation: ProjectHypothesisOperation;
  materialIds: [MaterialId, MaterialId];
  toolMaterialId?: MaterialId;
  inputMaterialId?: MaterialId;
  targetMaterialId?: MaterialId;
} | null {
  if (fact.action.kind !== 'act') return null;
  if (fact.action.operation === 'combine') {
    const materialIds = Array.isArray(fact.diff.inputMaterialIds)
      ? fact.diff.inputMaterialIds.filter((value): value is MaterialId => typeof value === 'number')
      : [];
    if (materialIds.length !== 2) return null;
    return { operation: 'combine-inventory', materialIds: canonicalPair(materialIds[0], materialIds[1]) };
  }
  const inputMaterialId = Number(fact.diff.inputMaterialId);
  const targetMaterialId = Number(fact.diff.targetMaterialId);
  if (!Number.isInteger(inputMaterialId) || !Number.isInteger(targetMaterialId)) return null;
  if (fact.action.operation === 'exert') {
    const toolMaterialId = Number(fact.diff.toolMaterialId);
    if (!Number.isInteger(toolMaterialId)) return null;
    return {
      operation: 'exert-air',
      materialIds: [toolMaterialId, inputMaterialId],
      toolMaterialId,
      inputMaterialId,
      targetMaterialId,
    };
  }
  if (fact.action.operation === 'expose') return {
    operation: 'expose-local',
    materialIds: [inputMaterialId, targetMaterialId],
    inputMaterialId,
    targetMaterialId,
  };
  return null;
}

export function recordProjectHypothesisAttempt(
  project: ProjectState,
  fact: ActionFact,
  person?: PersonState,
): void {
  const campaign = project.hypothesisCampaign;
  if (!campaign || campaign.status !== 'active' || campaign.actorId !== fact.who || !campaign.activeCandidateKey) return;
  const signature = factSignature(fact);
  if (!signature || (fact.status !== 'completed' && fact.status !== 'blocked')) return;
  const candidate = campaign.candidates.find((item) => item.key === campaign.activeCandidateKey);
  if (!candidate || candidate.operation !== signature.operation) return;
  const key = projectHypothesisCandidateKey(signature.operation, signature.materialIds, signature.targetMaterialId);
  if (key !== candidate.key || campaign.attempts.some((attempt) => attempt.candidateKey === candidate.key)) return;
  const outcome = fact.status === 'completed' ? 'response' as const : 'no-response' as const;
  const ordinal = campaign.attempts.length + 1;
  const candidateRank = campaign.candidates.filter((item) => item.operation === candidate.operation)
    .findIndex((item) => item.key === candidate.key) + 1;
  const outputMaterialId = Number(fact.diff.outputMaterialId);
  const technique = outcome === 'response'
    ? person?.knowledge.find((item) => item.kind === 'technique' && item.sourceEventIds.includes(fact.id))
    : undefined;
  const outputStackId = typeof fact.diff.outputStackId === 'string' ? fact.diff.outputStackId : undefined;
  const outputPosition = fact.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const responseRef = outcome === 'response' && Number.isInteger(outputMaterialId)
    ? outputStackId
      ? { kind: 'inventory-stack' as const, stackId: outputStackId, materialId: outputMaterialId }
      : [outputPosition?.x, outputPosition?.y, outputPosition?.z].every((value) => Number.isInteger(value))
        ? {
            kind: 'voxel' as const,
            position: {
              x: Number(outputPosition?.x),
              y: Number(outputPosition?.y),
              z: Number(outputPosition?.z),
            },
            materialId: outputMaterialId,
          }
        : undefined
    : undefined;
  campaign.attempts.push({
    candidateKey: candidate.key,
    operation: candidate.operation,
    questionKind: candidate.questionKind,
    materialIds: [...candidate.materialIds],
    ...(candidate.toolMaterialId === undefined ? {} : { toolMaterialId: candidate.toolMaterialId }),
    ...(candidate.inputMaterialId === undefined ? {} : { inputMaterialId: candidate.inputMaterialId }),
    ...(candidate.targetMaterialId === undefined ? {} : { targetMaterialId: candidate.targetMaterialId }),
    ...(candidate.toolSourceKey ? { toolSourceKey: candidate.toolSourceKey } : {}),
    ...(candidate.inputSourceKey ? { inputSourceKey: candidate.inputSourceKey } : {}),
    ...(candidate.toolRoleMaterialId === undefined ? {} : { toolRoleMaterialId: candidate.toolRoleMaterialId }),
    ...(candidate.inputRoleMaterialId === undefined ? {} : { inputRoleMaterialId: candidate.inputRoleMaterialId }),
    ...(candidate.surfaceRoleMaterialId === undefined
      ? {}
      : { surfaceRoleMaterialId: candidate.surfaceRoleMaterialId }),
    roleScore: candidate.roleScore,
    ...(candidate.toolRoleScore === undefined ? {} : { toolRoleScore: candidate.toolRoleScore }),
    ...(candidate.inputRoleScore === undefined ? {} : { inputRoleScore: candidate.inputRoleScore }),
    ...(candidate.surfaceRoleScore === undefined ? {} : { surfaceRoleScore: candidate.surfaceRoleScore }),
    roleReasonKeys: [...candidate.roleReasonKeys],
    eventId: fact.id,
    atMonth: fact.atMonth,
    ordinal,
    candidateRank,
    outcome,
    ...(Number.isInteger(outputMaterialId) ? { outputMaterialId } : {}),
    ...(technique ? { techniqueId: technique.id } : {}),
    ...(responseRef ? { responseRef } : {}),
    sourceFactIds: [...candidate.sourceFactIds],
    sourceKeys: [...candidate.sourceKeys],
  });
  fact.diff = {
    ...fact.diff,
    projectHypothesisCampaignId: campaign.id,
    projectHypothesisProjectId: project.id,
    projectHypothesisActorId: fact.who,
    projectHypothesisCandidateKey: candidate.key,
    projectHypothesisOperation: candidate.operation,
    projectHypothesisQuestionKind: candidate.questionKind,
    projectHypothesisMaterialIds: [...candidate.materialIds],
    ...(candidate.toolMaterialId === undefined ? {} : { projectHypothesisToolMaterialId: candidate.toolMaterialId }),
    ...(candidate.inputMaterialId === undefined ? {} : { projectHypothesisInputMaterialId: candidate.inputMaterialId }),
    ...(candidate.targetMaterialId === undefined ? {} : { projectHypothesisTargetMaterialId: candidate.targetMaterialId }),
    ...(candidate.toolSourceKey ? { projectHypothesisToolSourceKey: candidate.toolSourceKey } : {}),
    ...(candidate.inputSourceKey ? { projectHypothesisInputSourceKey: candidate.inputSourceKey } : {}),
    ...(candidate.toolRoleMaterialId === undefined
      ? {}
      : { projectHypothesisToolRoleMaterialId: candidate.toolRoleMaterialId }),
    ...(candidate.inputRoleMaterialId === undefined
      ? {}
      : { projectHypothesisInputRoleMaterialId: candidate.inputRoleMaterialId }),
    ...(candidate.surfaceRoleMaterialId === undefined
      ? {}
      : { projectHypothesisSurfaceRoleMaterialId: candidate.surfaceRoleMaterialId }),
    projectHypothesisRoleScore: candidate.roleScore,
    ...(candidate.toolRoleScore === undefined ? {} : { projectHypothesisToolRoleScore: candidate.toolRoleScore }),
    ...(candidate.inputRoleScore === undefined ? {} : { projectHypothesisInputRoleScore: candidate.inputRoleScore }),
    ...(candidate.surfaceRoleScore === undefined
      ? {}
      : { projectHypothesisSurfaceRoleScore: candidate.surfaceRoleScore }),
    projectHypothesisRoleReasonKeys: [...candidate.roleReasonKeys],
    projectHypothesisAttemptOrdinal: ordinal,
    projectHypothesisCandidateRank: candidateRank,
    projectHypothesisBudget: campaign.budget,
    projectHypothesisNoResponseBudget: campaign.noResponseBudget,
    projectHypothesisResponseBudget: campaign.responseBudget,
    projectHypothesisOutcome: outcome,
    ...(technique ? { projectHypothesisTechniqueId: technique.id } : {}),
    ...(responseRef ? { projectHypothesisResponseRef: structuredClone(responseRef) } : {}),
    projectHypothesisObservableScore: candidate.observableScore,
    projectHypothesisSeededRank: candidate.seededRank,
    projectHypothesisReasonKeys: [...candidate.reasonKeys],
    projectHypothesisSourceFactIds: [...candidate.sourceFactIds],
    projectHypothesisSourceKeys: [...candidate.sourceKeys],
    projectHypothesisHadReliableKnowledge: false,
  };
  delete campaign.activeCandidateKey;
  exhaustCampaign(campaign, fact.atMonth);
}

/** A material response opens a later operation stage only after entity-backed verification. */
export function recordProjectHypothesisVerification(
  project: ProjectState,
  person: PersonState | undefined,
  fact: ActionFact,
): void {
  const campaign = project.hypothesisCampaign;
  if (!campaign || !person || fact.who !== campaign.actorId || fact.action.kind !== 'attend'
    || !fact.action.verification) return;
  const request = fact.action.verification;
  const attempt = campaign.attempts.find((candidate) => candidate.outcome === 'response'
    && !candidate.verifiedEventId
    && candidate.eventId === request.sourceEventId
    && candidate.techniqueId === request.techniqueId
    && candidate.outputMaterialId === request.expectedMaterialId);
  if (!attempt) return;
  if (fact.status !== 'completed') {
    attempt.verificationLostAtMonth = fact.atMonth;
    fact.diff = {
      ...fact.diff,
      projectHypothesisVerificationCampaignId: campaign.id,
      projectHypothesisVerificationProjectId: project.id,
      projectHypothesisVerificationLostAttemptEventId: attempt.eventId,
    };
    return;
  }
  if (fact.diff.verifiedTechnique !== true
    || fact.diff.verifiedSourceEventId !== attempt.eventId
    || fact.diff.factId !== attempt.techniqueId) return;
  const knowledge = person.knowledge.find((item) => item.id === attempt.techniqueId && item.confidence >= 55
    && item.sourceEventIds.includes(attempt.eventId));
  if (!knowledge) return;
  attempt.verifiedEventId = fact.id;
  attempt.verifiedAtMonth = fact.atMonth;
  fact.diff = {
    ...fact.diff,
    projectHypothesisVerificationCampaignId: campaign.id,
    projectHypothesisVerificationProjectId: project.id,
    projectHypothesisVerifiedAttemptEventId: attempt.eventId,
    projectHypothesisVerifiedCandidateKey: attempt.candidateKey,
    projectHypothesisVerifiedOperation: attempt.operation,
    projectHypothesisVerifiedOutputMaterialId: attempt.outputMaterialId,
  };
}

export function closeProjectHypothesisCampaign(
  project: ProjectState,
  atMonth: number,
  endingReason: NonNullable<ProjectHypothesisCampaign['endingReason']>,
): void {
  const campaign = project.hypothesisCampaign;
  if (!campaign || campaign.status !== 'active') return;
  campaign.status = endingReason === 'reliable-knowledge' ? 'superseded' : 'closed';
  campaign.endedAt = atMonth;
  campaign.endingReason = endingReason;
  delete campaign.activeCandidateKey;
}
