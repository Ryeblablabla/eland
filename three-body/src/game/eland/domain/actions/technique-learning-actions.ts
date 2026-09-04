import type { PrimitiveAction } from '../action';
import type { MaterialId } from '../material';
import type { SimulationState } from '../model';
import { isAlive, type PersonState } from '../person';
import type { ProjectState, ProjectTechniqueDemonstrationBasis } from '../project';
import { worldEventById } from '../event-index';
import {
  describeTechniqueAction,
  techniqueSupportsProjectFunction,
  type TechniqueActionDescriptor,
} from '../technique-demonstration';
import { personById, projectById } from '../state-index';
import { cellX, cellY } from '../../world/grid';
import { languageInterpreterIds } from '../language-perception';

function canObserveTechniqueDemonstration(observer: PersonState, actor: PersonState): boolean {
  const radius = 4 + Math.floor(observer.baselineCapacities.perception / 25);
  const horizontal = Math.abs(cellX(observer.position.cellId) - cellX(actor.position.cellId))
    + Math.abs(cellY(observer.position.cellId) - cellY(actor.position.cellId));
  return horizontal <= radius && Math.abs(observer.position.z - actor.position.z) <= 2;
}


export type TechniqueLearningValidation =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'demonstration';
      descriptor: TechniqueActionDescriptor;
      project: ProjectState;
      learner: PersonState;
      demonstratorId: string;
      requestEventId: string;
    }
  | {
      kind: 'imitation';
      descriptor: TechniqueActionDescriptor;
      project: ProjectState;
      basis: ProjectTechniqueDemonstrationBasis;
      learner: PersonState;
      confidenceBefore: number;
    };

function sameMaterials(first: MaterialId[], second: MaterialId[]): boolean {
  return [...first].sort((left, right) => left - right).join(',')
    === [...second].sort((left, right) => left - right).join(',');
}

export function validateTechniqueLearningAction(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
): TechniqueLearningValidation {
  if (!action.techniqueDemonstration && !action.techniqueImitation) return { kind: 'none' };
  if (action.techniqueDemonstration && action.techniqueImitation) {
    return { kind: 'blocked', reason: '同一操作不能同时作为示范和模仿' };
  }
  const descriptor = describeTechniqueAction(state, person, action);
  if (!descriptor) return { kind: 'blocked', reason: '示范或模仿没有绑定当前可执行的权威物质操作' };

  if (action.techniqueDemonstration) {
    const ref = action.techniqueDemonstration;
    if (descriptor.techniqueId !== ref.techniqueId) {
      return { kind: 'blocked', reason: '实际操作与请求绑定的技术不一致' };
    }
    const requestEvent = worldEventById(state, ref.requestEventId);
    const historicalRequest = requestEvent?.kind === 'action'
      && requestEvent.status === 'completed'
      && requestEvent.action.kind === 'talk'
      && requestEvent.action.speakerMeaning.kind === 'request'
      && requestEvent.action.speakerMeaning.techniqueDemonstration
      ? requestEvent.action.speakerMeaning.techniqueDemonstration
      : null;
    const requestProject = projectById(state, ref.projectId);
    const pendingRequest = requestProject?.techniqueDemonstrationRequests?.find((candidate) => (
      candidate.requestEventId === ref.requestEventId
    ));
    const request = historicalRequest ?? pendingRequest;
    if (!request) {
      return { kind: 'blocked', reason: '找不到已完成且有明确项目的技术示范请求' };
    }
    const requesterId = historicalRequest && requestEvent?.kind === 'action'
      ? requestEvent.who
      : pendingRequest?.requesterId;
    const addressedTeacherIds = historicalRequest && requestEvent?.kind === 'action'
      && requestEvent.action.kind === 'talk'
      ? languageInterpreterIds(requestEvent.diff, requestEvent.action.speakerMeaning.id)
      : pendingRequest?.teacherIds ?? [];
    if (requesterId !== request.requesterId
      || !addressedTeacherIds.includes(person.id)
      || request.projectId !== ref.projectId
      || request.requesterId !== ref.learnerId
      || request.expiresAtMonth < atMonth) {
      return { kind: 'blocked', reason: '技术示范请求的人员、项目或有效期不匹配' };
    }
    const projectCandidate = projectById(state, ref.projectId);
    const project = projectCandidate?.status === 'active'
      && projectCandidate.kind === 'inquiry'
      && projectCandidate.ownerId === ref.learnerId
      && projectCandidate.desiredFunction === request.desiredFunction
      ? projectCandidate
      : undefined;
    const learnerCandidate = personById(state, ref.learnerId);
    const learner = learnerCandidate && isAlive(learnerCandidate) ? learnerCandidate : undefined;
    if (!project || !learner || !canObserveTechniqueDemonstration(learner, person)) {
      return { kind: 'blocked', reason: '项目、学习者或可观察范围已经失效' };
    }
    if (project.techniqueDemonstrations?.some((basis) => basis.requestEventId === ref.requestEventId)) {
      return { kind: 'blocked', reason: '这项请求已经得到一次真实示范' };
    }
    const teacherKnowledge = person.knowledge.find((fact) => fact.id === ref.techniqueId
      && fact.kind === 'technique'
      && fact.confidence >= 55);
    if (!teacherKnowledge || !techniqueSupportsProjectFunction(ref.techniqueId, request.desiredFunction)) {
      return { kind: 'blocked', reason: '示范者没有与项目功能匹配的可靠技术' };
    }
    return {
      kind: 'demonstration',
      descriptor,
      project,
      learner,
      demonstratorId: person.id,
      requestEventId: ref.requestEventId,
    };
  }

  const ref = action.techniqueImitation!;
  const projectCandidate = projectById(state, ref.projectId);
  const project = projectCandidate?.status === 'active' && projectCandidate.ownerId === person.id
    ? projectCandidate
    : undefined;
  const basis = project?.techniqueDemonstrations?.find((candidate) => (
    candidate.demonstrationEventId === ref.demonstrationEventId
      && candidate.techniqueId === ref.techniqueId
      && candidate.learnerId === person.id
  ));
  if (!project || !basis) return { kind: 'blocked', reason: '模仿没有绑定本人项目中的真实示范' };
  const tentative = person.knowledge.find((fact) => fact.id === ref.techniqueId
    && fact.kind === 'technique'
    && fact.sourceEventIds.includes(ref.demonstrationEventId));
  if (!tentative || tentative.confidence >= 55) {
    return { kind: 'blocked', reason: tentative ? '这项技术已经可靠，不再需要冒充首次模仿' : '本人尚未从该示范形成暂定经验' };
  }
  if (descriptor.techniqueId !== ref.techniqueId
    || descriptor.operation !== basis.operation
    || descriptor.outputMaterialId !== basis.outputMaterialId
    || descriptor.toolMaterialId !== basis.toolMaterialId
    || descriptor.targetMaterialId !== basis.targetMaterialId
    || !sameMaterials(descriptor.inputMaterialIds, basis.inputMaterialIds)) {
    return { kind: 'blocked', reason: '本人的复现没有保持示范中的输入、工具、目标与响应关系' };
  }
  return { kind: 'imitation', descriptor, project, basis, learner: person, confidenceBefore: tentative.confidence };
}

export function applyTechniqueLearning(
  validation: TechniqueLearningValidation,
  outcome: { status: 'progressed' | 'completed' | 'blocked' | 'failed'; result: string; diff: Record<string, unknown> },
  eventId: string,
  atMonth: number,
): void {
  if (outcome.status !== 'completed') return;
  if (validation.kind === 'demonstration') {
    // Entity identity is carried by sourceKeys. Event lineage stays resolvable:
    // the request and this real response are both committed to world.past.
    const sourceFactIds = [validation.requestEventId, eventId];
    let learned = validation.learner.knowledge.find((fact) => fact.id === validation.descriptor.techniqueId);
    const confidenceBefore = learned?.confidence ?? 0;
    if (learned) {
      learned.confidence = Math.min(54, Math.max(46, learned.confidence));
      learned.sourceEventIds = [...new Set([...learned.sourceEventIds, ...sourceFactIds])].slice(-24);
    } else {
      learned = {
        id: validation.descriptor.techniqueId,
        kind: 'technique',
        summary: validation.descriptor.summary,
        confidence: 46,
        learnedAtMonth: atMonth,
        sourceEventIds: sourceFactIds.slice(-24),
      };
      validation.learner.knowledge.push(learned);
    }
    const basis: ProjectTechniqueDemonstrationBasis = {
      version: 'project-technique-demonstration-basis-v1',
      projectId: validation.project.id,
      desiredFunction: validation.project.desiredFunction,
      learnerId: validation.learner.id,
      demonstratorId: validation.demonstratorId,
      requestEventId: validation.requestEventId,
      demonstrationEventId: eventId,
      techniqueId: validation.descriptor.techniqueId,
      operation: validation.descriptor.operation,
      inputMaterialIds: [...validation.descriptor.inputMaterialIds],
      ...(validation.descriptor.toolMaterialId !== undefined
        ? { toolMaterialId: validation.descriptor.toolMaterialId }
        : {}),
      ...(validation.descriptor.targetMaterialId !== undefined
        ? { targetMaterialId: validation.descriptor.targetMaterialId }
        : {}),
      outputMaterialId: validation.descriptor.outputMaterialId,
      sourceKeys: [...validation.descriptor.sourceKeys],
      sourceFactIds,
      initialConfidence: learned.confidence,
      atMonth,
    };
    validation.project.techniqueDemonstrations ??= [];
    validation.project.techniqueDemonstrations.push(basis);
    outcome.diff = {
      ...outcome.diff,
      techniqueLearningStage: 'demonstration',
      techniqueId: validation.descriptor.techniqueId,
      techniqueProjectId: validation.project.id,
      techniqueLearnerId: validation.learner.id,
      techniqueRequestEventId: validation.requestEventId,
      techniqueDemonstratorId: basis.demonstratorId,
      techniqueSourceKeys: [...validation.descriptor.sourceKeys],
      techniqueConfidenceBefore: confidenceBefore,
      techniqueConfidenceAfter: learned.confidence,
    };
    return;
  }
  if (validation.kind === 'imitation') {
    const confidenceAfter = validation.learner.knowledge
      .find((fact) => fact.id === validation.descriptor.techniqueId)?.confidence ?? 0;
    outcome.diff = {
      ...outcome.diff,
      techniqueLearningStage: 'imitation',
      techniqueId: validation.descriptor.techniqueId,
      techniqueProjectId: validation.project.id,
      techniqueLearnerId: validation.basis.learnerId,
      techniqueDemonstrationEventId: validation.basis.demonstrationEventId,
      techniqueImitationSourceKeys: [...validation.descriptor.sourceKeys],
      techniqueConfidenceBefore: validation.confidenceBefore,
      techniqueConfidenceAfter: confidenceAfter,
    };
  }
}
