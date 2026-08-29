import type { WorldRef } from '../../../domain/action';
import {
  inventoryCombinationsForOutput,
  inventoryCombinationRules,
  inventoryCombinationTechniqueId,
  type InventoryCombinationRule,
} from '../../../domain/interaction-rules';
import { materialDefinition, type MaterialId } from '../../../domain/material';
import type { DropState, SimulationState } from '../../../domain/model';
import { lifePlanningStage } from '../../../domain/life-stage';
import {
  isAlive,
  isDehydratedHibernating,
  type ItemStack,
  type PersonState,
} from '../../../domain/person';
import { canPersonPlanToCollectProjectMaterialDrop } from '../../../domain/project-material-request';
import { findCurrentVisibleStoredMaterialAccess } from '../../../domain/stored-food-access';
import {
  dropStep,
  consumableInventoryQuantity,
  isConsumableProjectStack,
  materialDemand,
  nearestDrop,
  reservation,
} from '../project-material-planning';
import { visibleCellsFor } from '../project-perception';
import {
  reliableExposureTechniques,
  type ReliableExposureTechnique,
} from '../project-inquiry';
import type { LocalVoxelTarget } from '../project-spatial-planning';
import type { ProjectStep } from '../project-step';
import { fixedFacilityWorkplace, knownFacilitySite } from '../project-workplace';

export function knownRecipes(
  person: PersonState,
  outputMaterialId: MaterialId,
): Array<{ rule: InventoryCombinationRule; knowledgeId: string }> {
  return inventoryCombinationsForOutput(outputMaterialId).flatMap((rule) => {
    const knowledgeId = inventoryCombinationTechniqueId(rule);
    const knowledge = person.knowledge.find((fact) => fact.kind === 'technique'
      && fact.id === knowledgeId
      && fact.confidence >= 55);
    return knowledge ? [{ rule, knowledgeId, confidence: knowledge.confidence }] : [];
  }).sort((left, right) => {
    const outstandingFor = (rule: InventoryCombinationRule) => rule.inputs.reduce((sum, input) => (
      sum + Math.max(0, input.quantity - consumableInventoryQuantity(person, input.materialId))
    ), 0);
    return outstandingFor(left.rule) - outstandingFor(right.rule)
      || right.confidence - left.confidence
      || left.rule.id.localeCompare(right.rule.id);
  }).map(({ rule, knowledgeId }) => ({ rule, knowledgeId }));
}

export function knownRecipe(
  person: PersonState,
  outputMaterialId: MaterialId,
): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return knownRecipes(person, outputMaterialId)[0] ?? null;
}

export interface KnownOutputAccessOptions {
  preferLocalFinishedOutput?: boolean;
  allowVisibleHolder?: boolean;
  visibleHolderHasContributionRoute?: (holder: PersonState) => boolean;
  visibleHolderCanContribute?: (holder: PersonState) => boolean;
}

/** Match the minimum person-side eligibility of a real project contribution option. */
export function personCanProvideProjectMaterial(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths + 1,
): boolean {
  const stage = lifePlanningStage(person, atMonth);
  return (stage === 'adolescent-worker' || stage === 'adult')
    && isAlive(person)
    && !isDehydratedHibernating(person)
    && !person.conditions.some((condition) => condition.kind === 'restrained');
}

export function visibleProjectMaterialHolders(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
): PersonState[] {
  const visible = new Set(visibleCellsFor(person));
  const visibleRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId)
    && Math.abs(candidate.position.z - person.position.z) <= visibleRadius
    && consumableInventoryQuantity(candidate, outputMaterialId) > 0);
}

function visibleActionableHolder(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
  options: KnownOutputAccessOptions,
): PersonState | undefined {
  if (!options.preferLocalFinishedOutput || !options.allowVisibleHolder) return undefined;
  return visibleProjectMaterialHolders(state, person, outputMaterialId)
    .filter((candidate) => options.visibleHolderHasContributionRoute?.(candidate) ?? true)
    .find((candidate) => options.visibleHolderCanContribute?.(candidate)
      ?? personCanProvideProjectMaterial(state, candidate));
}

function hasVisibleWaitingHolder(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
  options: KnownOutputAccessOptions,
): boolean {
  return Boolean(options.preferLocalFinishedOutput
    && options.allowVisibleHolder
    && visibleProjectMaterialHolders(state, person, outputMaterialId)
      .some((candidate) => options.visibleHolderHasContributionRoute?.(candidate) ?? true));
}

export function localFinishedOutputAccess(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
  options: KnownOutputAccessOptions,
): { kind: 'stored' | 'holder' | 'drop'; sourceFactIds: string[] } | null {
  if (!options.preferLocalFinishedOutput) return null;
  const stored = findCurrentVisibleStoredMaterialAccess(
    state,
    person,
    (stack) => stack.materialId === outputMaterialId && isConsumableProjectStack(stack),
  );
  if (stored) return {
    kind: 'stored',
    sourceFactIds: [...new Set([...stored.container.sourceEventIds, ...stored.stack.sourceEventIds])],
  };

  const visible = new Set(visibleCellsFor(person));
  const holders = options.allowVisibleHolder
    ? visibleProjectMaterialHolders(state, person, outputMaterialId)
      .filter((candidate) => options.visibleHolderHasContributionRoute?.(candidate) ?? true)
    : [];
  if (options.allowVisibleHolder) {
    const holder = visibleActionableHolder(state, person, outputMaterialId, options);
    if (holder) return {
      kind: 'holder',
      sourceFactIds: [...new Set(holder.inventory
        .filter((stack) => stack.materialId === outputMaterialId && isConsumableProjectStack(stack))
        .flatMap((stack) => stack.sourceEventIds))],
    };
  }

  const drop = nearestDrop(
    state,
    person,
    state.world.drops.filter((candidate) => candidate.quantity > 0
      && visible.has(candidate.cellId)
      && canPersonPlanToCollectProjectMaterialDrop(
        state,
        person.id,
        candidate,
        state.clock.elapsedMonths + 1,
      )),
    [outputMaterialId],
  );
  if (drop) return { kind: 'drop', sourceFactIds: [...drop.sourceEventIds] };

  // A visible but temporarily inactive owner still proves that the finished
  // object exists locally. It may keep the project waiting, but it must not
  // hide a directly collectable drop when one is present.
  const waitingHolder = holders[0];
  return waitingHolder ? {
    kind: 'holder',
    sourceFactIds: [...new Set(waitingHolder.inventory
      .filter((stack) => stack.materialId === outputMaterialId && isConsumableProjectStack(stack))
      .flatMap((stack) => stack.sourceEventIds))],
  } : null;
}

export function knownExposurePlan(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
): {
  technique: ReliableExposureTechnique;
  workplace: NonNullable<ReturnType<typeof fixedFacilityWorkplace>>;
} | null {
  for (const technique of reliableExposureTechniques(person)
    .filter((candidate) => candidate.rule.outputMaterialId === outputMaterialId)) {
    const site = knownFacilitySite(state, person, [technique.rule.targetMaterialId]);
    const workplace = site
      ? fixedFacilityWorkplace(state, person, site, [technique.rule.targetMaterialId])
      : null;
    if (workplace) return { technique, workplace };
  }
  return null;
}

export function reliableKnownRecipe(
  person: PersonState,
  outputFits: (materialId: MaterialId) => boolean,
): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  for (const fact of person.knowledge) {
    if (fact.kind !== 'technique' || fact.confidence < 55) continue;
    const rule = inventoryCombinationRules()
      .find((candidate) => inventoryCombinationTechniqueId(candidate) === fact.id);
    if (rule && outputFits(rule.output.materialId)) return { rule, knowledgeId: fact.id };
  }
  return null;
}

function stackRefsForRule(
  person: PersonState,
  rule: InventoryCombinationRule,
): Extract<WorldRef, { kind: 'inventory-stack' }>[] | null {
  const refs: Extract<WorldRef, { kind: 'inventory-stack' }>[] = [];
  for (const input of rule.inputs) {
    const stack = person.inventory.find((candidate) => candidate.materialId === input.materialId
      && isConsumableProjectStack(candidate)
      && candidate.quantity >= input.quantity);
    if (!stack) return null;
    for (let count = 0; count < input.quantity; count += 1) {
      refs.push({ kind: 'inventory-stack', personId: person.id, stackId: stack.id });
    }
  }
  return refs;
}

export function compileKnownOutput(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  outputMaterialId: MaterialId,
  purpose: string,
  accessOptions: KnownOutputAccessOptions = {},
  visited = new Set<MaterialId>(),
): ProjectStep | null {
  if (visited.has(outputMaterialId)) return null;
  visited.add(outputMaterialId);
  // A locally obtainable finished object is already a better causal answer
  // than manufacturing another one. Ordinary logistics owns that route.
  if (localFinishedOutputAccess(state, person, outputMaterialId, accessOptions)) return null;
  const known = knownRecipe(person, outputMaterialId);
  if (known) {
    const knowledge = person.knowledge.find((fact) => fact.id === known.knowledgeId);
    const deficits = known.rule.inputs
      .filter((input) => consumableInventoryQuantity(person, input.materialId) < input.quantity);
    const missing = deficits.map((input) => input.materialId);
    if (missing.length) {
      if (missing.some((materialId) => visibleActionableHolder(
        state,
        person,
        materialId,
        accessOptions,
      ))) return null;
      const drop = nearestDrop(state, person, visibleDrops, missing);
      if (drop) {
        const input = deficits.find((candidate) => candidate.materialId === drop.materialId);
        const demand = materialDemand(
          person,
          drop.materialId,
          input?.quantity ?? 1,
          `known-recipe:${known.rule.id}:${drop.materialId}`,
          knowledge?.sourceEventIds ?? [],
        );
        const step = dropStep(person, drop, purpose, demand);
        if (step) return { ...step, planKnowledgeId: known.knowledgeId, missingMaterialIds: missing };
      }
      if (missing.some((materialId) => hasVisibleWaitingHolder(
        state,
        person,
        materialId,
        accessOptions,
      ))) return null;
      for (const materialId of missing) {
        const nested = compileKnownOutput(
          state,
          person,
          visibleDrops,
          materialId,
          purpose,
          accessOptions,
          new Set(visited),
        );
        if (nested) return { ...nested, missingMaterialIds: missing };
      }
      return null;
    }
    const refs = stackRefsForRule(person, known.rule);
    if (!refs) return null;
    const reservations = refs.flatMap((ref) => reservation(person, ref.stackId));
    return {
      key: `known-recipe-${known.rule.id}`,
      summary: `按已核验经验制作${materialDefinition(outputMaterialId).name}`,
      reason: '本人已经核验这项制作经验，并已持有所有前置材料',
      action: { kind: 'act', operation: 'combine', targets: refs },
      sourceFactIds: [...new Set([
        ...(knowledge?.sourceEventIds ?? []),
        ...refs.flatMap((ref) => (
          person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []
        )),
      ])],
      missingMaterialIds: [],
      reservations,
      planKnowledgeId: known.knowledgeId,
    };
  }

  const exposure = knownExposurePlan(state, person, outputMaterialId);
  if (!exposure) return null;
  const { technique, workplace } = exposure;
  const inputMaterialId = technique.rule.inputMaterialId;
  const subject = person.inventory.find((stack) => stack.materialId === inputMaterialId
    && isConsumableProjectStack(stack));
  if (!subject) {
    if (visibleActionableHolder(
      state,
      person,
      inputMaterialId,
      accessOptions,
    )) return null;
    const drop = nearestDrop(state, person, visibleDrops, [inputMaterialId]);
    if (drop) {
      const demand = materialDemand(
        person,
        inputMaterialId,
        1,
        `known-exposure:${technique.rule.id}:${inputMaterialId}`,
        technique.sourceEventIds,
      );
      const step = dropStep(person, drop, purpose, demand);
      if (step) return {
        ...step,
        planKnowledgeId: technique.knowledgeId,
        missingMaterialIds: [inputMaterialId],
      };
    }
    if (hasVisibleWaitingHolder(state, person, inputMaterialId, accessOptions)) return null;
    const nested = compileKnownOutput(
      state,
      person,
      visibleDrops,
      inputMaterialId,
      purpose,
      accessOptions,
      new Set(visited),
    );
    return nested ? { ...nested, missingMaterialIds: [inputMaterialId] } : null;
  }
  const atWorkplace = person.position.cellId === workplace.workingPosition.cellId
    && person.position.z === workplace.workingPosition.z;
  if (!atWorkplace) return {
    key: `approach-known-exposure-${technique.rule.id}-${workplace.workingPosition.cellId}-${workplace.workingPosition.z}`,
    summary: `把${materialDefinition(inputMaterialId).name}带到已知工位，继续${purpose}`,
    reason: '本人只沿已核验的接触工艺前往当前仍存在、可达且材料匹配的精确工位',
    action: {
      kind: 'move',
      toCellId: workplace.workingPosition.cellId,
      toZ: workplace.workingPosition.z,
    },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([
      ...technique.sourceEventIds,
      ...person.knownPlaces
        .filter((place) => place.materialId === workplace.target.materialId
          && place.position.x === workplace.target.position.x
          && place.position.y === workplace.target.position.y
          && place.position.z === workplace.target.position.z)
        .flatMap((place) => place.sourceEventIds),
      ...subject.sourceEventIds,
    ])],
    missingMaterialIds: [],
    reservations: reservation(person, subject.id),
    planKnowledgeId: technique.knowledgeId,
  };
  return compileKnownExposureStep(person, subject, workplace.target, [outputMaterialId]);
}

export function compileKnownExposureStep(
  person: PersonState,
  subject: ItemStack,
  target: LocalVoxelTarget,
  allowedOutputMaterialIds: readonly MaterialId[],
): ProjectStep | null {
  if (!isConsumableProjectStack(subject)) return null;
  const desiredOutputs = new Set(allowedOutputMaterialIds);
  const technique = reliableExposureTechniques(person).find((candidate) => (
    candidate.rule.inputMaterialId === subject.materialId
      && candidate.rule.targetMaterialId === target.materialId
      && desiredOutputs.has(candidate.rule.outputMaterialId)
  ));
  if (!technique) return null;
  return {
    key: `known-exposure-${technique.rule.id}-${subject.id}`,
    summary: `按已核验经验得到${materialDefinition(technique.rule.outputMaterialId).name}`,
    reason: '本人已经核验这项完整接触经验；当前 subject 与眼前目标都和经验中的实体条件一致',
    action: {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: subject.id },
        { kind: 'voxel', position: target.position },
      ],
    },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([...technique.sourceEventIds, ...subject.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, subject.id),
    planKnowledgeId: technique.knowledgeId,
  };
}
