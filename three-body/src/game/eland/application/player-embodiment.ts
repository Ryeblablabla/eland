import type {
  EmbodimentCommand,
  EmbodimentOptionCategory,
  EmbodimentOptionView,
  EmbodimentTargetView,
} from '../../embodimentContract';
import type {
  ActionOption,
  PrimitiveAction,
  WorldRef,
} from '../domain/action';
import { composeIntentChoice, isResumableIntent, type IntentChoice } from '../domain/intent';
import { followUpSemanticallyMatches } from '../domain/intent-follow-up';
import { materialHas } from '../domain/material';
import type { Decision, DecisionContext, SimulationState } from '../domain/model';
import { isAlive, type PersonState } from '../domain/person';
import { personById, projectById } from '../domain/state-index';
import {
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  surfaceStandingPosition,
  voxelAt,
} from '../world/grid';
import {
  validatePlayerInteractionChoice,
  type PlayerInteractionChoiceFailure,
} from './player-interaction-choice';
import {
  isFulfillmentOption,
  isRequiredSocialOption,
} from './rule-planner';
import type { TickActorControl } from './simulation/month-execution';
import { buildDecisionContextForPerson } from './simulation/tick-planner';

const WAIT_OPTION_ID = 'embodiment:wait';
const WAIT_CHOICE_KEY = 'embodiment:wait:v1';
const CONTINUE_OPTION_PREFIX = 'embodiment:continue-intent:';
const MOVE_OPTION_PREFIX = 'embodiment:move:';

export type PlayerEmbodimentOptionView = EmbodimentOptionView;
export type PlayerEmbodimentCommand = EmbodimentCommand;

export type PlayerEmbodimentCommandFailure = PlayerInteractionChoiceFailure
  | 'person-unavailable'
  | 'option-unavailable'
  | 'choice-ambiguous';

export type PlayerEmbodimentCommandResolution =
  | {
      ok: true;
      control: TickActorControl;
      option: PlayerEmbodimentOptionView;
      remappedOptionId?: string;
    }
  | {
      ok: false;
      failure: PlayerEmbodimentCommandFailure;
    };

interface CompiledEmbodimentOptions {
  context: DecisionContext;
  options: PlayerEmbodimentOptionView[];
}

function standingTarget(cellId: number, z: number): EmbodimentTargetView {
  return { kind: 'standing-position', cellId, z };
}

function targetForWorldRef(
  state: SimulationState,
  target: WorldRef | undefined,
): EmbodimentTargetView | undefined {
  if (!target) return undefined;
  if (target.kind === 'person') {
    const person = personById(state, target.personId);
    return person ? {
      kind: 'person',
      personId: person.id,
      cellId: person.position.cellId,
      z: person.position.z,
    } : undefined;
  }
  if (target.kind === 'voxel') {
    const cellId = target.position.x + target.position.y * state.world.grid.width;
    return {
      kind: 'voxel',
      cellId,
      z: target.position.z,
      materialId: voxelAt(
        state.world.grid,
        target.position.x,
        target.position.y,
        target.position.z,
      ),
    };
  }
  if (target.kind === 'drop') {
    const drop = state.world.drops.find((candidate) => candidate.id === target.dropId && candidate.quantity > 0);
    return drop ? {
      kind: 'drop',
      dropId: drop.id,
      cellId: drop.cellId,
      z: drop.z,
    } : undefined;
  }
  if (target.kind === 'container') {
    const container = state.containers.find((candidate) => candidate.id === target.containerId);
    return container ? {
      kind: 'container',
      containerId: container.id,
      cellId: container.position.x + container.position.y * state.world.grid.width,
      z: container.position.z,
    } : undefined;
  }
  return undefined;
}

function targetForAction(
  state: SimulationState,
  action: PrimitiveAction,
): EmbodimentTargetView | undefined {
  if (action.kind === 'move') {
    const z = action.toZ ?? surfaceStandingPosition(state.world.grid, action.toCellId)?.z;
    return z === undefined ? undefined : standingTarget(action.toCellId, z);
  }
  if (action.kind === 'attend') return targetForWorldRef(state, action.target);
  if (action.kind === 'act') {
    return action.targets.flatMap((target) => {
      const projected = targetForWorldRef(state, target);
      return projected ? [projected] : [];
    })[0];
  }
  if (action.kind === 'communicate') {
    const audience = action.audience
      .map((personId) => targetForWorldRef(state, { kind: 'person', personId }))
      .find(Boolean);
    return audience;
  }
  const holder = action.to.kind === 'person'
    ? targetForWorldRef(state, { kind: 'person', personId: action.to.personId })
    : action.to.kind === 'container'
      ? targetForWorldRef(state, { kind: 'container', containerId: action.to.containerId })
      : action.to.kind === 'ground'
        ? standingTarget(action.to.cellId, action.to.z ?? 1)
        : undefined;
  return holder;
}

function buildingCombineAction(
  person: PersonState,
  action: PrimitiveAction | undefined,
): boolean {
  if (action?.kind !== 'act' || action.operation !== 'combine') return false;
  const buildsIntoVoxel = action.targets.some((target) => target.kind === 'voxel');
  if (!buildsIntoVoxel) return false;
  return action.targets.some((target) => {
    if (target.kind !== 'inventory-stack' || target.personId !== person.id) return false;
    const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
    return Boolean(stack && (materialHas(stack.materialId, 'building') || materialHas(stack.materialId, 'placeable')));
  });
}

function categoryForChoice(
  state: SimulationState,
  person: PersonState,
  choice: Pick<IntentChoice, 'nextAction' | 'completionAction' | 'openingAction' | 'projectId' | 'projectProposal'>,
): EmbodimentOptionCategory {
  const actions = [choice.openingAction, choice.nextAction, choice.completionAction];
  const project = choice.projectId ? projectById(state, choice.projectId) : undefined;
  if (choice.projectProposal?.kind === 'construction'
    || project?.kind === 'construction'
    || actions.some((action) => buildingCombineAction(person, action))) return 'build';
  if (choice.projectId || choice.projectProposal) return 'project';
  const action = choice.openingAction ?? choice.nextAction;
  if (action.kind === 'move') return 'move';
  if (action.kind === 'transfer') return 'transfer';
  if (action.kind === 'attend') return 'attend';
  if (action.kind === 'communicate') return 'communicate';
  if (action.operation === 'ingest'
    || action.operation === 'dehydrate'
    || action.operation === 'rehydrate') return 'survival';
  return 'project';
}

function materialCostForChoice(
  person: PersonState,
  choice: Pick<IntentChoice, 'nextAction' | 'completionAction' | 'openingAction'>,
  category: EmbodimentOptionCategory,
): EmbodimentOptionView['materialCost'] {
  if (category !== 'build') return undefined;
  const quantities = new Map<number, number>();
  for (const action of [choice.openingAction, choice.nextAction, choice.completionAction]) {
    if (action?.kind !== 'act' || action.operation !== 'combine') continue;
    for (const target of action.targets) {
      if (target.kind !== 'inventory-stack' || target.personId !== person.id) continue;
      const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
      if (!stack) continue;
      quantities.set(stack.materialId, (quantities.get(stack.materialId) ?? 0) + 1);
    }
  }
  return quantities.size
    ? [...quantities].map(([materialId, quantity]) => ({ materialId, quantity }))
    : undefined;
}

function actionTargetForChoice(
  state: SimulationState,
  choice: Pick<IntentChoice, 'target' | 'nextAction' | 'openingAction'>,
): EmbodimentTargetView | undefined {
  return targetForWorldRef(state, choice.target)
    ?? targetForAction(state, choice.openingAction ?? choice.nextAction);
}

function moveLabel(fromCellId: number, toCellId: number): string {
  const dx = cellX(toCellId) - cellX(fromCellId);
  const dy = cellY(toCellId) - cellY(fromCellId);
  const direction = dy < 0 ? '北' : dx < 0 ? '西' : dx > 0 ? '东' : '南';
  return `向${direction}移动一步`;
}

function waitOption(): PlayerEmbodimentOptionView {
  return {
    optionId: WAIT_OPTION_ID,
    choiceKey: WAIT_CHOICE_KEY,
    source: 'wait',
    category: 'wait',
    label: '等待一刻',
    reason: '不主动改变当前安排，让世界继续推进一个规划刻度',
    tickCost: 1,
    primary: false,
  };
}

function continueIntentOption(
  state: SimulationState,
  person: PersonState,
  context: DecisionContext,
): PlayerEmbodimentOptionView | undefined {
  const intent = context.activeIntent;
  if (!intent) return undefined;
  const category = categoryForChoice(state, person, intent);
  return {
    optionId: `${CONTINUE_OPTION_PREFIX}${intent.id}`,
    choiceKey: `embodiment:continue-intent:v1:${intent.id}`,
    source: 'continue-intent',
    category,
    label: `继续：${intent.summary}`,
    reason: '沿用本人当前仍有效的意图，并在本刻重新校验下一原子行动',
    tickCost: 1,
    target: actionTargetForChoice(state, intent),
    materialCost: materialCostForChoice(person, intent, category),
    primary: true,
  };
}

function adjacentMoveOptions(
  state: SimulationState,
  person: PersonState,
): PlayerEmbodimentOptionView[] {
  return neighbors4(person.position.cellId).flatMap((neighbor) => {
    const path = findStandingPath(state.world.grid, person.position, { cellId: neighbor });
    if (path.length !== 2 || path[1].cellId !== neighbor) return [];
    const destination = path[1];
    return [{
      optionId: `${MOVE_OPTION_PREFIX}${destination.cellId}:${destination.z}`,
      choiceKey: `embodiment:move:v1:${destination.cellId}:${destination.z}`,
      source: 'primitive-action' as const,
      category: 'move' as const,
      label: moveLabel(person.position.cellId, destination.cellId),
      reason: '相邻位置当前存在连续、可容纳身体的真实站立路径',
      tickCost: 1 as const,
      target: standingTarget(destination.cellId, destination.z),
      primary: false,
    }];
  });
}

function followUpsForOption(context: DecisionContext, option: ActionOption): Array<ActionOption | undefined> {
  return option.requiresFollowUp
    ? context.followUpOptions.filter((followUp) => followUpSemanticallyMatches(option, followUp))
    : [undefined];
}

function decisionOptions(
  state: SimulationState,
  person: PersonState,
  context: DecisionContext,
): PlayerEmbodimentOptionView[] {
  return context.options.flatMap((option) => followUpsForOption(context, option).flatMap((followUp) => {
    const validation = validatePlayerInteractionChoice(context, {
      optionId: option.id,
      ...(followUp ? { followUpOptionId: followUp.id } : {}),
    });
    if (!validation.ok) return [];
    const choice = composeIntentChoice(
      context.options,
      context.followUpOptions,
      validation.optionId,
      validation.followUpOptionId,
    );
    if (!choice) return [];
    const category = categoryForChoice(state, person, choice);
    const risks = [...new Set([...(option.risks ?? []), ...(followUp?.risks ?? [])])];
    return [{
      optionId: validation.optionId,
      choiceKey: validation.choiceKey,
      source: 'decision' as const,
      category,
      label: validation.summary,
      reason: option.reason,
      tickCost: 1 as const,
      target: actionTargetForChoice(state, choice),
      materialCost: materialCostForChoice(person, choice, category),
      ...(risks.length ? { risks } : {}),
      primary: isRequiredSocialOption(option) || isFulfillmentOption(option),
    }];
  }));
}

function compilePlayerEmbodimentOptions(
  state: SimulationState,
  requestedPerson: PersonState,
  atMonth: number,
): CompiledEmbodimentOptions | null {
  const person = personById(state, requestedPerson.id);
  if (!person || !isAlive(person)) return null;
  const context = buildDecisionContextForPerson(state, person, atMonth);
  const continuation = continueIntentOption(state, person, context);
  return {
    context,
    options: [
      waitOption(),
      ...(continuation ? [continuation] : []),
      ...adjacentMoveOptions(state, person),
      ...decisionOptions(state, person, context),
    ],
  };
}

/**
 * Projects only choices grounded in the controlled person's current body,
 * perception, inventory, projects and local voxel world. The result is a read
 * model: it never grants the client authority to mutate those facts directly.
 */
export function buildPlayerEmbodimentOptions(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): PlayerEmbodimentOptionView[] {
  return compilePlayerEmbodimentOptions(state, person, atMonth)?.options ?? [];
}

function selectedProjectedOption(
  options: PlayerEmbodimentOptionView[],
  command: Extract<EmbodimentCommand, { kind: 'choose-option' }>,
): { option?: PlayerEmbodimentOptionView; ambiguous: boolean } {
  const exact = options.filter((option) => option.optionId === command.optionId
    && option.choiceKey === command.choiceKey);
  if (exact.length === 1) return { option: exact[0], ambiguous: false };
  if (exact.length > 1) return { ambiguous: true };
  const semantic = options.filter((option) => option.choiceKey === command.choiceKey);
  if (semantic.length === 1) return { option: semantic[0], ambiguous: false };
  return { ambiguous: semantic.length > 1 };
}

function decisionForSelectedOption(
  context: DecisionContext,
  option: ActionOption,
  optionId: string,
  followUpOptionId: string | undefined,
): Decision {
  const shared = {
    optionId,
    ...(followUpOptionId ? { followUpOptionId } : {}),
    reason: `玩家在有限化身中选择：${option.summary}`,
  };
  const active = context.activeIntent;
  if (!active) return { kind: 'start', ...shared };
  const interruption = option.nextAction.kind === 'act' && option.nextAction.operation === 'dehydrate'
    ? 'survival-reflex' as const
    : isRequiredSocialOption(option)
      ? 'required-response' as const
      : isFulfillmentOption(option)
        ? 'fulfillment' as const
        : option.recordUseBasis && !active.recordUseBasis
          ? 'record-use' as const
          : undefined;
  const mayInterrupt = interruption && (
    interruption === 'survival-reflex'
    || isResumableIntent(active)
  );
  return {
    kind: 'revise',
    intentId: active.id,
    ...shared,
    ...(mayInterrupt ? { mode: 'interrupt' as const, interruptionKind: interruption } : {}),
  };
}

/**
 * Resolves a transport command against a freshly compiled local context. Call
 * this from the TickActorController callback, after earlier actors in the same
 * tick have acted. The returned direct action or decision still goes through
 * the ordinary domain executor and its final legality checks.
 */
export function resolvePlayerEmbodimentCommand(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  command: EmbodimentCommand,
): PlayerEmbodimentCommandResolution {
  const compiled = compilePlayerEmbodimentOptions(state, person, atMonth);
  if (!compiled) return { ok: false, failure: 'person-unavailable' };
  if (command.kind === 'wait') {
    return { ok: true, control: { kind: 'wait' }, option: compiled.options[0] };
  }
  const selected = selectedProjectedOption(compiled.options, command);
  if (selected.ambiguous) return { ok: false, failure: 'choice-ambiguous' };
  if (!selected.option) return { ok: false, failure: 'option-unavailable' };
  const remappedOptionId = selected.option.optionId === command.optionId
    ? undefined
    : selected.option.optionId;
  if (selected.option.source === 'wait') {
    return {
      ok: true,
      control: { kind: 'wait' },
      option: selected.option,
      ...(remappedOptionId ? { remappedOptionId } : {}),
    };
  }
  if (selected.option.source === 'continue-intent') {
    return {
      ok: true,
      control: { kind: 'continue-intent' },
      option: selected.option,
      ...(remappedOptionId ? { remappedOptionId } : {}),
    };
  }
  if (selected.option.source === 'primitive-action') {
    const target = selected.option.target;
    if (target?.kind !== 'standing-position') return { ok: false, failure: 'option-unavailable' };
    return {
      ok: true,
      control: {
        kind: 'direct-action',
        action: { kind: 'move', toCellId: target.cellId, toZ: target.z },
      },
      option: selected.option,
      ...(remappedOptionId ? { remappedOptionId } : {}),
    };
  }

  const validation = validatePlayerInteractionChoice(compiled.context, {
    optionId: command.optionId,
    ...(command.followUpOptionId ? { followUpOptionId: command.followUpOptionId } : {}),
    choiceKey: command.choiceKey,
  });
  if (!validation.ok) return { ok: false, failure: validation.failure };
  const option = compiled.context.options.find((candidate) => candidate.id === validation.optionId);
  if (!option) return { ok: false, failure: 'option-unavailable' };
  const decision = decisionForSelectedOption(
    compiled.context,
    option,
    validation.optionId,
    validation.followUpOptionId,
  );
  return {
    ok: true,
    control: {
      kind: 'decision',
      context: compiled.context,
      decision,
      usedModel: false,
    },
    option: selected.option,
    ...(validation.optionId !== command.optionId
      ? { remappedOptionId: validation.optionId }
      : remappedOptionId
        ? { remappedOptionId }
        : {}),
  };
}
