import type { PrimitiveAction, WorldRef } from './action';
import {
  exposureRuleFor,
  exposureTechniqueId,
  exposureTechniqueSummary,
  exertionRuleFor,
  exertionTechniqueId,
  exertionTechniqueSummary,
  inventoryCombinationFor,
  inventoryCombinationRules,
  inventoryCombinationSummary,
  inventoryCombinationTechniqueId,
  type ExposureRule,
  type ExertionRule,
  type InventoryCombinationRule,
} from './interaction-rules';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import type { SimulationState } from './model';
import type { PersonState } from './person';
import type { ProjectFunction } from './project';
import { cellX, cellY, cellsInRadius, neighbors4, topPosition, voxelAt } from '../world/grid';

type TechniqueRule =
  | { operation: 'combine'; rule: InventoryCombinationRule }
  | { operation: 'exert'; rule: ExertionRule }
  | { operation: 'expose'; rule: ExposureRule };

export interface TechniqueActionDescriptor {
  techniqueId: string;
  summary: string;
  operation: 'combine' | 'exert' | 'expose';
  inputMaterialIds: MaterialId[];
  toolMaterialId?: MaterialId;
  targetMaterialId?: MaterialId;
  outputMaterialId: MaterialId;
  sourceKeys: string[];
  sourceFactIds: string[];
}

export interface CompiledTechniquePractice extends TechniqueActionDescriptor {
  action: Extract<PrimitiveAction, { kind: 'act' }>;
}

function techniqueRule(techniqueId: string): TechniqueRule | null {
  const combination = inventoryCombinationRules()
    .find((candidate) => inventoryCombinationTechniqueId(candidate) === techniqueId);
  if (combination) return { operation: 'combine', rule: combination };

  const exertion = techniqueId.match(/^technique:exert:(\d+):(\d+):(\d+):(\d+)$/);
  if (exertion) {
    const [toolMaterialId, inputMaterialId, targetMaterialId, outputMaterialId] = exertion.slice(1).map(Number);
    const rule = exertionRuleFor(toolMaterialId, inputMaterialId, targetMaterialId);
    if (rule && rule.outputMaterialId === outputMaterialId && exertionTechniqueId(rule) === techniqueId) {
      return { operation: 'exert', rule };
    }
  }

  const exposure = techniqueId.match(/^technique:expose:(\d+):(\d+):(\d+)$/);
  if (exposure) {
    const [inputMaterialId, targetMaterialId, outputMaterialId] = exposure.slice(1).map(Number);
    const rule = exposureRuleFor(inputMaterialId, targetMaterialId);
    if (rule && rule.outputMaterialId === outputMaterialId && exposureTechniqueId(rule) === techniqueId) {
      return { operation: 'expose', rule };
    }
  }
  return null;
}

function outputSupportsFunction(outputMaterialId: MaterialId, desiredFunction: ProjectFunction): boolean {
  if (desiredFunction === 'insulation') return materialHas(outputMaterialId, 'insulating');
  if (desiredFunction === 'safer-hunting') return materialHas(outputMaterialId, 'tool');
  if (desiredFunction === 'healing') return (materialDefinition(outputMaterialId).consume?.health ?? 0) > 0;
  if (desiredFunction === 'prepared-food') return outputMaterialId === Material.CookedFood || materialHas(outputMaterialId, 'hot');
  if (desiredFunction === 'durable-record') return materialHas(outputMaterialId, 'recordable');
  if (desiredFunction === 'efficient-production') return outputMaterialId === Material.WoodTool || outputMaterialId === Material.StoneHoe;
  if (desiredFunction === 'workshop-production') return outputMaterialId === Material.Workshop;
  if (desiredFunction === 'reserve-storage') return outputMaterialId === Material.Granary;
  if (desiredFunction === 'reliable-water') return outputMaterialId === Material.Cistern;
  if (desiredFunction === 'settled-cultivation') return outputMaterialId === Material.CropSprout;
  if (desiredFunction === 'crop-processing') return outputMaterialId === Material.Mill;
  if (desiredFunction === 'community-coordination') return outputMaterialId === Material.CouncilHearth;
  if (desiredFunction === 'high-heat-processing') return outputMaterialId === Material.Kiln;
  if (desiredFunction === 'brick-firing') return outputMaterialId === Material.FiredBrick;
  if (desiredFunction === 'copper-charge') return outputMaterialId === Material.CopperCharge;
  if (desiredFunction === 'copper-smelting') return outputMaterialId === Material.Copper;
  if (desiredFunction === 'tin-charge') return outputMaterialId === Material.TinCharge;
  if (desiredFunction === 'tin-smelting') return outputMaterialId === Material.Tin;
  if (desiredFunction === 'bronze-alloying') return outputMaterialId === Material.Bronze;
  if (desiredFunction === 'bronze-tooling') return outputMaterialId === Material.BronzeTool;
  if (desiredFunction === 'bronze-workshop') return outputMaterialId === Material.Foundry;
  if (desiredFunction === 'civic-coordination') return outputMaterialId === Material.CivicHall;
  if (desiredFunction === 'iron-workshop') return outputMaterialId === Material.Smithy;
  if (desiredFunction === 'iron-charge') return outputMaterialId === Material.IronCharge;
  if (desiredFunction === 'iron-reduction') return outputMaterialId === Material.IronBloom;
  if (desiredFunction === 'iron-working') return outputMaterialId === Material.Iron;
  if (desiredFunction === 'iron-tooling') return outputMaterialId === Material.IronTool;
  if (desiredFunction === 'fortified-coordination') return outputMaterialId === Material.KeepCore;
  return false;
}

export function techniqueSupportsProjectFunction(techniqueId: string, desiredFunction: ProjectFunction): boolean {
  const parsed = techniqueRule(techniqueId);
  if (!parsed) return false;
  const outputMaterialId = parsed.operation === 'combine'
    ? parsed.rule.output.materialId
    : parsed.rule.outputMaterialId;
  return outputSupportsFunction(outputMaterialId, desiredFunction);
}

export function reliableTechniquesForFunction(person: PersonState, desiredFunction: ProjectFunction): string[] {
  return person.knowledge
    .filter((fact) => fact.kind === 'technique'
      && fact.confidence >= 55
      && techniqueSupportsProjectFunction(fact.id, desiredFunction))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
    .map((fact) => fact.id);
}

function inventorySourceKey(person: PersonState, stackId: string): string {
  return `inventory:${person.id}:${stackId}`;
}

function voxelSourceKey(position: { x: number; y: number; z: number }, materialId: MaterialId): string {
  return `voxel:${position.x}:${position.y}:${position.z}:${materialId}`;
}

function occupiedByBody(state: SimulationState, position: { x: number; y: number; z: number }): boolean {
  const cellId = position.x + position.y * state.world.grid.width;
  return state.people.some((candidate) => candidate.diedAtMonth === undefined
    && candidate.body.health > 0
    && candidate.position.cellId === cellId
    && (candidate.position.z === position.z || candidate.position.z + 1 === position.z));
}

function targetDistance(person: PersonState, position: { x: number; y: number; z: number }): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function localTarget(
  state: SimulationState,
  person: PersonState,
  materialId: MaterialId,
  willReplaceTarget: boolean,
): { x: number; y: number; z: number } | null {
  if (materialId === Material.Air) {
    for (const cellId of [...neighbors4(person.position.cellId)].sort((left, right) => left - right)) {
      const position = { x: cellX(cellId), y: cellY(cellId), z: person.position.z };
      if (voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Air) continue;
      if (materialDefinition(voxelAt(state.world.grid, position.x, position.y, position.z - 1)).phase !== 'solid') continue;
      if (willReplaceTarget && occupiedByBody(state, position)) continue;
      return position;
    }
    return null;
  }

  const candidates = cellsInRadius(person.position.cellId, 1)
    .flatMap((cellId) => {
      const top = topPosition(state.world.grid, cellId);
      const levels = [...new Set([top.z, person.position.z - 1, person.position.z, person.position.z + 1])]
        .filter((z) => z >= 0 && z < state.world.grid.levels);
      return levels.map((z) => ({ x: cellX(cellId), y: cellY(cellId), z }));
    })
    .filter((position) => targetDistance(person, position) <= 1
      && voxelAt(state.world.grid, position.x, position.y, position.z) === materialId
      && (!willReplaceTarget || !occupiedByBody(state, position)))
    .sort((left, right) => left.x - right.x || left.y - right.y || left.z - right.z);
  return candidates[0] ?? null;
}

function stackSources(person: PersonState, stackIds: string[]): { sourceKeys: string[]; sourceFactIds: string[] } {
  const stacks = stackIds.flatMap((stackId) => {
    const stack = person.inventory.find((candidate) => candidate.id === stackId && candidate.quantity > 0);
    return stack ? [stack] : [];
  });
  return {
    sourceKeys: [...new Set(stacks.map((stack) => inventorySourceKey(person, stack.id)))],
    sourceFactIds: [...new Set(stacks.flatMap((stack) => stack.sourceEventIds))],
  };
}

export function describeTechniqueAction(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
): TechniqueActionDescriptor | null {
  if (action.operation === 'combine') {
    if (action.targets.some((target) => target.kind !== 'inventory-stack')) return null;
    const refs = action.targets as Extract<WorldRef, { kind: 'inventory-stack' }>[];
    if (refs.length < 2 || refs.some((ref) => ref.personId !== person.id)) return null;
    const required = new Map<string, number>();
    for (const ref of refs) required.set(ref.stackId, (required.get(ref.stackId) ?? 0) + 1);
    if ([...required].some(([stackId, quantity]) => (
      person.inventory.find((stack) => stack.id === stackId)?.quantity ?? 0
    ) < quantity)) return null;
    const stacks = refs.map((ref) => person.inventory.find((stack) => stack.id === ref.stackId)!);
    const rule = inventoryCombinationFor(stacks.map((stack) => stack.materialId));
    if (!rule) return null;
    const sources = stackSources(person, refs.map((ref) => ref.stackId));
    return {
      techniqueId: inventoryCombinationTechniqueId(rule),
      summary: inventoryCombinationSummary(rule),
      operation: 'combine',
      inputMaterialIds: stacks.map((stack) => stack.materialId),
      outputMaterialId: rule.output.materialId,
      ...sources,
    };
  }

  if (action.operation === 'exert') {
    const inputRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
    const targetRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
    const input = inputRef?.personId === person.id
      ? person.inventory.find((stack) => stack.id === inputRef.stackId && stack.quantity > 0)
      : undefined;
    const tool = action.toolStackId
      ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0)
      : undefined;
    if (!input || !tool || !targetRef || targetDistance(person, targetRef.position) > 1) return null;
    if (input.id === tool.id && input.quantity < 2) return null;
    const targetMaterialId = voxelAt(
      state.world.grid,
      targetRef.position.x,
      targetRef.position.y,
      targetRef.position.z,
    );
    const rule = exertionRuleFor(tool.materialId, input.materialId, targetMaterialId);
    if (!rule) return null;
    const sources = stackSources(person, [tool.id, input.id]);
    return {
      techniqueId: exertionTechniqueId(rule),
      summary: exertionTechniqueSummary(rule),
      operation: 'exert',
      inputMaterialIds: [input.materialId],
      toolMaterialId: tool.materialId,
      targetMaterialId,
      outputMaterialId: rule.outputMaterialId,
      sourceKeys: [...new Set([...sources.sourceKeys, voxelSourceKey(targetRef.position, targetMaterialId)])],
      sourceFactIds: sources.sourceFactIds,
    };
  }

  if (action.operation === 'expose') {
    const inputRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
    const targetRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
    const input = inputRef?.personId === person.id
      ? person.inventory.find((stack) => stack.id === inputRef.stackId && stack.quantity > 0)
      : undefined;
    if (!input || !targetRef || targetDistance(person, targetRef.position) > 1) return null;
    const targetMaterialId = voxelAt(
      state.world.grid,
      targetRef.position.x,
      targetRef.position.y,
      targetRef.position.z,
    );
    const rule = exposureRuleFor(input.materialId, targetMaterialId);
    if (!rule) return null;
    const sources = stackSources(person, [input.id]);
    return {
      techniqueId: exposureTechniqueId(rule),
      summary: exposureTechniqueSummary(rule),
      operation: 'expose',
      inputMaterialIds: [input.materialId],
      targetMaterialId,
      outputMaterialId: rule.outputMaterialId,
      sourceKeys: [...new Set([...sources.sourceKeys, voxelSourceKey(targetRef.position, targetMaterialId)])],
      sourceFactIds: sources.sourceFactIds,
    };
  }
  return null;
}

function refsForCombination(person: PersonState, rule: InventoryCombinationRule): Extract<WorldRef, { kind: 'inventory-stack' }>[] | null {
  const refs: Extract<WorldRef, { kind: 'inventory-stack' }>[] = [];
  for (const input of rule.inputs) {
    const stack = person.inventory
      .filter((candidate) => candidate.materialId === input.materialId && candidate.quantity >= input.quantity)
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!stack) return null;
    for (let count = 0; count < input.quantity; count += 1) {
      refs.push({ kind: 'inventory-stack', personId: person.id, stackId: stack.id });
    }
  }
  return refs;
}

export function compileTechniquePractice(
  state: SimulationState,
  person: PersonState,
  techniqueId: string,
): CompiledTechniquePractice | null {
  const parsed = techniqueRule(techniqueId);
  if (!parsed) return null;
  let action: Extract<PrimitiveAction, { kind: 'act' }>;
  if (parsed.operation === 'combine') {
    const refs = refsForCombination(person, parsed.rule);
    if (!refs) return null;
    action = { kind: 'act', operation: 'combine', targets: refs };
  } else if (parsed.operation === 'exert') {
    const tool = person.inventory
      .filter((stack) => stack.materialId === parsed.rule.toolMaterialId && stack.quantity > 0)
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const input = person.inventory
      .filter((stack) => stack.materialId === parsed.rule.inputMaterialId && stack.quantity > 0
        && (stack.id !== tool?.id || stack.quantity >= 2))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const target = localTarget(state, person, parsed.rule.targetMaterialId, parsed.rule.outputLocation === 'world');
    if (!tool || !input || !target) return null;
    action = {
      kind: 'act',
      operation: 'exert',
      toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: target },
      ],
    };
  } else {
    const input = person.inventory
      .filter((stack) => stack.materialId === parsed.rule.inputMaterialId && stack.quantity > 0)
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const target = localTarget(state, person, parsed.rule.targetMaterialId, false);
    if (!input || !target) return null;
    action = {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: target },
      ],
    };
  }
  const descriptor = describeTechniqueAction(state, person, action);
  return descriptor && descriptor.techniqueId === techniqueId ? { action, ...descriptor } : null;
}

export function techniqueInputMaterials(techniqueId: string): Array<{ materialId: MaterialId; quantity: number }> {
  const parsed = techniqueRule(techniqueId);
  if (!parsed) return [];
  if (parsed.operation === 'combine') return parsed.rule.inputs.map((input) => ({ ...input }));
  if (parsed.operation === 'exert') {
    const quantities = new Map<MaterialId, number>();
    quantities.set(parsed.rule.toolMaterialId, 1);
    quantities.set(parsed.rule.inputMaterialId, (quantities.get(parsed.rule.inputMaterialId) ?? 0) + 1);
    return [...quantities].map(([materialId, quantity]) => ({ materialId, quantity }));
  }
  return [{ materialId: parsed.rule.inputMaterialId, quantity: 1 }];
}
