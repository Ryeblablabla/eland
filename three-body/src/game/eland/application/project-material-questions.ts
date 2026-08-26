import type {
  PerceivedMaterialAppearance,
  PerceivedMaterialForm,
  PerceivedMaterialLoadBand,
  PerceivedMaterialPhase,
  PerceivedMaterialProfile,
  PerceivedMaterialRigidity,
} from '../domain/material-perception';
import type {
  ProjectFunction,
  ProjectHypothesisOperation,
  ProjectHypothesisQuestionKind,
} from '../domain/project';

export type ProjectMaterialTrait = keyof PerceivedMaterialProfile;

type ProjectMaterialTraitValue =
  | PerceivedMaterialPhase
  | PerceivedMaterialLoadBand
  | PerceivedMaterialRigidity
  | PerceivedMaterialForm
  | PerceivedMaterialAppearance;

export interface ProjectMaterialTraitQuestion {
  trait: ProjectMaterialTrait;
  anyOf: readonly ProjectMaterialTraitValue[];
}

export interface ProjectMaterialRoleQuestion {
  roleKey: string;
  quantity: 1 | 2;
  required: readonly ProjectMaterialTraitQuestion[];
  optional: readonly ProjectMaterialTraitQuestion[];
}

/**
 * Planner-facing uncertainty. It describes only tangible roles and traits;
 * expected outputs, material identities and authoritative rule identities are
 * deliberately not representable here.
 */
export interface ProjectMaterialQuestion {
  kind: ProjectHypothesisQuestionKind;
  roles: readonly ProjectMaterialRoleQuestion[];
  strictVisualRoles: boolean;
}

const SOLID: ProjectMaterialTraitQuestion = { trait: 'phase', anyOf: ['solid'] };
const PORTABLE: ProjectMaterialTraitQuestion = { trait: 'loadBand', anyOf: ['trace', 'light', 'hand-load'] };
const LIGHT: ProjectMaterialTraitQuestion = { trait: 'loadBand', anyOf: ['trace', 'light'] };
const FLEXIBLE_FORM: ProjectMaterialTraitQuestion = {
  trait: 'form',
  anyOf: ['flexible-strand', 'flexible-sheet', 'plant-bundle'],
};
const STRUCTURAL_FORM: ProjectMaterialTraitQuestion = {
  trait: 'form',
  anyOf: ['structural-member'],
};
const BODY_FORM: ProjectMaterialTraitQuestion = {
  trait: 'form',
  anyOf: ['compact-body', 'structural-member', 'shaped-object'],
};
const NOT_BRITTLE: ProjectMaterialTraitQuestion = {
  trait: 'rigidity',
  anyOf: ['pliant', 'workable', 'rigid'],
};
const RIGID: ProjectMaterialTraitQuestion = {
  trait: 'rigidity',
  anyOf: ['rigid', 'very-rigid'],
};
const METALLIC: ProjectMaterialTraitQuestion = { trait: 'appearance', anyOf: ['metallic'] };

const QUESTIONS: Record<ProjectHypothesisQuestionKind, ProjectMaterialQuestion> = {
  'connect-manipulator-shapes': {
    kind: 'connect-manipulator-shapes',
    strictVisualRoles: false,
    roles: [
      { roleKey: 'portable-manipulator', quantity: 1, required: [SOLID], optional: [RIGID, PORTABLE] },
      { roleKey: 'workable-subject', quantity: 1, required: [], optional: [NOT_BRITTLE, PORTABLE] },
    ],
  },
  'connect-flexible-layers': {
    kind: 'connect-flexible-layers',
    strictVisualRoles: false,
    roles: [
      { roleKey: 'flexible-layer', quantity: 1, required: [FLEXIBLE_FORM], optional: [LIGHT, NOT_BRITTLE] },
      { roleKey: 'supporting-layer', quantity: 1, required: [], optional: [FLEXIBLE_FORM, LIGHT, NOT_BRITTLE] },
    ],
  },
  'assemble-balanced-suspension': {
    kind: 'assemble-balanced-suspension',
    strictVisualRoles: true,
    roles: [
      { roleKey: 'symmetric-member', quantity: 2, required: [SOLID, STRUCTURAL_FORM], optional: [PORTABLE, NOT_BRITTLE] },
      { roleKey: 'suspension', quantity: 1, required: [FLEXIBLE_FORM], optional: [LIGHT, NOT_BRITTLE] },
    ],
  },
  'shape-repeatable-reference': {
    kind: 'shape-repeatable-reference',
    strictVisualRoles: true,
    roles: [
      { roleKey: 'stable-reference', quantity: 1, required: [SOLID, BODY_FORM, METALLIC], optional: [RIGID, PORTABLE] },
      { roleKey: 'visible-marker', quantity: 1, required: [FLEXIBLE_FORM], optional: [LIGHT, NOT_BRITTLE] },
    ],
  },
  'assemble-flow-driven-rotor': {
    kind: 'assemble-flow-driven-rotor',
    strictVisualRoles: true,
    roles: [
      { roleKey: 'flow-facing-member', quantity: 1, required: [SOLID, STRUCTURAL_FORM], optional: [PORTABLE, NOT_BRITTLE] },
      { roleKey: 'flexible-lashing', quantity: 1, required: [FLEXIBLE_FORM], optional: [LIGHT, NOT_BRITTLE] },
    ],
  },
  'shape-rigid-rotating-connector': {
    kind: 'shape-rigid-rotating-connector',
    strictVisualRoles: true,
    roles: [
      { roleKey: 'straight-member', quantity: 1, required: [SOLID, STRUCTURAL_FORM], optional: [RIGID, PORTABLE] },
      { roleKey: 'rotating-body', quantity: 1, required: [SOLID, BODY_FORM, METALLIC], optional: [RIGID, PORTABLE] },
    ],
  },
  'seek-local-heat': {
    kind: 'seek-local-heat',
    strictVisualRoles: false,
    roles: [
      { roleKey: 'hard-manipulator', quantity: 1, required: [SOLID], optional: [RIGID, PORTABLE] },
      { roleKey: 'light-subject', quantity: 1, required: [], optional: [LIGHT, NOT_BRITTLE] },
    ],
  },
  'shape-portable-surface': {
    kind: 'shape-portable-surface',
    strictVisualRoles: false,
    roles: [
      { roleKey: 'hard-manipulator', quantity: 1, required: [SOLID], optional: [RIGID, PORTABLE] },
      { roleKey: 'portable-surface', quantity: 1, required: [SOLID], optional: [PORTABLE, NOT_BRITTLE] },
    ],
  },
  'transform-subject-with-observed-heat': {
    kind: 'transform-subject-with-observed-heat',
    strictVisualRoles: false,
    roles: [
      { roleKey: 'transformable-subject', quantity: 1, required: [], optional: [PORTABLE, NOT_BRITTLE] },
    ],
  },
};

export interface MaterialRoleAssessment {
  requiredMatched: number;
  requiredUnknown: number;
  requiredMismatched: number;
  optionalMatched: number;
  reasonKeys: string[];
}

function traitValue(profile: PerceivedMaterialProfile, trait: ProjectMaterialTrait): ProjectMaterialTraitValue | undefined {
  return profile[trait];
}

export function assessMaterialRole(
  profile: PerceivedMaterialProfile,
  role: ProjectMaterialRoleQuestion,
): MaterialRoleAssessment {
  let requiredMatched = 0;
  let requiredUnknown = 0;
  let requiredMismatched = 0;
  let optionalMatched = 0;
  const reasonKeys: string[] = [];
  for (const requirement of role.required) {
    const value = traitValue(profile, requirement.trait);
    if (value === undefined) {
      requiredUnknown += 1;
      reasonKeys.push(`role-${role.roleKey}-${requirement.trait}-unknown`);
    } else if (requirement.anyOf.includes(value)) {
      requiredMatched += 1;
      reasonKeys.push(`role-${role.roleKey}-${requirement.trait}`);
    } else {
      requiredMismatched += 1;
      reasonKeys.push(`role-${role.roleKey}-${requirement.trait}-mismatch`);
    }
  }
  for (const preference of role.optional) {
    const value = traitValue(profile, preference.trait);
    if (value !== undefined && preference.anyOf.includes(value)) {
      optionalMatched += 1;
      reasonKeys.push(`trait-${role.roleKey}-${preference.trait}`);
    }
  }
  return { requiredMatched, requiredUnknown, requiredMismatched, optionalMatched, reasonKeys };
}

export function materialQuestionFor(
  desiredFunction: ProjectFunction,
  operation: ProjectHypothesisOperation,
  explicitKind?: ProjectHypothesisQuestionKind,
): ProjectMaterialQuestion {
  if (explicitKind) return QUESTIONS[explicitKind];
  if (operation === 'expose-local') return QUESTIONS['transform-subject-with-observed-heat'];
  if (operation === 'exert-air') return QUESTIONS[desiredFunction === 'prepared-food'
    ? 'seek-local-heat'
    : 'shape-portable-surface'];
  if (desiredFunction === 'insulation' || desiredFunction === 'healing') {
    return QUESTIONS['connect-flexible-layers'];
  }
  if (desiredFunction === 'comparable-mass-measurement') {
    return QUESTIONS['assemble-balanced-suspension'];
  }
  return QUESTIONS['connect-manipulator-shapes'];
}
