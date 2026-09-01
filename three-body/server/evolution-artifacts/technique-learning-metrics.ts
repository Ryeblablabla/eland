import type { SimulationState } from '../../src/game/eland/simulation';
import { Material, materialDefinition, materialHas } from '../../src/game/eland/domain/material';
import { objectRecord } from './object-record';

export function techniqueLearningMetrics(state: SimulationState) {
  type LearningOperation = 'combine' | 'exert' | 'expose';
  type TechniqueSignature = {
    operation: LearningOperation;
    inputMaterialIds: number[];
    toolMaterialId: number | null;
    targetMaterialId: number | null;
    outputMaterialId: number;
  };
  type IndexedRecord = { value: Record<string, unknown>; index: number; key: string };
  type BasisAudit = {
    key: string;
    project: Record<string, unknown>;
    projectId: string | null;
    learnerId: string | null;
    demonstratorId: string | null;
    techniqueId: string | null;
    requestEventId: string | null;
    demonstrationEventId: string | null;
    demonstrationIndex: number | null;
    signature: TechniqueSignature | null;
    valid: boolean;
    exactSource: boolean;
    tentative: boolean;
  };
  type ImitationAudit = {
    key: string;
    event: Record<string, unknown>;
    eventIndex: number;
    basis: BasisAudit | null;
    valid: boolean;
    exactSource: boolean;
  };

  const rawState = state as unknown as {
    people?: unknown;
    projects?: unknown;
    records?: unknown;
    world?: { past?: unknown };
  };
  const indexedRecords = (value: unknown): IndexedRecord[] => (
    Array.isArray(value)
      ? value.flatMap((item, index) => {
        const record = objectRecord(item);
        if (!record) return [];
        const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : `#${index}`;
        return [{ value: record, index, key: id }];
      })
      : []
  );
  const records = (value: unknown): Record<string, unknown>[] => (
    Array.isArray(value)
      ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
      : []
  );
  const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const integerValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isInteger(value) ? value : null
  );
  const finiteValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  const exactStringKeys = (value: unknown): string[] | null => {
    if (!Array.isArray(value)
      || !value.every((item) => typeof item === 'string' && item.length > 0)) return null;
    const keys = value as string[];
    return new Set(keys).size === keys.length ? keys : null;
  };
  const stringKeys = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  );
  const exactIntegerValues = (value: unknown): number[] | null => (
    Array.isArray(value) && value.every((item) => Number.isInteger(item))
      ? value as number[]
      : null
  );
  const coverage = (covered: number, total: number): number => (
    total ? Math.round(covered / total * 10_000) / 100 : 100
  );
  const sameStrings = (left: string[], right: string[]): boolean => {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length
      && sortedLeft.every((value, index) => value === sortedRight[index]);
  };
  const sameMaterials = (left: number[], right: number[]): boolean => {
    const sortedLeft = [...left].sort((a, b) => a - b);
    const sortedRight = [...right].sort((a, b) => a - b);
    return sortedLeft.length === sortedRight.length
      && sortedLeft.every((value, index) => value === sortedRight[index]);
  };
  const operationValue = (value: unknown): LearningOperation | null => (
    value === 'combine' || value === 'exert' || value === 'expose' ? value : null
  );
  const parseMaterial = (value: string): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const parseTechnique = (techniqueId: string | null): TechniqueSignature | null => {
    if (!techniqueId) return null;
    const inventoryPrefix = 'technique:combine-inventory:';
    if (techniqueId.startsWith(inventoryPrefix)) {
      const [inputKey, outputKey, ...rest] = techniqueId.slice(inventoryPrefix.length).split(':');
      const outputMaterialId = parseMaterial(outputKey ?? '');
      if (!inputKey || outputMaterialId === null || rest.length > 0) return null;
      const inputMaterialIds: number[] = [];
      for (const token of inputKey.split('+')) {
        const match = /^(\d+)x(\d+)$/.exec(token);
        const materialId = match ? parseMaterial(match[1]) : null;
        const quantity = match ? parseMaterial(match[2]) : null;
        if (materialId === null || quantity === null || quantity <= 0) return null;
        inputMaterialIds.push(...Array.from({ length: quantity }, () => materialId));
      }
      return {
        operation: 'combine',
        inputMaterialIds,
        toolMaterialId: null,
        targetMaterialId: null,
        outputMaterialId,
      };
    }
    const parts = techniqueId.split(':');
    if (parts[0] !== 'technique') return null;
    if (parts[1] === 'combine' && parts.length === 5) {
      const values = parts.slice(2).map(parseMaterial);
      if (values.some((value) => value === null)) return null;
      return {
        operation: 'combine',
        inputMaterialIds: [values[0]!],
        toolMaterialId: null,
        targetMaterialId: values[1]!,
        outputMaterialId: values[2]!,
      };
    }
    if (parts[1] === 'exert' && parts.length === 6) {
      const values = parts.slice(2).map(parseMaterial);
      if (values.some((value) => value === null)) return null;
      return {
        operation: 'exert',
        inputMaterialIds: [values[1]!],
        toolMaterialId: values[0]!,
        targetMaterialId: values[2]!,
        outputMaterialId: values[3]!,
      };
    }
    if (parts[1] === 'expose' && parts.length === 5) {
      const values = parts.slice(2).map(parseMaterial);
      if (values.some((value) => value === null)) return null;
      return {
        operation: 'expose',
        inputMaterialIds: [values[0]!],
        toolMaterialId: null,
        targetMaterialId: values[1]!,
        outputMaterialId: values[2]!,
      };
    }
    return null;
  };
  const basisSignature = (basis: Record<string, unknown>): TechniqueSignature | null => {
    const operation = operationValue(basis.operation);
    const inputMaterialIds = exactIntegerValues(basis.inputMaterialIds);
    const outputMaterialId = integerValue(basis.outputMaterialId);
    if (!operation || !inputMaterialIds?.length || outputMaterialId === null) return null;
    return {
      operation,
      inputMaterialIds,
      toolMaterialId: integerValue(basis.toolMaterialId),
      targetMaterialId: integerValue(basis.targetMaterialId),
      outputMaterialId,
    };
  };
  const signaturesMatch = (left: TechniqueSignature, right: TechniqueSignature): boolean => (
    left.operation === right.operation
      && sameMaterials(left.inputMaterialIds, right.inputMaterialIds)
      && left.toolMaterialId === right.toolMaterialId
      && left.targetMaterialId === right.targetMaterialId
      && left.outputMaterialId === right.outputMaterialId
  );
  const actionRecord = (event: Record<string, unknown>): Record<string, unknown> | null => (
    event.kind === 'action' ? objectRecord(event.action) : null
  );
  const diffRecord = (event: Record<string, unknown>): Record<string, unknown> => (
    objectRecord(event.diff) ?? {}
  );
  const responseSignature = (event: Record<string, unknown>): TechniqueSignature | null => {
    const action = actionRecord(event);
    const diff = diffRecord(event);
    const operation = action?.kind === 'act' ? operationValue(action.operation) : null;
    const outputMaterialId = integerValue(diff.outputMaterialId);
    if (!operation || outputMaterialId === null) return null;
    const inputMaterialIds = exactIntegerValues(diff.inputMaterialIds)
      ?? (integerValue(diff.inputMaterialId) === null ? null : [integerValue(diff.inputMaterialId)!]);
    if (!inputMaterialIds?.length) return null;
    return {
      operation,
      inputMaterialIds,
      toolMaterialId: integerValue(diff.toolMaterialId),
      targetMaterialId: integerValue(diff.targetMaterialId),
      outputMaterialId,
    };
  };
  const basicLearningResponse = (
    event: Record<string, unknown>,
    stage: 'demonstration' | 'imitation',
  ): boolean => {
    const action = actionRecord(event);
    const diff = diffRecord(event);
    return event.status === 'completed'
      && action?.kind === 'act'
      && operationValue(action.operation) !== null
      && diff.techniqueLearningStage === stage
      && stringValue(diff.techniqueId) !== null
      && stringValue(diff.techniqueProjectId) !== null
      && stringValue(diff.techniqueLearnerId) !== null
      && stringValue(diff.sourceEventId) === stringValue(event.id)
      && responseSignature(event) !== null;
  };
  const requestPayload = (content: Record<string, unknown> | null): Record<string, unknown> | null => (
    objectRecord(content?.techniqueDemonstration)
      ?? objectRecord(objectRecord(content?.request)?.techniqueDemonstration)
  );
  const sourceKeyActor = (sourceKey: string): string | null => (
    /^inventory:([^:]+):/.exec(sourceKey)?.[1] ?? null
  );
  const physicalActionSourceKeys = (event: Record<string, unknown>): { keys: string[]; complete: boolean } => {
    const action = actionRecord(event);
    const diff = diffRecord(event);
    if (action?.kind !== 'act' || !operationValue(action.operation)) return { keys: [], complete: false };
    const targets = records(action.targets);
    const keys: string[] = [];
    let complete = true;
    for (const target of targets) {
      if (target.kind === 'inventory-stack') {
        const personId = stringValue(target.personId);
        const stackId = stringValue(target.stackId);
        if (!personId || !stackId) complete = false;
        else keys.push(`inventory:${personId}:${stackId}`);
      } else if (target.kind === 'voxel') {
        const position = objectRecord(target.position);
        const x = integerValue(position?.x);
        const y = integerValue(position?.y);
        const z = integerValue(position?.z);
        const materialId = integerValue(diff.targetMaterialId);
        if (x === null || y === null || z === null || materialId === null) complete = false;
        else keys.push(`voxel:${x}:${y}:${z}:${materialId}`);
      }
    }
    const toolStackId = stringValue(action.toolStackId);
    const actorId = stringValue(event.who);
    if (toolStackId && actorId) keys.push(`inventory:${actorId}:${toolStackId}`);
    else if (toolStackId) complete = false;
    return { keys: [...new Set(keys)], complete: complete && keys.length > 0 };
  };
  const supportsFunction = (desiredFunction: string | null, outputMaterialId: number | null): boolean => {
    if (!desiredFunction || outputMaterialId === null) return false;
    if (desiredFunction === 'insulation') return materialHas(outputMaterialId, 'insulating');
    if (desiredFunction === 'safer-hunting') return materialHas(outputMaterialId, 'tool');
    if (desiredFunction === 'healing') return (materialDefinition(outputMaterialId).consume?.health ?? 0) > 0;
    if (desiredFunction === 'prepared-food') {
      return outputMaterialId === Material.CookedFood || materialHas(outputMaterialId, 'hot');
    }
    if (desiredFunction === 'durable-record') return materialHas(outputMaterialId, 'recordable');
    return false;
  };

  const people = indexedRecords(rawState.people);
  const projects = indexedRecords(rawState.projects);
  const sourceRecords = indexedRecords(rawState.records);
  const events = indexedRecords(rawState.world?.past);
  const personById = new Map(people.flatMap((entry) => {
    const id = stringValue(entry.value.id);
    return id ? [[id, entry.value] as const] : [];
  }));
  const projectEntriesById = new Map<string, IndexedRecord[]>();
  for (const entry of projects) {
    const id = stringValue(entry.value.id);
    if (!id) continue;
    const matches = projectEntriesById.get(id) ?? [];
    matches.push(entry);
    projectEntriesById.set(id, matches);
  }
  const eventById = new Map(events.flatMap((entry) => {
    const id = stringValue(entry.value.id);
    return id ? [[id, entry] as const] : [];
  }));
  const sourceRecordById = new Map(sourceRecords.flatMap((entry) => {
    const id = stringValue(entry.value.id);
    return id ? [[id, entry.value] as const] : [];
  }));
  const actionPositionsByPerson = new Map<string, Array<{ index: number; cellId: number; z: number }>>();
  for (const entry of events) {
    if (entry.value.kind !== 'action') continue;
    const personId = stringValue(entry.value.who);
    const cellId = integerValue(entry.value.toCellId);
    const z = integerValue(entry.value.toZ);
    if (!personId || cellId === null || z === null) continue;
    const positions = actionPositionsByPerson.get(personId) ?? [];
    positions.push({ index: entry.index, cellId, z });
    actionPositionsByPerson.set(personId, positions);
  }
  const positionBefore = (personId: string | null, eventIndex: number | null) => {
    if (!personId || eventIndex === null) return null;
    const positions = actionPositionsByPerson.get(personId) ?? [];
    let low = 0;
    let high = positions.length - 1;
    let match: { index: number; cellId: number; z: number } | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (positions[middle].index < eventIndex) {
        match = positions[middle];
        low = middle + 1;
      } else high = middle - 1;
    }
    return match;
  };
  const reliableTechnique = (personId: string | null, techniqueId: string | null) => {
    const person = personId ? personById.get(personId) : null;
    return records(person?.knowledge).find((fact) => fact.id === techniqueId
      && fact.kind === 'technique'
      && (finiteValue(fact.confidence) ?? -Infinity) >= 55) ?? null;
  };

  const requestAttempts: Array<{
    entry: IndexedRecord;
    action: Record<string, unknown>;
    content: Record<string, unknown>;
    request: Record<string, unknown> | null;
    audienceIds: string[];
  }> = [];
  for (const entry of events) {
    const action = actionRecord(entry.value);
    const content = objectRecord(action?.speakerMeaning);
    if (action?.kind !== 'talk' || content?.kind !== 'request') continue;
    const directMarker = Object.prototype.hasOwnProperty.call(content, 'techniqueDemonstration');
    const nestedMarker = Object.prototype.hasOwnProperty.call(objectRecord(content.request) ?? {}, 'techniqueDemonstration');
    if (!directMarker && !nestedMarker) continue;
    requestAttempts.push({
      entry,
      action,
      content,
      request: requestPayload(content),
      audienceIds: stringKeys(action.audience),
    });
  }
  const requestByEventId = new Map(requestAttempts.flatMap((request) => {
    const eventId = stringValue(request.entry.value.id);
    return eventId ? [[eventId, request] as const] : [];
  }));
  const requestPersonMismatches = new Set<string>();
  const requestProjectMismatches = new Set<string>();
  const requestFunctionMismatches = new Set<string>();
  const requestPairCounts = new Map<string, number>();
  for (const requestEntry of requestAttempts) {
    const { entry, request, audienceIds } = requestEntry;
    const requesterId = stringValue(request?.requesterId);
    const projectId = stringValue(request?.projectId);
    const desiredFunction = stringValue(request?.desiredFunction);
    const requestKey = entry.key;
    const projectMatches = projectId ? projectEntriesById.get(projectId) ?? [] : [];
    const project = projectMatches.length === 1 ? projectMatches[0].value : null;
    const uniqueAudienceIds = [...new Set(audienceIds)];
    if (!requesterId || requesterId !== entry.value.who || !personById.has(requesterId)
      || !audienceIds.length || uniqueAudienceIds.length !== audienceIds.length
      || audienceIds.some((audienceId) => audienceId === requesterId || !personById.has(audienceId))) {
      requestPersonMismatches.add(requestKey);
    }
    const createdAtMonth = integerValue(project?.createdAtMonth);
    const requestMonth = integerValue(entry.value.atMonth);
    if (!project || project.ownerId !== requesterId
      || project.kind !== 'inquiry'
      || createdAtMonth === null || requestMonth === null || createdAtMonth > requestMonth) {
      requestProjectMismatches.add(requestKey);
    }
    if (!desiredFunction || desiredFunction !== project?.desiredFunction) {
      requestFunctionMismatches.add(requestKey);
    }
    if (projectId) {
      for (const audienceId of uniqueAudienceIds) {
        const pairKey = `${projectId}\u0000${audienceId}`;
        requestPairCounts.set(pairKey, (requestPairCounts.get(pairKey) ?? 0) + 1);
      }
    }
  }
  const uniqueProjectTeachers = requestPairCounts.size;
  const duplicateRequests = [...requestPairCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  const demonstrationActions = events.filter((entry) => {
    const action = actionRecord(entry.value);
    const diff = diffRecord(entry.value);
    return objectRecord(action?.techniqueDemonstration) !== null
      || diff.techniqueLearningStage === 'demonstration';
  });
  const demonstrationResponses = demonstrationActions.filter((entry) => (
    basicLearningResponse(entry.value, 'demonstration')
  )).length;
  const unresolvedBases = new Set<string>();
  const unresolvedRequestEvents = new Set<string>();
  const unresolvedActionEvents = new Set<string>();
  const demonstratorMismatches = new Set<string>();
  const demonstratorReliabilityMismatches = new Set<string>();
  const learnerMismatches = new Set<string>();
  const projectMismatches = new Set<string>();
  const functionMismatches = new Set<string>();
  const colocationMismatches = new Set<string>();
  const techniqueMismatches = new Set<string>();
  const operationMismatches = new Set<string>();
  const responseMismatches = new Set<string>();
  const orderViolations = new Set<string>();
  const sourceMismatches = new Set<string>();
  const exactSourceMismatches = new Set<string>();
  const directReliableViolations = new Set<string>();
  for (const entry of demonstrationActions) {
    if ((finiteValue(diffRecord(entry.value).techniqueConfidenceAfter) ?? -Infinity) >= 55) {
      directReliableViolations.add(stringValue(entry.value.id) ?? entry.key);
    }
  }
  const basisAudits: BasisAudit[] = [];
  let demonstrationBases = 0;
  let sourcedBases = 0;
  let exactSourceBases = 0;
  let tentativeLessons = 0;

  for (const projectEntry of projects) {
    const project = projectEntry.value;
    const rawBases = Array.isArray(project.techniqueDemonstrations)
      ? project.techniqueDemonstrations
      : [];
    for (const [basisIndex, rawBasis] of rawBases.entries()) {
      demonstrationBases += 1;
      const key = `${stringValue(project.id) ?? projectEntry.key}\u0000basis:${basisIndex}`;
      const basis = objectRecord(rawBasis);
      if (!basis) {
        unresolvedBases.add(key);
        projectMismatches.add(key);
        sourceMismatches.add(key);
        responseMismatches.add(key);
        continue;
      }
      const projectId = stringValue(basis.projectId);
      const learnerId = stringValue(basis.learnerId);
      const demonstratorId = stringValue(basis.demonstratorId);
      const requestEventId = stringValue(basis.requestEventId);
      const demonstrationEventId = stringValue(basis.demonstrationEventId);
      const techniqueId = stringValue(basis.techniqueId);
      const desiredFunction = stringValue(basis.desiredFunction);
      const requestEntry = requestEventId ? requestByEventId.get(requestEventId) : null;
      const request = requestEntry?.request ?? null;
      const demonstrationEntry = demonstrationEventId ? eventById.get(demonstrationEventId) : null;
      const demonstrationEvent = demonstrationEntry?.value ?? null;
      const demonstrationAction = demonstrationEvent ? actionRecord(demonstrationEvent) : null;
      const demonstrationRef = objectRecord(demonstrationAction?.techniqueDemonstration);
      const demonstrationDiff = demonstrationEvent ? diffRecord(demonstrationEvent) : {};
      const signature = basisSignature(basis);
      const parsedTechnique = parseTechnique(techniqueId);
      const actualSignature = demonstrationEvent ? responseSignature(demonstrationEvent) : null;
      const requestResolved = Boolean(requestEntry && request);
      const demonstrationResolved = Boolean(demonstrationEntry
        && demonstrationEvent?.kind === 'action'
        && demonstrationAction?.kind === 'act');
      if (!requestResolved) unresolvedRequestEvents.add(key);
      if (!demonstrationResolved) unresolvedActionEvents.add(key);

      const requestPersonMatches = Boolean(requestResolved
        && requestEntry?.entry.value.status === 'completed'
        && request?.requesterId === learnerId
        && requestEntry?.entry.value.who === learnerId);
      const demonstratorMatches = Boolean(demonstratorId
        && demonstratorId !== learnerId
        && personById.has(demonstratorId)
        && requestEntry?.audienceIds.includes(demonstratorId)
        && demonstrationEvent?.who === demonstratorId
        && demonstrationRef?.requestEventId === requestEventId
        && demonstrationDiff.techniqueRequestEventId === requestEventId
        && demonstrationDiff.techniqueDemonstratorId === demonstratorId);
      if (!demonstratorMatches) demonstratorMismatches.add(key);
      const demonstrationMonth = integerValue(demonstrationEvent?.atMonth);
      const demonstratorFact = reliableTechnique(demonstratorId, techniqueId);
      const demonstratorReliable = Boolean(demonstratorFact
        && demonstrationMonth !== null
        && (integerValue(demonstratorFact.learnedAtMonth) ?? Infinity) <= demonstrationMonth);
      if (!demonstratorReliable) demonstratorReliabilityMismatches.add(key);
      const learnerMatches = Boolean(learnerId
        && personById.has(learnerId)
        && project.ownerId === learnerId
        && requestPersonMatches
        && demonstrationRef?.learnerId === learnerId
        && demonstrationDiff.techniqueLearnerId === learnerId);
      if (!learnerMatches) learnerMismatches.add(key);
      const projectActionEventIds = stringKeys(project.actionEventIds);
      const projectMatches = Boolean(projectId
        && projectId === project.id
        && project.kind === 'inquiry'
        && (projectEntriesById.get(projectId)?.length ?? 0) === 1
        && demonstrationRef?.projectId === projectId
        && demonstrationDiff.techniqueProjectId === projectId
        && request?.projectId === projectId
        && demonstrationEventId
        && projectActionEventIds.includes(demonstrationEventId));
      if (!projectMatches) projectMismatches.add(key);
      const functionMatches = Boolean(desiredFunction
        && desiredFunction === project.desiredFunction
        && request?.desiredFunction === desiredFunction
        && signature
        && supportsFunction(desiredFunction, signature.outputMaterialId));
      if (!functionMatches) functionMismatches.add(key);
      const teacherCell = integerValue(demonstrationEvent?.fromCellId);
      const teacherZ = integerValue(demonstrationEvent?.fromZ);
      const learnerPosition = positionBefore(learnerId, demonstrationEntry?.index ?? null);
      const learner = learnerId ? personById.get(learnerId) : null;
      const observationRadius = learner
        ? 4 + Math.floor((finiteValue(objectRecord(learner.baselineCapacities)?.perception) ?? 0) / 25)
        : -1;
      const observable = teacherCell !== null && teacherZ !== null && learnerPosition !== null
        && observationRadius >= 0
        && Math.abs((teacherCell % state.world.grid.width) - (learnerPosition.cellId % state.world.grid.width))
          + Math.abs(Math.floor(teacherCell / state.world.grid.width) - Math.floor(learnerPosition.cellId / state.world.grid.width)) <= observationRadius
        && Math.abs(teacherZ - learnerPosition.z) <= 2;
      if (!observable) colocationMismatches.add(key);
      const techniqueMatches = Boolean(techniqueId
        && demonstrationRef?.techniqueId === techniqueId
        && demonstrationDiff.techniqueId === techniqueId
        && signature
        && parsedTechnique
        && signaturesMatch(signature, parsedTechnique));
      if (!techniqueMatches) techniqueMismatches.add(key);
      const operationMatches = Boolean(signature
        && demonstrationAction?.operation === signature.operation
        && parsedTechnique?.operation === signature.operation);
      if (!operationMatches) operationMismatches.add(key);
      const responseMatches = Boolean(demonstrationEvent
        && signature
        && actualSignature
        && basicLearningResponse(demonstrationEvent, 'demonstration')
        && signaturesMatch(signature, actualSignature));
      if (!responseMatches) responseMismatches.add(key);
      const requestIndex = requestEntry?.entry.index ?? null;
      const demonstrationIndex = demonstrationEntry?.index ?? null;
      const requestMonth = integerValue(requestEntry?.entry.value.atMonth);
      const expiresAtMonth = integerValue(request?.expiresAtMonth);
      const basisMonth = integerValue(basis.atMonth);
      let orderMatches = requestIndex !== null && demonstrationIndex !== null
        && requestIndex < demonstrationIndex
        && requestMonth !== null && demonstrationMonth !== null
        && requestMonth <= demonstrationMonth
        && expiresAtMonth !== null && demonstrationMonth <= expiresAtMonth
        && basisMonth === demonstrationMonth;
      const basisSourceKeys = exactStringKeys(basis.sourceKeys);
      const basisSourceFactIds = exactStringKeys(basis.sourceFactIds);
      const sourceFactsResolve = Boolean(basisSourceFactIds?.length
        && basisSourceFactIds.every((sourceId) => (
          eventById.has(sourceId) || sourceRecordById.has(sourceId)
        )));
      if (sourceFactsResolve && demonstrationIndex !== null) {
        const futureSource = basisSourceFactIds!.some((sourceId) => {
          const sourceEvent = eventById.get(sourceId);
          if (sourceEvent) return sourceEvent.index > demonstrationIndex;
          const sourceRecordMonth = integerValue(sourceRecordById.get(sourceId)?.createdAtMonth);
          return sourceRecordMonth === null || demonstrationMonth === null
            || sourceRecordMonth > demonstrationMonth;
        });
        if (futureSource) orderMatches = false;
      }
      if (!orderMatches) orderViolations.add(key);
      const sourced = Boolean(basisSourceKeys?.length && sourceFactsResolve);
      if (sourced) sourcedBases += 1;
      else sourceMismatches.add(key);
      const diffSourceKeys = exactStringKeys(demonstrationDiff.techniqueSourceKeys);
      const physicalSources = demonstrationEvent
        ? physicalActionSourceKeys(demonstrationEvent)
        : { keys: [], complete: false };
      const exactSource = Boolean(sourced
        && diffSourceKeys?.length
        && physicalSources.complete
        && sameStrings(basisSourceKeys!, diffSourceKeys)
        && physicalSources.keys.every((sourceKey) => diffSourceKeys.includes(sourceKey))
        && physicalSources.keys.every((sourceKey) => {
          const actorId = sourceKeyActor(sourceKey);
          return actorId === null || actorId === demonstratorId;
        }));
      if (exactSource) exactSourceBases += 1;
      else exactSourceMismatches.add(key);
      const initialConfidence = finiteValue(basis.initialConfidence);
      const confidenceBefore = finiteValue(demonstrationDiff.techniqueConfidenceBefore);
      const confidenceAfter = finiteValue(demonstrationDiff.techniqueConfidenceAfter);
      const tentative = initialConfidence !== null
        && initialConfidence >= 0 && initialConfidence < 55
        && confidenceBefore !== null && confidenceBefore < 55
        && confidenceAfter === initialConfidence;
      if (tentative) tentativeLessons += 1;
      if ((initialConfidence !== null && initialConfidence >= 55)
        || (confidenceAfter !== null && confidenceAfter >= 55)) {
        directReliableViolations.add(demonstrationEventId ?? key);
      }
      if (!tentative) responseMismatches.add(key);
      const requestPairKey = projectId && demonstratorId ? `${projectId}\u0000${demonstratorId}` : null;
      const valid = requestResolved
        && demonstrationResolved
        && requestPersonMatches
        && demonstratorMatches
        && demonstratorReliable
        && learnerMatches
        && projectMatches
        && functionMatches
        && observable
        && techniqueMatches
        && operationMatches
        && responseMatches
        && orderMatches
        && sourced
        && exactSource
        && tentative
        && Boolean(requestPairKey && requestPairCounts.get(requestPairKey) === 1);
      basisAudits.push({
        key,
        project,
        projectId,
        learnerId,
        demonstratorId,
        techniqueId,
        requestEventId,
        demonstrationEventId,
        demonstrationIndex,
        signature,
        valid,
        exactSource,
        tentative,
      });
    }
  }
  const basisAuditsByDemonstration = new Map<string, BasisAudit[]>();
  for (const audit of basisAudits) {
    if (!audit.demonstrationEventId) continue;
    const matches = basisAuditsByDemonstration.get(audit.demonstrationEventId) ?? [];
    matches.push(audit);
    basisAuditsByDemonstration.set(audit.demonstrationEventId, matches);
  }
  for (const entry of demonstrationActions) {
    const eventId = stringValue(entry.value.id);
    if (!eventId || (basisAuditsByDemonstration.get(eventId)?.length ?? 0) !== 1) {
      unresolvedBases.add(eventId ?? entry.key);
    }
  }

  const imitationAttempts = events.filter((entry) => {
    const action = actionRecord(entry.value);
    const diff = diffRecord(entry.value);
    return objectRecord(action?.techniqueImitation) !== null
      || diff.techniqueLearningStage === 'imitation';
  });
  const imitationResponses = imitationAttempts.filter((entry) => (
    basicLearningResponse(entry.value, 'imitation')
  )).length;
  const imitationUnresolvedBases = new Set<string>();
  const imitationSourceMismatches = new Set<string>();
  const imitationActorMismatches = new Set<string>();
  const imitationProjectMismatches = new Set<string>();
  const imitationTechniqueMismatches = new Set<string>();
  const imitationOperationMismatches = new Set<string>();
  const imitationResponseMismatches = new Set<string>();
  const imitationOrderViolations = new Set<string>();
  const imitationExactSourceMismatches = new Set<string>();
  const imitationAudits: ImitationAudit[] = [];
  let exactSourceImitations = 0;

  for (const entry of imitationAttempts) {
    const event = entry.value;
    const key = entry.key;
    const action = actionRecord(event);
    const imitationRef = objectRecord(action?.techniqueImitation);
    const diff = diffRecord(event);
    const demonstrationEventId = stringValue(imitationRef?.demonstrationEventId)
      ?? stringValue(diff.techniqueDemonstrationEventId);
    const basisMatches = demonstrationEventId
      ? basisAuditsByDemonstration.get(demonstrationEventId) ?? []
      : [];
    const basis = basisMatches.length === 1 ? basisMatches[0] : null;
    if (!basis) imitationUnresolvedBases.add(key);
    const signature = basis?.signature ?? null;
    const actualSignature = responseSignature(event);
    const parsedTechnique = parseTechnique(basis?.techniqueId ?? null);
    const physicalSources = physicalActionSourceKeys(event);
    const normalizedActorMatches = Boolean(basis?.learnerId
      && event.who === basis.learnerId
      && diff.techniqueLearnerId === basis.learnerId
      && physicalSources.keys.every((sourceKey) => {
        const sourceActor = sourceKeyActor(sourceKey);
        return sourceActor === null || sourceActor === basis.learnerId;
      }));
    if (!normalizedActorMatches) imitationActorMismatches.add(key);
    const projectMatches = Boolean(basis?.projectId
      && imitationRef?.projectId === basis.projectId
      && diff.techniqueProjectId === basis.projectId
      && stringKeys(basis.project.actionEventIds).includes(stringValue(event.id) ?? ''));
    if (!projectMatches) imitationProjectMismatches.add(key);
    const techniqueMatches = Boolean(basis?.techniqueId
      && imitationRef?.techniqueId === basis.techniqueId
      && diff.techniqueId === basis.techniqueId
      && signature
      && parsedTechnique
      && signaturesMatch(signature, parsedTechnique));
    if (!techniqueMatches) imitationTechniqueMismatches.add(key);
    const operationMatches = Boolean(signature
      && action?.kind === 'act'
      && action.operation === signature.operation);
    if (!operationMatches) imitationOperationMismatches.add(key);
    const responseMatches = Boolean(signature
      && actualSignature
      && basicLearningResponse(event, 'imitation')
      && signaturesMatch(signature, actualSignature)
      && diff.techniqueDemonstrationEventId === basis?.demonstrationEventId
      && (finiteValue(diff.techniqueConfidenceBefore) ?? Infinity) < 55
      && (finiteValue(diff.techniqueConfidenceAfter) ?? -Infinity) >= 55);
    if (!responseMatches) imitationResponseMismatches.add(key);
    const sourceMatches = Boolean(signature && actualSignature
      && sameMaterials(signature.inputMaterialIds, actualSignature.inputMaterialIds)
      && signature.toolMaterialId === actualSignature.toolMaterialId
      && signature.targetMaterialId === actualSignature.targetMaterialId);
    if (!sourceMatches) imitationSourceMismatches.add(key);
    const orderMatches = Boolean(basis?.demonstrationIndex !== null
      && basis?.demonstrationIndex !== undefined
      && basis.demonstrationIndex < entry.index);
    if (!orderMatches) imitationOrderViolations.add(key);
    const imitationSourceKeys = exactStringKeys(diff.techniqueImitationSourceKeys);
    const exactSource = Boolean(imitationSourceKeys?.length
      && physicalSources.complete
      && physicalSources.keys.every((sourceKey) => imitationSourceKeys.includes(sourceKey))
      && physicalSources.keys.every((sourceKey) => {
        const sourceActor = sourceKeyActor(sourceKey);
        return sourceActor === null || sourceActor === basis?.learnerId;
      }));
    if (exactSource) exactSourceImitations += 1;
    else imitationExactSourceMismatches.add(key);
    imitationAudits.push({
      key,
      event,
      eventIndex: entry.index,
      basis,
      valid: Boolean(basis?.valid
        && normalizedActorMatches
        && projectMatches
        && techniqueMatches
        && operationMatches
        && responseMatches
        && sourceMatches
        && orderMatches
        && exactSource),
      exactSource,
    });
  }

  const reliableLearnerIds = new Set<string>();
  for (const basis of basisAudits) {
    if (!basis.learnerId || !basis.techniqueId || !reliableTechnique(basis.learnerId, basis.techniqueId)) continue;
    reliableLearnerIds.add(basis.learnerId);
  }
  const reliableWithoutOwnImitation = new Set<string>();
  const completeChains = new Set<string>();
  const progressChains = new Set<string>();
  const completionChains = new Set<string>();
  const generationLearners = new Set<string>();
  for (const basis of basisAudits) {
    if (!basis.learnerId || !basis.techniqueId) continue;
    const lessonKey = `${basis.learnerId}\u0000${basis.techniqueId}`;
    const reliable = reliableTechnique(basis.learnerId, basis.techniqueId);
    const validImitations = imitationAudits.filter((imitation) => (
      imitation.valid && imitation.basis?.key === basis.key
    ));
    if (reliable && validImitations.length === 0) reliableWithoutOwnImitation.add(lessonKey);
    if (!basis.valid || !reliable || validImitations.length === 0) continue;
    const imitation = validImitations.sort((left, right) => left.eventIndex - right.eventIndex)[0];
    completeChains.add(basis.key);
    const progressAfter = records(basis.project.progressEvidence).some((evidence) => {
      const eventId = stringValue(evidence.eventId);
      const progressIndex = eventId ? eventById.get(eventId)?.index : undefined;
      return progressIndex !== undefined && progressIndex >= imitation.eventIndex;
    });
    if (progressAfter) progressChains.add(basis.key);
    const completionAfter = basis.project.status === 'completed'
      && stringKeys(basis.project.completionEventIds).some((eventId) => (
        (eventById.get(eventId)?.index ?? -1) >= imitation.eventIndex
      ));
    if (completionAfter) completionChains.add(basis.key);
    const learner = personById.get(basis.learnerId);
    if ((integerValue(learner?.generation) ?? 0) > 0) generationLearners.add(basis.learnerId);
  }

  const techniqueTeachingEvents = events.filter((entry) => {
    const event = entry.value;
    const action = actionRecord(event);
    const content = objectRecord(action?.speakerMeaning);
    return event.status === 'completed'
      && action?.kind === 'talk'
      && content?.kind === 'claim'
      && stringValue(content.id)?.startsWith('teach:') === true
      && stringValue(content.factId)?.startsWith('technique:') === true
      && requestPayload(content) === null;
  });
  const techniqueTeachingLearnerIds = new Set<string>();
  let techniqueTeachingUnderageViolations = 0;
  let techniqueTeachingUnreliableTeacherViolations = 0;
  for (const entry of techniqueTeachingEvents) {
    const event = entry.value;
    const diff = diffRecord(event);
    const teacherConfidence = finiteValue(diff.teachingTeacherConfidence);
    if (teacherConfidence === null || teacherConfidence < 55) techniqueTeachingUnreliableTeacherViolations += 1;
    const atMonth = integerValue(event.atMonth) ?? 0;
    for (const learnerId of stringKeys(diff.taughtAudienceIds)) {
      techniqueTeachingLearnerIds.add(learnerId);
      const learner = personById.get(learnerId);
      const bornAtMonth = integerValue(learner?.bornAtMonth);
      if (bornAtMonth !== null && atMonth - bornAtMonth < 6 * 12) techniqueTeachingUnderageViolations += 1;
    }
  }

  return {
    techniqueDemonstrationRequestAttempts: requestAttempts.length,
    techniqueDemonstrationRequests: requestAttempts.filter((request) => request.entry.value.status === 'completed').length,
    techniqueDemonstrationUniqueProjectTeachers: uniqueProjectTeachers,
    techniqueDemonstrationDuplicateRequests: duplicateRequests,
    techniqueDemonstrationActions: demonstrationActions.length,
    techniqueDemonstrationResponses: demonstrationResponses,
    techniqueDemonstrationBases: demonstrationBases,
    techniqueDemonstrationSourcedBases: sourcedBases,
    techniqueDemonstrationSourceCoverage: coverage(sourcedBases, demonstrationBases),
    techniqueDemonstrationExactSourceCoverage: coverage(exactSourceBases, demonstrationBases),
    techniqueDemonstrationTentativeLessons: tentativeLessons,
    techniqueDemonstrationDirectReliableViolations: directReliableViolations.size,
    techniqueDemonstrationUnresolvedBases: unresolvedBases.size,
    techniqueDemonstrationUnresolvedRequestEvents: unresolvedRequestEvents.size,
    techniqueDemonstrationUnresolvedActionEvents: unresolvedActionEvents.size,
    techniqueDemonstrationRequestPersonMismatches: requestPersonMismatches.size,
    techniqueDemonstrationRequestProjectMismatches: requestProjectMismatches.size,
    techniqueDemonstrationRequestFunctionMismatches: requestFunctionMismatches.size,
    techniqueDemonstrationDemonstratorMismatches: demonstratorMismatches.size,
    techniqueDemonstrationDemonstratorReliabilityMismatches: demonstratorReliabilityMismatches.size,
    techniqueDemonstrationLearnerMismatches: learnerMismatches.size,
    techniqueDemonstrationProjectMismatches: projectMismatches.size,
    techniqueDemonstrationFunctionMismatches: functionMismatches.size,
    techniqueDemonstrationColocationMismatches: colocationMismatches.size,
    techniqueDemonstrationTechniqueMismatches: techniqueMismatches.size,
    techniqueDemonstrationOperationMismatches: operationMismatches.size,
    techniqueDemonstrationResponseMismatches: responseMismatches.size,
    techniqueDemonstrationOrderViolations: orderViolations.size,
    techniqueDemonstrationSourceMismatches: sourceMismatches.size,
    techniqueDemonstrationExactSourceMismatches: exactSourceMismatches.size,
    techniqueImitationAttempts: imitationAttempts.length,
    techniqueImitationResponses: imitationResponses,
    techniqueImitationExactSourceCoverage: coverage(exactSourceImitations, imitationAttempts.length),
    techniqueImitationUnresolvedBases: imitationUnresolvedBases.size,
    techniqueImitationSourceMismatches: imitationSourceMismatches.size,
    techniqueImitationActorMismatches: imitationActorMismatches.size,
    techniqueImitationProjectMismatches: imitationProjectMismatches.size,
    techniqueImitationTechniqueMismatches: imitationTechniqueMismatches.size,
    techniqueImitationOperationMismatches: imitationOperationMismatches.size,
    techniqueImitationResponseMismatches: imitationResponseMismatches.size,
    techniqueImitationOrderViolations: imitationOrderViolations.size,
    techniqueImitationExactSourceMismatches: imitationExactSourceMismatches.size,
    techniqueDemonstrationReliableLearners: reliableLearnerIds.size,
    techniqueReliableWithoutOwnImitationViolations: reliableWithoutOwnImitation.size,
    completeTechniqueLearningChains: completeChains.size,
    completeTechniqueLearningProjectProgressChains: progressChains.size,
    completeTechniqueLearningProjectCompletionChains: completionChains.size,
    generationGtZeroCausalReliableLearners: generationLearners.size,
    techniqueTeachingActions: techniqueTeachingEvents.length,
    techniqueTeachingLearners: techniqueTeachingLearnerIds.size,
    techniqueTeachingUnderageViolations,
    techniqueTeachingUnreliableTeacherViolations,
  };
}
