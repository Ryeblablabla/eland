import {
  waterCurrentObservationFactId,
  type PrimitiveAction,
  type VoxelPosition,
  type WorldRef,
} from '../action';
import { animalSpecies, isAnimalAlive } from '../animal';
import { containerById } from '../container';
import { worldEventById } from '../event-index';
import { Material, materialDefinition } from '../material';
import {
  MECHANICAL_POWER_WORLD_VERSION,
  mechanicalPowerFaultObservationFactId,
  mechanicalPowerPlanKey,
  waterCurrentAvailabilityFor,
} from '../mechanical-power';
import type { SimulationState } from '../model';
import { remainsById } from '../mortuary';
import type { PersonState } from '../person';
import {
  projectLeadershipInspectionFactId,
  validateProjectLeadershipSuccessionAction,
} from '../project-leadership';
import { intentById, personById, projectById } from '../state-index';
import { rememberMaterialPlace } from '../spatial-knowledge';
import { cellId, cellX, cellY, voxelAt } from '../../world/grid';
import { executeElectricalPowerFaultAttend } from './electrical-power-actions';
import { clamp, distanceToPosition, samePosition } from './execution-helpers';
import { executeMeasurementAttend } from './measurement-actions';

type AttendAction = Extract<PrimitiveAction, { kind: 'attend' }>;

function targetCell(state: SimulationState, target: WorldRef): number | null {
  if (target.kind === 'voxel') return cellId(target.position.x, target.position.y);
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId ?? null;
  if (target.kind === 'container') {
    const container = containerById(state, target.containerId);
    return container ? cellId(container.position.x, container.position.y) : null;
  }
  if (target.kind === 'person') return personById(state, target.personId)?.position.cellId ?? null;
  if (target.kind === 'animal') return state.world.animals.find((animal) => animal.id === target.animalId)?.position.cellId ?? null;
  if (target.kind === 'remains') return remainsById(state, target.remainsId)?.position.cellId ?? null;
  return personById(state, target.personId)?.position.cellId ?? null;
}

export function executeAttend(
  state: SimulationState,
  person: PersonState,
  action: AttendAction,
  atMonth: number,
  eventId: string,
  intentId?: string,
) {
  const cell = targetCell(state, action.target);
  if (cell === null || Math.abs(cellX(cell) - cellX(person.position.cellId)) + Math.abs(cellY(cell) - cellY(person.position.cellId)) > 7) return { status: 'blocked' as const, result: '观察目标超出感知范围', diff: {} };
  if (action.projectLeadershipSuccession) {
    const succession = validateProjectLeadershipSuccessionAction(state, person, action, atMonth);
    if (!succession) return {
      status: 'blocked' as const,
      result: '项目 vacancy、本人贡献、死亡认知或现场位置已不再支持接任',
      diff: {},
    };
    const factId = projectLeadershipInspectionFactId(succession.basis);
    const sourceEventIds = [...new Set([...succession.basis.sourceFactIds, eventId])];
    const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
    if (existing) {
      existing.confidence = clamp(Math.max(existing.confidence, 68) + 8);
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    } else person.knowledge.push({
      id: factId,
      kind: 'observation',
      summary: `亲自检查“${succession.project.summary}”的固定工地并愿意接续公开工程`,
      confidence: 72,
      learnedAtMonth: atMonth,
      sourceEventIds,
    });
    return {
      status: 'completed' as const,
      result: `亲自检查固定工地后接任“${succession.project.summary}”`,
      diff: {
        factId,
        projectLeadershipSuccession: true,
        projectLeadershipProjectId: succession.project.id,
        projectLeadershipVacancyTransitionId: succession.basis.vacancyTransitionId,
        projectLeadershipPredecessorId: succession.basis.predecessorId,
        projectLeadershipSuccessorId: succession.basis.successorId,
        projectLeadershipDeathEventId: succession.basis.deathEventId,
        projectLeadershipContributionEventId: succession.basis.contributionEventId,
        projectLeadershipSite: { ...succession.basis.site },
        projectLeadershipSourceFactIds: [...succession.basis.sourceFactIds],
      },
    };
  }
  const measurement = executeMeasurementAttend(state, person, action, atMonth, eventId);
  if (measurement) return measurement;
  const electricalFault = executeElectricalPowerFaultAttend(state, person, action, atMonth, eventId);
  if (electricalFault) return electricalFault;
  if (action.waterCurrentSegmentId) {
    const mechanicalPower = state.world.mechanicalPower;
    const segment = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
      ? mechanicalPower.sources.find((candidate) => candidate.id === action.waterCurrentSegmentId)
      : undefined;
    const position = action.target.kind === 'voxel' ? action.target.position : undefined;
    if (!segment || !position || !segment.requiredWaterVoxels.some((candidate) => samePosition(candidate, position))) {
      return { status: 'blocked' as const, result: '观察目标不是所指水流边的实体水体', diff: {} };
    }
    const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
    if (Math.abs(position.z - person.position.z) > perceptionRadius) {
      return { status: 'blocked' as const, result: '所指水流在垂直方向超出本人感知范围', diff: {} };
    }
    const availability = waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, segment.id);
    if (!availability.available
      || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Water) {
      return { status: 'blocked' as const, result: '所指水流当前没有可感知的有效流动', diff: {} };
    }
    const factId = waterCurrentObservationFactId(segment.id);
    const summary = '观察到这段流水当前能持续向下游传递动力';
    const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
    if (existing) {
      existing.confidence = clamp(Math.max(existing.confidence, 58) + 12);
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: factId,
      kind: 'observation',
      summary,
      confidence: 68,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
    return {
      status: 'completed' as const,
      result: summary,
      diff: {
        factId,
        mechanicalPowerObservation: true,
        waterCurrentSegmentId: segment.id,
        availableCapacity: availability.availableCapacity,
        supportingSegmentIds: [...availability.supportingSegmentIds],
        sourceKeys: [...segment.sourceKeys],
        observedPosition: { ...position },
      },
    };
  }
  if (action.mechanicalPowerFaultObservation) {
    const ref = action.mechanicalPowerFaultObservation;
    const installationProject = projectById(state, ref.installationProjectId);
    const plan = installationProject?.mechanicalPowerPlan;
    const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === ref.networkId
      && candidate.planKey === ref.planKey
      && candidate.installationProjectId === ref.installationProjectId);
    const fault = network?.fault;
    const position = action.target.kind === 'voxel' ? action.target.position : undefined;
    const faultEvent = fault ? worldEventById(state, fault.faultEventId) : undefined;
    const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
    if (ref.version !== 'mechanical-power-fault-observation-v1'
      || installationProject?.status !== 'completed'
      || installationProject.desiredFunction !== 'water-powered-crop-processing'
      || !plan
      || plan.projectId !== installationProject.id
      || installationProject.mechanicalPowerPlanKey !== mechanicalPowerPlanKey(plan)
      || installationProject.mechanicalPowerNetworkId !== ref.networkId
      || !network
      || !fault
      || fault.faultEventId !== ref.faultEventId
      || fault.kind !== 'worn-drive-shaft'
      || faultEvent?.kind !== 'action'
      || faultEvent.diff.mechanicalPowerFault !== true
      || faultEvent.diff.networkId !== network.id
      || !position
      || !samePosition(position, fault.componentPosition)
      || distanceToPosition(person, position) > perceptionRadius
      || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.BrokenDriveShaft) {
      return { status: 'blocked' as const, result: '眼前实体断轴与所指完成网络的当前磨损故障不一致', diff: {} };
    }
    const factId = mechanicalPowerFaultObservationFactId(network.id, fault.faultEventId);
    const summary = '观察并诊断出负载磨损导致传动轴断裂，网络因此停转';
    const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
    if (existing) {
      existing.confidence = clamp(Math.max(existing.confidence, 60) + 10);
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, fault.faultEventId, eventId])].slice(-24);
    } else person.knowledge.push({
      id: factId,
      kind: 'observation',
      summary,
      confidence: 68,
      learnedAtMonth: atMonth,
      sourceEventIds: [fault.faultEventId, eventId],
    });
    return {
      status: 'completed' as const,
      result: summary,
      diff: {
        factId,
        mechanicalPowerFaultDiagnosis: true,
        installationProjectId: installationProject.id,
        networkId: network.id,
        planKey: network.planKey,
        faultEventId: fault.faultEventId,
        faultKind: fault.kind,
        componentPosition: { ...fault.componentPosition },
      },
    };
  }
  let factId = `target:${JSON.stringify(action.target)}`;
  let summary = '持续观察了一个对象';
  if (action.target.kind === 'animal') {
    const animalId = action.target.animalId;
    const animal = state.world.animals.find((candidate) => candidate.id === animalId && isAnimalAlive(candidate));
    if (!animal) return { status: 'blocked' as const, result: '要观察的动物已经不在', diff: {} };
    factId = `animal:${animal.speciesId}`;
    summary = `观察并辨认了${animalSpecies(animal.speciesId).name}的行为`;
  }
  if (action.target.kind === 'inventory-stack' && action.target.personId === person.id) {
    const attendedStackId = action.target.stackId;
    const stack = person.inventory.find((candidate) => candidate.id === attendedStackId);
    if (!stack) return { status: 'blocked' as const, result: '观察对象已经不在背包中', diff: {} };
    const requestedVerification = action.verification;
    const sourceBoundTechnique = requestedVerification
      ? person.knowledge.find((fact) => fact.id === requestedVerification.techniqueId
        && fact.kind === 'technique'
        && fact.sourceEventIds.includes(requestedVerification.sourceEventId))
      : undefined;
    if (requestedVerification
      && sourceBoundTechnique
      && stack.materialId === requestedVerification.expectedMaterialId
      && stack.sourceEventIds.includes(requestedVerification.sourceEventId)) {
      sourceBoundTechnique.confidence = clamp(Math.max(sourceBoundTechnique.confidence, 46) + 22);
      sourceBoundTechnique.sourceEventIds = [...new Set([
        ...sourceBoundTechnique.sourceEventIds,
        eventId,
      ])].slice(-24);
      return {
        status: 'completed' as const,
        result: `核验了${sourceBoundTechnique.summary}`,
        diff: {
          factId: sourceBoundTechnique.id,
          verifiedTechnique: true,
          verifiedSourceEventId: requestedVerification.sourceEventId,
          verifiedMaterialId: stack.materialId,
          verifiedStackId: stack.id,
        },
      };
    }
    const record = stack.recordPayloadId ? state.records.find((candidate) => candidate.id === stack.recordPayloadId) : undefined;
    if (record) {
      let codebook = person.knowledge.find((fact) => fact.id === record.codebookId
        && fact.kind === 'codebook'
        && fact.confidence >= 55);
      let selfDecodedCodebook = false;
      const recordUseIntent = intentId ? intentById(state, intentId) : undefined;
      const selfDecodeBasis = recordUseIntent?.status === 'active'
        && (recordUseIntent.recordUseBasis?.version === 'record-use-basis-v2'
          || recordUseIntent.recordUseBasis?.version === 'record-use-basis-v3')
        && recordUseIntent.recordUseBasis.readerId === person.id
        && recordUseIntent.recordUseBasis.recordId === record.id
        && recordUseIntent.recordUseBasis.knowledgeId === record.knowledgeId
        && recordUseIntent.recordUseBasis.codebookId === record.codebookId
        ? recordUseIntent.recordUseBasis
        : undefined;
      if (!codebook
        && selfDecodeBasis
        && record.kind === 'technique'
        && record.authorId !== person.id) {
        const existingCodebook = person.knowledge.find((fact) => fact.id === record.codebookId);
        if (!existingCodebook) {
          person.knowledge.push({
            id: record.codebookId,
            kind: 'codebook',
            summary: `能辨认“${record.summary}”所用实体刻痕的符号约定`,
            confidence: 58,
            learnedAtMonth: atMonth,
            sourceEventIds: [...new Set([record.id, ...record.sourceEventIds, eventId])].slice(-24),
          });
          codebook = person.knowledge.at(-1);
          selfDecodedCodebook = true;
        } else if (existingCodebook.kind === 'codebook') {
          existingCodebook.confidence = Math.max(existingCodebook.confidence, 58);
          existingCodebook.sourceEventIds = [...new Set([
            ...existingCodebook.sourceEventIds,
            record.id,
            ...record.sourceEventIds,
            eventId,
          ])].slice(-24);
          codebook = existingCodebook;
          selfDecodedCodebook = true;
        }
      }
      if (!codebook) return {
        status: 'completed' as const,
        result: '看见木制记录板上的规则刻痕，但还不知道这些符号表示什么',
        diff: { recordPayloadId: record.id, understood: false },
      };
      const known = person.knowledge.find((fact) => fact.id === record.knowledgeId);
      const preservesReliableTechnique = selfDecodeBasis?.version === 'record-use-basis-v3'
        && selfDecodeBasis.purpose === 'replicate'
        && known?.kind === 'technique'
        && known.confidence >= 55;
      if (known) {
        known.confidence = known.kind === 'technique'
          ? preservesReliableTechnique
            ? known.confidence
            : Math.min(54, Math.max(46, known.confidence + 8))
          : clamp(known.confidence + 8);
        known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId, record.id])].slice(-24);
      } else person.knowledge.push({
        id: record.knowledgeId,
        kind: record.kind === 'technique' ? 'technique' : 'claim',
        summary: record.summary,
        confidence: record.kind === 'technique' ? 46 : 52,
        learnedAtMonth: atMonth,
        sourceEventIds: [record.id, eventId],
      });
      return {
        status: 'completed' as const,
        result: `${selfDecodedCodebook ? '辨认刻痕并' : ''}阅读木制记录板：${record.summary}`,
        diff: {
          recordPayloadId: record.id,
          learnedFactId: record.knowledgeId,
          understood: true,
          ...(selfDecodedCodebook ? {
            selfDecodedCodebook: true,
            learnedCodebookId: codebook.id,
            learnedCodebookConfidence: codebook.confidence,
          } : {}),
        },
      };
    }
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = worldEventById(state, sourceId);
      return source?.kind === 'action'
        && source.action.kind === 'act'
        && (source.action.operation === 'combine' || source.action.operation === 'exert' || source.action.operation === 'expose')
        && source.diff.outputStackId === stack.id
        && Number(source.diff.outputMaterialId) === stack.materialId;
    }));
    if (tentativeTechnique) {
      tentativeTechnique.confidence = clamp(tentativeTechnique.confidence + 22);
      tentativeTechnique.sourceEventIds = [...new Set([...tentativeTechnique.sourceEventIds, eventId])].slice(-24);
      return { status: 'completed' as const, result: `核验了${tentativeTechnique.summary}`, diff: { factId: tentativeTechnique.id, verifiedTechnique: true } };
    }
    factId = `material:${stack.materialId}`;
    summary = `观察并辨认了${materialDefinition(stack.materialId).name}`;
  }
  if (action.target.kind === 'voxel') {
    const attendedPosition = action.target.position;
    const materialId = voxelAt(state.world.grid, attendedPosition.x, attendedPosition.y, attendedPosition.z);
    if (materialId !== Material.Air) rememberMaterialPlace(person, materialId, attendedPosition, atMonth, eventId);
    const requestedVerification = action.verification;
    const sourceBoundTechnique = requestedVerification
      ? person.knowledge.find((fact) => fact.id === requestedVerification.techniqueId
        && fact.kind === 'technique'
        && fact.sourceEventIds.includes(requestedVerification.sourceEventId))
      : undefined;
    if (requestedVerification
      && sourceBoundTechnique
      && materialId === requestedVerification.expectedMaterialId) {
      sourceBoundTechnique.confidence = clamp(Math.max(sourceBoundTechnique.confidence, 46) + 22);
      sourceBoundTechnique.sourceEventIds = [...new Set([
        ...sourceBoundTechnique.sourceEventIds,
        eventId,
      ])].slice(-24);
      return {
        status: 'completed' as const,
        result: `核验了${sourceBoundTechnique.summary}`,
        diff: {
          factId: sourceBoundTechnique.id,
          verifiedTechnique: true,
          verifiedSourceEventId: requestedVerification.sourceEventId,
          verifiedMaterialId: materialId,
          verifiedPosition: { ...attendedPosition },
        },
      };
    }
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = worldEventById(state, sourceId);
      if (source?.kind !== 'action' || source.action.kind !== 'act' || !['combine', 'exert', 'expose'].includes(source.action.operation)) return false;
      const position = source.diff.position as VoxelPosition | undefined;
      return position?.x === attendedPosition.x
        && position.y === attendedPosition.y
        && position.z === attendedPosition.z
        && Number(source.diff.outputMaterialId) === materialId;
    }));
    if (tentativeTechnique) {
      tentativeTechnique.confidence = clamp(tentativeTechnique.confidence + 22);
      tentativeTechnique.sourceEventIds = [...new Set([...tentativeTechnique.sourceEventIds, eventId])].slice(-24);
      return { status: 'completed' as const, result: `核验了${tentativeTechnique.summary}`, diff: { factId: tentativeTechnique.id, verifiedTechnique: true } };
    }
    factId = `material:${materialId}`;
    summary = `观察并辨认了${materialDefinition(materialId).name}`;
  }
  const existing = person.knowledge.find((fact) => fact.id === factId);
  if (existing) {
    existing.confidence = clamp(existing.confidence + 12);
    existing.sourceEventIds.push(eventId);
  } else {
    person.knowledge.push({ id: factId, kind: 'observation', summary, confidence: 58, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  }
  return { status: 'completed' as const, result: summary, diff: { factId } };
}
