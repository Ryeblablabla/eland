import type { DecisionRequestContext } from './decision-context';
import { nativeOperationIdentity, nativeOperationWorldRefs, nativeReferenceEntities, type NativeReferenceKind } from './native-operation-context';
import type { NativeOperationRequest } from '../../domain/native-operation';

export type DecisionProbeVisibleHandle =
  | { handle: string; kind: 'drop'; dropId: string }
  | { handle: string; kind: 'person'; personId: string }
  | { handle: string; kind: 'animal'; animalId: string }
  | { handle: string; kind: 'work'; workId: string }
  | { handle: string; kind: 'inventory-stack'; personId: string; stackId: string }
  | { handle: string; kind: 'remains'; remainsId: string }
  | { handle: string; kind: 'container'; containerId: string };

/** Visible mappings retained per request; world-object names keep stable identity. */
export interface DecisionProbeHandleMap {
  actorId?: string;
  nativeReferences?: Array<{ handle: string; kind: NativeReferenceKind; id: string }>;
  nativeMethods?: Array<{ handle: string; request: NativeOperationRequest }>;
  held: Array<{ handle: string; stackId: string }>;
  visible: DecisionProbeVisibleHandle[];
  voxels: Array<{ handle: string; position: { x: number; y: number; z: number } }>;
  agendas: Array<{ handle: string; itemId: string; basisKey: string }>;
  suspendedIntents: Array<{ handle: string; intentId: string; resumable: boolean }>;
  memories: Array<{
    handle: string;
    itemId: string;
    sourceFactIds: string[];
    personIds?: string[];
    causalOutcome?: 'completed' | 'progressed' | 'blocked' | 'failed';
  }>;
  groundingFacts: Array<{
    handle: string;
    optionId: string;
    sourceFactId: string;
    kind: 'memory' | 'knowledge' | 'relationship';
    summary: string;
  }>;
  speechReferences?: Array<{ handle: string; kind: 'agreement' | 'permission' | 'collective' | 'knowledge' | 'project' | 'decision-rule'; id: string }>;
}

export interface CharacterAgendaProbeCandidates {
  held: Array<{ handle: string; name: string; properties: string[]; quantity: number;
    mechanicalCondition?: DecisionRequestContext['person']['inventory'][number]['mechanicalCondition'] }>;
  visible: Array<Record<string, unknown> & { handle: string; kind: string }>;
  voxels: Array<{ handle: string; name: string; properties: string[]; position: { x: number; y: number; z: number } }>;
}

export function decisionVoxelKey(position: { x: number; y: number; z: number }): string {
  return `${position.x}:${position.y}:${position.z}`;
}

/** Deterministic compact identity, independent of order, visibility and process lifetime. */
function entityHandle(prefix: string, ...identity: string[]): string {
  const source = JSON.stringify(identity);
  let hash = 14695981039346656037n;
  for (let index = 0; index < source.length; index++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(source.charCodeAt(index))) * 1099511628211n);
  }
  return `${prefix}${hash.toString(36)}`;
}

function voxelHandle(position: { x: number; y: number; z: number }): string {
  return `v${position.x.toString(36)}_${position.y.toString(36)}_${position.z.toString(36)}`;
}

type OpenGroundingFact = NonNullable<
  DecisionRequestContext['options'][number]['openConversationGrounding']
>['facts'][number];

export function diverseOpenGroundingFacts(
  facts: readonly OpenGroundingFact[],
  limit = 6,
): OpenGroundingFact[] {
  const selected: OpenGroundingFact[] = [];
  const selectedSourceIds = new Set<string>();
  const take = (fact: OpenGroundingFact | undefined): void => {
    if (!fact || selected.length >= limit || selectedSourceIds.has(fact.sourceFactId)) return;
    selected.push(fact);
    selectedSourceIds.add(fact.sourceFactId);
  };
  for (const kind of ['memory', 'knowledge', 'relationship'] as const) {
    take(facts.find((fact) => fact.kind === kind));
  }
  for (const fact of facts) take(fact);
  return selected;
}

/** Expose currently addressable entities without recycling a disappeared object's name. */
export function buildDecisionProbeHandleMap(context: DecisionRequestContext): DecisionProbeHandleMap {
  const voxels: DecisionProbeHandleMap['voxels'] = [];
  const seenVoxelKeys = new Set<string>();
  for (const visible of context.visibleVoxels ?? []) {
    const key = decisionVoxelKey(visible.position);
    if (seenVoxelKeys.has(key)) continue;
    seenVoxelKeys.add(key);
    voxels.push({ handle: voxelHandle(visible.position), position: { ...visible.position } });
  }
  for (const option of [...context.options, ...context.followUpOptions]) {
    if (option.target?.kind !== 'voxel') continue;
    const key = decisionVoxelKey(option.target.position);
    if (seenVoxelKeys.has(key)) continue;
    seenVoxelKeys.add(key);
    voxels.push({ handle: voxelHandle(option.target.position), position: { ...option.target.position } });
  }
  for (const target of nativeOperationWorldRefs(context.nativeOperations ?? [])) {
    if (target.kind !== 'voxel') continue;
    const key = decisionVoxelKey(target.position);
    if (seenVoxelKeys.has(key)) continue;
    seenVoxelKeys.add(key);
    voxels.push({ handle: voxelHandle(target.position), position: { ...target.position } });
  }
  const groundingFacts: DecisionProbeHandleMap['groundingFacts'] = [];
  for (const option of context.options) {
    for (const fact of diverseOpenGroundingFacts(option.openConversationGrounding?.facts ?? [])) {
      groundingFacts.push({
        handle: `q${groundingFacts.length + 1}`,
        optionId: option.id,
        sourceFactId: fact.sourceFactId,
        kind: fact.kind,
        summary: fact.summary,
      });
    }
  }
  const speechReferences: NonNullable<DecisionProbeHandleMap['speechReferences']> = [
      ...context.agreements.map((item, index) => ({ handle: `agreement${index + 1}`, kind: 'agreement' as const, id: item.id })),
      ...context.permissions.map((item, index) => ({ handle: `permission${index + 1}`, kind: 'permission' as const, id: item.id })),
      ...context.collectives.map((item, index) => ({ handle: `collective${index + 1}`, kind: 'collective' as const, id: item.id })),
      ...context.person.knowledge.map((item, index) => ({ handle: `knowledge${index + 1}`, kind: 'knowledge' as const, id: item.id })),
      ...(context.knownProjects ?? []).map((item, index) => ({ handle: `project${index + 1}`, kind: 'project' as const, id: item.id })),
      ...context.collectives.flatMap((collective) => collective.decisionRules)
        .map((item, index) => ({ handle: `decision-rule${index + 1}`, kind: 'decision-rule' as const, id: item.id })),
  ];
  const nativeEntities = nativeReferenceEntities(context.nativeOperations ?? []);
  for (const reference of speechReferences) {
    if (!['agreement', 'knowledge', 'project'].includes(reference.kind)
      || nativeEntities.some((entry) => entry.kind === reference.kind && entry.id === reference.id)) continue;
    nativeEntities.push({ kind: reference.kind as NativeReferenceKind, id: reference.id });
  }
  return {
    actorId: context.person.id, speechReferences,
    nativeMethods: [...new Map((context.nativeOperations ?? []).flatMap(({ request, methodKey, requiresMethod }) => {
      const sources = request.references;
      if (!requiresMethod && (!sources || ![sources.projectId, sources.recordId, sources.knowledgeId, sources.techniqueId, sources.agreementId].some(Boolean))) return [];
      const bound = { ...structuredClone(request), ...(methodKey ? { methodKey } : {}) };
      const handle = entityHandle('method_', context.person.id, nativeOperationIdentity(bound));
      return [[handle, { handle, request: bound }] as const];
    })).values()],
    nativeReferences: nativeEntities.map((entry, index) => ({ ...entry,
      handle: speechReferences.find((reference) => reference.kind === entry.kind && reference.id === entry.id)?.handle
        ?? `native-${entry.kind}${index + 1}`,
    })),
    // Every held entity remains addressable for this request. Compacting the
    // prose view must never make a later stack impossible for the person to
    // choose as a concrete experiment input.
    held: context.person.inventory.map((stack) => ({
      handle: entityHandle('i', context.person.id, stack.stackId),
      stackId: stack.stackId,
    })),
    visible: [
      ...context.visibleDrops.map((item) => ({
        handle: entityHandle('d', item.id), kind: 'drop' as const, dropId: item.id,
      })),
      ...context.visiblePeople.map((item) => ({
        handle: entityHandle('p', item.id), kind: 'person' as const, personId: item.id,
      })),
      ...context.visibleAnimals.map((item) => ({
        handle: entityHandle('a', item.id), kind: 'animal' as const, animalId: item.id,
      })),
      ...context.visibleContainers.map((item) => ({
        handle: entityHandle('c', item.id), kind: 'container' as const, containerId: item.id,
      })),
      ...(context.visibleWorks ?? []).map((item) => ({
        handle: entityHandle('w', item.id), kind: 'work' as const, workId: item.id,
      })),
      ...(context.visiblePossessions ?? []).map((item) => ({
        handle: entityHandle('i', item.personId, item.stackId), kind: 'inventory-stack' as const, personId: item.personId, stackId: item.stackId,
      })),
      ...(context.visibleRemains ?? []).map((item) => ({
        handle: entityHandle('r', item.id), kind: 'remains' as const, remainsId: item.id,
      })),
    ],
    voxels,
    agendas: (context.person.characterAgenda ?? []).slice(0, 4).map((item, index) => ({
      handle: `g${index + 1}`,
      itemId: item.id,
      basisKey: item.basisKey,
    })),
    suspendedIntents: context.suspendedIntents.map((intent, index) => ({
      handle: `s${index + 1}`,
      intentId: intent.id,
      resumable: !intent.waitingFor,
    })),
    memories: context.person.memories
      .slice(0, 20)
      .map((memory, index) => ({
        handle: `m${index + 1}`,
        itemId: memory.id,
        sourceFactIds: [...memory.sourceEventIds],
        personIds: [...memory.personIds],
        ...(memory.causalOutcome ? { causalOutcome: memory.causalOutcome } : {}),
      })),
    groundingFacts,
  };
}

/** Model-visible probe candidates. No authoritative entity id crosses this boundary. */
export function buildCharacterAgendaProbeCandidates(
  context: DecisionRequestContext,
  handles: DecisionProbeHandleMap,
): CharacterAgendaProbeCandidates {
  const heldById = new Map(handles.held.map((item) => [item.stackId, item.handle]));
  const visibleByRef = new Map(handles.visible.map((item) => {
    const id = item.kind === 'drop' ? item.dropId
      : item.kind === 'person' ? item.personId
      : item.kind === 'animal' ? item.animalId
        : item.kind === 'work' ? item.workId
          : item.kind === 'inventory-stack' ? `${item.personId}:${item.stackId}`
            : item.kind === 'remains' ? item.remainsId
          : item.containerId;
    return [`${item.kind}:${id}`, item.handle];
  }));
  return {
    held: context.person.inventory.flatMap((stack) => {
      const handle = heldById.get(stack.stackId);
      return handle ? [{ handle, name: stack.name, properties: stack.properties, quantity: stack.quantity,
        ...(stack.mechanicalCondition ? { mechanicalCondition: stack.mechanicalCondition } : {}) }] : [];
    }),
    visible: [
      ...context.visibleDrops.flatMap(({ id, name, properties, quantity, cellId, z, knownDelivery, mechanicalCondition }) => {
        const handle = visibleByRef.get(`drop:${id}`);
        return handle ? [{ handle, kind: 'drop', name, properties, quantity, cellId, z,
          ...(mechanicalCondition ? { mechanicalCondition } : {}),
          ...(knownDelivery ? { knownDelivery } : {}) }] : [];
      }),
      ...context.visiblePeople.flatMap(({ id, name, ageMonths, sex, cellId, z }) => {
        const handle = visibleByRef.get(`person:${id}`);
        return handle ? [{ handle, kind: 'person', name, ageMonths, sex, cellId, z }] : [];
      }),
      ...context.visibleAnimals.flatMap(({ id, speciesId, cellId, z, bondTrust }) => {
        const handle = visibleByRef.get(`animal:${id}`);
        return handle ? [{
          handle, kind: 'animal', speciesId, cellId, z,
          bondTrust,
        }] : [];
      }),
      ...context.visibleContainers.flatMap(({ id, position, capacity, usedCapacity, contents, workId, retainsWater }) => {
        const handle = visibleByRef.get(`container:${id}`);
        return handle ? [{ handle, kind: 'container', position, capacity, usedCapacity, contents,
          ...(workId ? { workHandle: visibleByRef.get(`work:${workId}`), retainsWater } : {}) }] : [];
      }),
      ...(context.visibleWorks ?? []).flatMap(({ id, ...work }) => {
        const handle = visibleByRef.get(`work:${id}`);
        return handle ? [{ handle, kind: 'work', ...work }] : [];
      }),
      ...(context.visiblePossessions ?? []).flatMap(({ personId, stackId, ...possession }) => {
        const handle = visibleByRef.get(`inventory-stack:${personId}:${stackId}`);
        const ownerHandle = visibleByRef.get(`person:${personId}`);
        return handle ? [{ handle, kind: 'inventory-stack', ownerHandle, ...possession }] : [];
      }),
      ...(context.visibleRemains ?? []).flatMap(({ id, ...remains }) => {
        const handle = visibleByRef.get(`remains:${id}`);
        return handle ? [{ handle, kind: 'remains', ...remains }] : [];
      }),
    ],
    voxels: handles.voxels.flatMap(({ handle, position }) => {
      const visible = (context.visibleVoxels ?? [])
        .find((candidate) => decisionVoxelKey(candidate.position) === decisionVoxelKey(position));
      return [{ handle, name: visible?.name ?? '本人可指认的位置', properties: [...(visible?.properties ?? [])], position: { ...position } }];
    }),
  };
}
