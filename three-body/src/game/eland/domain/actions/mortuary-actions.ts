import type { PrimitiveAction } from '../action';
import { Material, materialHas } from '../material';
import type { SimulationState } from '../model';
import type { PersonState } from '../person';
import { bereavementFor, memorialForRemains, remainsById } from '../mortuary';
import { productionToolRank } from '../production-tool';
import { personById } from '../state-index';
import { cellId, setVoxel, surfaceMaterial, voxelAt } from '../../world/grid';
import { bodyStandsOn, clamp, distanceToPosition } from './execution-helpers';
import { removeEmptyStacks } from './inventory';

export function executeMortuary(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const phase = action.mortuaryPhase;
  const remainsRef = action.targets.find((target) => target.kind === 'remains');
  const remains = remainsRef?.kind === 'remains' ? remainsById(state, remainsRef.remainsId) : undefined;
  const deceased = remains ? personById(state, remains.personId) : undefined;
  const bereavement = remains ? bereavementFor(person, remains.id) : undefined;
  if (!phase || !remains || !deceased || !bereavement) {
    return { status: 'blocked' as const, result: '丧葬行动没有绑定本人知晓的真实死亡与遗体', diff: {} };
  }
  const access = remains.grave?.accessPosition ?? remains.position;
  const atAccess = person.position.cellId === access.cellId && person.position.z === access.z;
  const spendWork = (heavy = false) => {
    person.body.hydration = clamp(person.body.hydration - (heavy ? 0.55 : 0.2));
    person.body.nutrition = clamp(person.body.nutrition - (heavy ? 0.45 : 0.15));
  };

  if (phase === 'mourn') {
    if (!atAccess || bereavement.lastMournedAtMonth !== undefined) {
      return { status: 'blocked' as const, result: '本人不在遗体或墓记近旁，或已经完成过这次悼念', diff: {} };
    }
    bereavement.lastMournedAtMonth = atMonth;
    return {
      status: 'completed' as const,
      result: remains.status === 'interred'
        ? `${person.name}在${deceased.name}的墓前停留悼念`
        : `${person.name}在${deceased.name}的遗体旁停留哀悼`,
      diff: {
        mortuaryPhase: phase,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        griefIntensity: bereavement.intensity,
        sourceEventIds: [...bereavement.sourceEventIds],
      },
    };
  }

  if (phase === 'lift') {
    if (remains.status !== 'exposed'
      || person.position.cellId !== remains.position.cellId
      || person.position.z !== remains.position.z
      || (state.world.remains ?? []).some((candidate) => candidate.carriedByPersonId === person.id)) {
      return { status: 'blocked' as const, result: '遗体不在本人近身位置，或本人已经搬运另一具遗体', diff: {} };
    }
    remains.status = 'carried';
    remains.carriedByPersonId = person.id;
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}近身抬起${deceased.name}的遗体`,
      diff: { mortuaryPhase: phase, remainsId: remains.id, deceasedPersonId: deceased.id, deathEventId: remains.deathEventId },
    };
  }

  if (phase === 'prepare-grave') {
    const voxelRef = action.targets.find((target) => target.kind === 'voxel');
    const position = voxelRef?.kind === 'voxel' ? voxelRef.position : undefined;
    if (!position
      || remains.status !== 'carried'
      || remains.carriedByPersonId !== person.id
      || remains.grave
      || distanceToPosition(person, position) > 1) {
      return { status: 'blocked' as const, result: '挖墓没有绑定本人搬运的遗体或近身地表', diff: {} };
    }
    const graveCellId = cellId(position.x, position.y);
    const originalMaterialId = voxelAt(state.world.grid, position.x, position.y, position.z);
    const validSurface = materialHas(originalMaterialId, 'ground')
      && surfaceMaterial(state.world.grid, graveCellId) === originalMaterialId
      && voxelAt(state.world.grid, position.x, position.y, position.z + 1) === Material.Air;
    const occupied = bodyStandsOn(state, position)
      || (state.world.remains ?? []).some((candidate) => candidate.grave
        && candidate.grave.position.x === position.x
        && candidate.grave.position.y === position.y
        && candidate.grave.position.z === position.z);
    if (!validSurface || occupied) return { status: 'blocked' as const, result: '所指位置不再是可挖掘且无人占用的真实地表', diff: {} };
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
    const coverMaterialStackId = `stack:${person.id}:grave-cover:${remains.id}`;
    person.inventory.push({
      id: coverMaterialStackId,
      materialId: originalMaterialId,
      quantity: 1,
      sourceEventIds: [eventId],
      sourceLineageKeys: [`voxel:${position.x}:${position.y}:${position.z}:${originalMaterialId}`],
    });
    remains.grave = {
      position: { ...position },
      accessPosition: { cellId: person.position.cellId, z: person.position.z },
      originalMaterialId,
      preparedByPersonId: person.id,
      preparedAtMonth: atMonth,
      excavationEventId: eventId,
      coverMaterialStackId,
    };
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}在近身地表挖出一处可放置遗体的墓穴，并保留覆土`,
      diff: {
        mortuaryPhase: phase,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        gravePosition: { ...position },
        excavatedMaterialId: originalMaterialId,
        coverMaterialStackId,
        sourceEventIds: [remains.deathEventId],
      },
    };
  }

  if (phase === 'place-in-grave') {
    const grave = remains.grave;
    if (!grave || !atAccess || remains.status !== 'carried' || remains.carriedByPersonId !== person.id
      || voxelAt(state.world.grid, grave.position.x, grave.position.y, grave.position.z) !== Material.Air) {
      return { status: 'blocked' as const, result: '遗体、墓穴或近身位置已经不满足放置条件', diff: {} };
    }
    remains.status = 'placed';
    remains.position = { cellId: cellId(grave.position.x, grave.position.y), z: grave.position.z };
    delete remains.carriedByPersonId;
    grave.placementEventId = eventId;
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}把${deceased.name}的遗体放入已经挖好的墓穴`,
      diff: {
        mortuaryPhase: phase, remainsId: remains.id, deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId, gravePosition: { ...grave.position }, excavationEventId: grave.excavationEventId,
      },
    };
  }

  if (phase === 'cover-grave') {
    const grave = remains.grave;
    const coverRef = action.targets.find((target) => target.kind === 'inventory-stack');
    const cover = coverRef?.kind === 'inventory-stack' && coverRef.personId === person.id
      ? person.inventory.find((stack) => stack.id === coverRef.stackId && stack.quantity > 0)
      : undefined;
    if (!grave || !atAccess || remains.status !== 'placed'
      || !cover
      || cover.id !== grave.coverMaterialStackId
      || cover.materialId !== grave.originalMaterialId
      || !cover.sourceEventIds.includes(grave.excavationEventId)
      || voxelAt(state.world.grid, grave.position.x, grave.position.y, grave.position.z) !== Material.Air) {
      return { status: 'blocked' as const, result: '覆土没有来自这座墓穴的真实挖掘物，或墓穴状态已经变化', diff: {} };
    }
    cover.quantity -= 1;
    removeEmptyStacks(person);
    setVoxel(state.world.grid, grave.position.x, grave.position.y, grave.position.z, grave.originalMaterialId);
    remains.status = 'interred';
    remains.interredAtMonth = atMonth;
    remains.interredByPersonId = person.id;
    remains.position = { cellId: cellId(grave.position.x, grave.position.y), z: grave.position.z };
    grave.burialEventId = eventId;
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    for (const observer of state.people) {
      const grief = bereavementFor(observer, remains.id);
      if (grief) grief.careResolvedAtMonth = atMonth;
    }
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}用原墓穴覆土安葬了${deceased.name}`,
      diff: {
        mortuaryPhase: phase,
        remainsInterred: true,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        gravePosition: { ...grave.position },
        excavationEventId: grave.excavationEventId,
        placementEventId: grave.placementEventId,
        coverMaterialStackId: grave.coverMaterialStackId,
        coverMaterialId: grave.originalMaterialId,
        sourceEventIds: [...new Set([remains.deathEventId, grave.excavationEventId, grave.placementEventId ?? ''])].filter(Boolean),
      },
    };
  }

  if (phase === 'mark') {
    state.world.memorials ??= [];
    const grave = remains.grave;
    const tabletRef = action.targets.find((target) => target.kind === 'inventory-stack');
    const tablet = tabletRef?.kind === 'inventory-stack' && tabletRef.personId === person.id
      ? person.inventory.find((stack) => stack.id === tabletRef.stackId && stack.quantity > 0)
      : undefined;
    const tool = action.toolStackId
      ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0)
      : undefined;
    if (!grave || !atAccess || remains.status !== 'interred' || memorialForRemains(state, remains.id)
      || !tablet || tablet.materialId !== Material.WoodTablet || tablet.recordPayloadId
      || !tool || productionToolRank(tool.materialId) < productionToolRank(Material.StoneTool)) {
      return { status: 'blocked' as const, result: '墓记需要已安葬遗体、近身空白木板和足以刻写的真实工具', diff: {} };
    }
    const tabletSourceEventIds = [...tablet.sourceEventIds];
    tablet.quantity -= 1;
    removeEmptyStacks(person);
    const marker = {
      id: `memorial:${remains.id}`,
      remainsId: remains.id,
      personId: deceased.id,
      position: { ...grave.position, z: grave.position.z + 1 },
      materialId: Material.WoodTablet,
      inscription: deceased.name,
      madeByPersonId: person.id,
      createdAtMonth: atMonth,
      sourceEventIds: [...new Set([
        ...tabletSourceEventIds.slice(-21),
        remains.deathEventId,
        grave.burialEventId ?? '',
        eventId,
      ])].filter(Boolean).slice(-24),
    };
    state.world.memorials.push(marker);
    spendWork();
    return {
      status: 'completed' as const,
      result: `${person.name}消耗一块木制记录板，为${deceased.name}刻下墓记`,
      diff: {
        mortuaryPhase: phase,
        memorialMarked: true,
        memorialId: marker.id,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        burialEventId: grave.burialEventId,
        markerMaterialId: marker.materialId,
        tabletStackId: tablet.id,
        toolStackId: tool.id,
        inscription: marker.inscription,
        sourceEventIds: marker.sourceEventIds,
      },
    };
  }

  return { status: 'blocked' as const, result: '未知的丧葬动作阶段', diff: {} };
}
