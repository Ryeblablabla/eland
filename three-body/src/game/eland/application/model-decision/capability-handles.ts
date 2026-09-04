import type { DecisionRequestContext } from './decision-context';

export type DecisionProbeVisibleHandle =
  | { handle: string; kind: 'drop'; dropId: string }
  | { handle: string; kind: 'person'; personId: string }
  | { handle: string; kind: 'animal'; animalId: string }
  | { handle: string; kind: 'container'; containerId: string };

/** Request-scoped opaque handles retained by the server-side gateway. */
export interface DecisionProbeHandleMap {
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
}

export interface CharacterAgendaProbeCandidates {
  held: Array<{ handle: string; name: string; properties: string[]; quantity: number }>;
  visible: Array<Record<string, unknown> & { handle: string; kind: string }>;
  voxels: Array<{ handle: string; name: string; properties: string[] }>;
}

export function decisionVoxelKey(position: { x: number; y: number; z: number }): string {
  return `${position.x}:${position.y}:${position.z}`;
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

/** Builds the opaque entity namespace retained for exactly one request. */
export function buildDecisionProbeHandleMap(context: DecisionRequestContext): DecisionProbeHandleMap {
  const voxels: DecisionProbeHandleMap['voxels'] = [];
  const seenVoxelKeys = new Set<string>();
  for (const visible of context.visibleVoxels ?? []) {
    const key = decisionVoxelKey(visible.position);
    if (seenVoxelKeys.has(key)) continue;
    seenVoxelKeys.add(key);
    voxels.push({ handle: `v${voxels.length + 1}`, position: { ...visible.position } });
  }
  for (const option of [...context.options, ...context.followUpOptions]) {
    if (option.target?.kind !== 'voxel') continue;
    const key = decisionVoxelKey(option.target.position);
    if (seenVoxelKeys.has(key)) continue;
    seenVoxelKeys.add(key);
    voxels.push({ handle: `v${voxels.length + 1}`, position: { ...option.target.position } });
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
  return {
    // Every held entity remains addressable for this request. Compacting the
    // prose view must never make a later stack impossible for the person to
    // choose as a concrete experiment input.
    held: context.person.inventory.map((stack, index) => ({
      handle: `h${index + 1}`,
      stackId: stack.stackId,
    })),
    visible: [
      ...context.visibleDrops.map((item, index) => ({
        handle: `d${index + 1}`, kind: 'drop' as const, dropId: item.id,
      })),
      ...context.visiblePeople.map((item, index) => ({
        handle: `p${index + 1}`, kind: 'person' as const, personId: item.id,
      })),
      ...context.visibleAnimals.map((item, index) => ({
        handle: `a${index + 1}`, kind: 'animal' as const, animalId: item.id,
      })),
      ...context.visibleContainers.map((item, index) => ({
        handle: `c${index + 1}`, kind: 'container' as const, containerId: item.id,
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
          : item.containerId;
    return [`${item.kind}:${id}`, item.handle];
  }));
  return {
    held: context.person.inventory.flatMap((stack) => {
      const handle = heldById.get(stack.stackId);
      return handle ? [{ handle, name: stack.name, properties: stack.properties, quantity: stack.quantity }] : [];
    }),
    visible: [
      ...context.visibleDrops.slice(0, 8).flatMap(({ id, name, properties, quantity, cellId, z }) => {
        const handle = visibleByRef.get(`drop:${id}`);
        return handle ? [{ handle, kind: 'drop', name, properties, quantity, cellId, z }] : [];
      }),
      ...context.visiblePeople.slice(0, 6).flatMap(({ id, name, ageMonths, sex, cellId, z }) => {
        const handle = visibleByRef.get(`person:${id}`);
        return handle ? [{ handle, kind: 'person', name, ageMonths, sex, cellId, z }] : [];
      }),
      ...context.visibleAnimals.slice(0, 4).flatMap(({ id, speciesId, cellId, z, bondTrust }) => {
        const handle = visibleByRef.get(`animal:${id}`);
        return handle ? [{
          handle, kind: 'animal', speciesId, cellId, z,
          bondTrust,
        }] : [];
      }),
      ...context.visibleContainers.slice(0, 4).flatMap(({ id, position, capacity, usedCapacity }) => {
        const handle = visibleByRef.get(`container:${id}`);
        return handle ? [{ handle, kind: 'container', position, capacity, usedCapacity }] : [];
      }),
    ],
    voxels: handles.voxels.flatMap(({ handle, position }) => {
      const visible = (context.visibleVoxels ?? [])
        .find((candidate) => decisionVoxelKey(candidate.position) === decisionVoxelKey(position));
      return visible ? [{ handle, name: visible.name, properties: [...visible.properties] }] : [];
    }),
  };
}
