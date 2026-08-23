import type { WorldRef } from '../../../domain/action';
import { Material } from '../../../domain/material';
import type { SimulationState } from '../../../domain/model';
import { isAlive, sameLocation, type PersonState } from '../../../domain/person';
import type { ProjectState } from '../../../domain/project';
import { isConsumableProjectStack, reservation } from '../project-material-planning';
import type { ProjectStep } from '../project-step';

export function careApplicationProjectStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'healing') return null;
  const medicine = person.inventory.find((stack) => stack.materialId === Material.HerbalMedicine
    && isConsumableProjectStack(stack));
  if (!medicine) return null;
  const beneficiary = project.beneficiaryIds
    .map((personId) => state.people.find((candidate) => candidate.id === personId && isAlive(candidate)))
    .find((candidate) => candidate?.conditions.some((condition) => (
      condition.kind === 'wound' || condition.kind === 'illness'
    )));
  if (!beneficiary) return null;
  const target: WorldRef = { kind: 'person', personId: beneficiary.id };
  return {
    key: `apply-care-${medicine.id}-${beneficiary.id}`,
    summary: `把项目制得的草药用于${beneficiary.name}的具体伤病`,
    reason: '项目的功能结果是改变伤病，而不是仅把材料留在背包里',
    action: sameLocation(person, beneficiary)
      ? {
        kind: 'act',
        operation: 'combine',
        targets: [{ kind: 'inventory-stack', personId: person.id, stackId: medicine.id }, target],
      }
      : { kind: 'move', toCellId: beneficiary.position.cellId, toZ: beneficiary.position.z },
    target,
    sourceFactIds: [
      ...medicine.sourceEventIds,
      ...beneficiary.conditions.flatMap((condition) => condition.sourceEventIds),
    ],
    missingMaterialIds: [],
    reservations: reservation(person, medicine.id),
  };
}
