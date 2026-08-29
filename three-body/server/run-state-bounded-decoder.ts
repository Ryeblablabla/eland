import type {
  SimulationState,
  WorldEvent,
  WorldHistoryCursorV1,
} from '../src/game/eland/simulation';
import { createBoundedGameplayShellAccumulator } from './bounded-gameplay-shell';
import type {
  DecodedBoundedGameplayRunState,
  DecodedBoundedRunState,
  RunHistoryCursor,
  RunHistoryNodeMetadata,
  RunStateBoundedDecodeOptions,
  RunStateChunk,
  RunStateGameplayBoundedDecodeOptions,
  RunStatePinnedEvent,
  RunStateRootMetadata,
  VerifiedSchema3RunStateShellReceipt,
  VerifiedSchema3RunStateShellVisitor,
} from './run-state-codec';

type SimulationStateShell = Omit<SimulationState, 'world'> & {
  world: Omit<SimulationState['world'], 'past'>;
};

export interface RunStateBoundedDecoderHost {
  readonly runStateEventSegmentCodec: string;
  snapshotRunStateChunk(chunk: RunStateChunk): RunStateChunk;
  parseRunStateRoot(chunk: RunStateChunk): RunStateRootMetadata;
  runHistoryCursorFromRootMetadata(root: RunStateRootMetadata): RunHistoryCursor;
  readReferencedRunStateChunk(
    readChunk: (hash: string) => RunStateChunk,
    expectedHash: string,
    label: string,
  ): RunStateChunk;
  parseRunHistoryNode(chunk: RunStateChunk): RunHistoryNodeMetadata;
  decodeCompressedV8<T>(chunk: RunStateChunk, codec: string, label: string): T;
  deepFreezeOwnedValue<T>(value: T): T;
  eventContentHash(event: WorldEvent): string;
  tailEventContentHash(events: readonly WorldEvent[]): string | null;
  assertDomainHistoryCursorMatchesLedger(
    cursor: WorldHistoryCursorV1,
    expectedEventCount: number,
    expectedTailEventId: string | null,
    hotEventCount: number,
    label: string,
  ): void;
  decodeRunStateShell(
    root: RunStateRootMetadata,
    readChunk: (hash: string) => RunStateChunk,
  ): SimulationStateShell;
  streamVerifiedSchema3GameplayShell(
    rootChunkInput: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    visitor: Readonly<VerifiedSchema3RunStateShellVisitor>,
  ): Promise<Readonly<VerifiedSchema3RunStateShellReceipt>>;
  assertVerifiedSchema3RunStateShellReceipt(
    value: unknown,
    expectedRootHash: string,
  ): void;
}
export interface RunStateBoundedDecoder {
  materializeVerifiedRunHistoryPinnedEvents(
    root: RunStateRootMetadata,
    readChunk: (hash: string) => RunStateChunk,
    absoluteIndexes: readonly number[],
  ): RunStatePinnedEvent[];
  decodeSegmentedRunStateBounded(
    rootChunk: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    options: RunStateBoundedDecodeOptions,
  ): Promise<DecodedBoundedRunState>;
  decodeSegmentedRunStateGameplayBounded(
    rootChunkInput: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    options: RunStateGameplayBoundedDecodeOptions,
  ): Promise<DecodedBoundedGameplayRunState>;
}

export function createRunStateBoundedDecoder(
  host: Readonly<RunStateBoundedDecoderHost>,
): RunStateBoundedDecoder {
  const {
    runStateEventSegmentCodec: RUN_STATE_EVENT_SEGMENT_CODEC,
    snapshotRunStateChunk,
    parseRunStateRoot,
    runHistoryCursorFromRootMetadata,
    readReferencedRunStateChunk,
    parseRunHistoryNode,
    decodeCompressedV8,
    deepFreezeOwnedValue,
    eventContentHash,
    tailEventContentHash,
    assertDomainHistoryCursorMatchesLedger,
    decodeRunStateShell,
    streamVerifiedSchema3GameplayShell,
    assertVerifiedSchema3RunStateShellReceipt,
  } = host;
  function boundedPinnedEventIndexes(
    indexes: readonly number[] | undefined,
    eventCount: number,
    hotStartIndex: number,
  ): number[] {
    if (indexes === undefined) return [];
    if (!Array.isArray(indexes)) throw new Error('bounded decode 的 pinnedEventIndexes 必须是数组');
    const unique = new Set<number>();
    for (const index of indexes) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= eventCount) {
        throw new Error(`bounded decode 的 pin 绝对序号 ${String(index)} 超出运行历史范围`);
      }
      if (index < hotStartIndex) unique.add(index);
    }
    return [...unique].sort((left, right) => left - right);
  }

  /**
   * Materialize exact, selected event bodies from a schema-2/3 history root.
   * Every history node is verified to preserve the absolute ordinal frame, but
   * unrelated event segments stay compressed. This is intentionally narrower
   * than full-ledger streaming: callers must still validate each selected event
   * identity against their own authenticated pin manifest.
   */
  function materializeVerifiedRunHistoryPinnedEvents(
    root: RunStateRootMetadata,
    readChunk: (hash: string) => RunStateChunk,
    absoluteIndexes: readonly number[],
  ): RunStatePinnedEvent[] {
    const cursor = runHistoryCursorFromRootMetadata(root);
    if (!Array.isArray(absoluteIndexes)) {
      throw new Error('历史 pin 物化的绝对序号必须是数组');
    }
    const requested = [...absoluteIndexes];
    let previousIndex = -1;
    for (const absoluteIndex of requested) {
      if (!Number.isSafeInteger(absoluteIndex)
        || absoluteIndex < 0
        || absoluteIndex >= cursor.eventCount) {
        throw new Error(`历史 pin 物化的绝对序号 ${String(absoluteIndex)} 超出运行历史范围`);
      }
      if (absoluteIndex <= previousIndex) {
        throw new Error('历史 pin 物化的绝对序号必须严格递增且不得重复');
      }
      previousIndex = absoluteIndex;
    }
    if (requested.length === 0) return [];

    const pinnedEvents = new Array<RunStatePinnedEvent>(requested.length);
    let nextPinOffset = requested.length - 1;
    let expectedNodeTotal = cursor.eventCount;
    let nodeHash = cursor.historyHeadHash;
    while (nodeHash) {
      const node = parseRunHistoryNode(
        readReferencedRunStateChunk(readChunk, nodeHash, '历史 pin 物化节点'),
      );
      if (node.lineageId !== cursor.lineageId) {
        throw new Error(`历史 pin 物化节点 ${nodeHash} 与状态根 lineage 不一致`);
      }
      if (node.totalEventCount !== expectedNodeTotal
        || node.startEventIndex >= expectedNodeTotal) {
        throw new Error(`历史 pin 物化节点 ${nodeHash} 的累计事件数没有严格递减`);
      }

      let segmentEndIndex = node.totalEventCount;
      for (let segmentIndex = node.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
        const reference = node.segments[segmentIndex];
        const segmentStartIndex = segmentEndIndex - reference.eventCount;
        if (segmentStartIndex < node.startEventIndex) {
          throw new Error(`历史 pin 物化节点 ${nodeHash} 的事件分段序号不连续`);
        }
        const nextPinIndex = requested[nextPinOffset];
        if (nextPinOffset >= 0 && nextPinIndex >= segmentEndIndex) {
          throw new Error(`历史 pin 物化未找到绝对序号 ${nextPinIndex}`);
        }
        if (nextPinOffset >= 0 && nextPinIndex >= segmentStartIndex) {
          const decoded = decodeCompressedV8<unknown>(
            readReferencedRunStateChunk(readChunk, reference.hash, '历史 pin 物化事件分段'),
            RUN_STATE_EVENT_SEGMENT_CODEC,
            '历史 pin 物化事件分段',
          );
          if (!Array.isArray(decoded) || decoded.length !== reference.eventCount) {
            throw new Error(
              `历史 pin 物化事件分段 ${reference.hash} 的事件数量与历史节点不一致`,
            );
          }
          const segment = decoded as WorldEvent[];
          while (nextPinOffset >= 0 && requested[nextPinOffset] >= segmentStartIndex) {
            const absoluteIndex = requested[nextPinOffset];
            if (absoluteIndex >= segmentEndIndex) {
              throw new Error(`历史 pin 物化未找到绝对序号 ${absoluteIndex}`);
            }
            pinnedEvents[nextPinOffset] = Object.freeze({
              absoluteIndex,
              event: deepFreezeOwnedValue(segment[absoluteIndex - segmentStartIndex]),
            });
            nextPinOffset -= 1;
          }
        }
        segmentEndIndex = segmentStartIndex;
      }
      if (segmentEndIndex !== node.startEventIndex) {
        throw new Error(`历史 pin 物化节点 ${nodeHash} 的事件分段没有覆盖完整节点`);
      }
      expectedNodeTotal = node.startEventIndex;
      nodeHash = node.parentHash;
    }

    if (expectedNodeTotal !== 0) throw new Error('历史 pin 物化节点链缺少前缀');
    if (nextPinOffset !== -1) {
      throw new Error(`历史 pin 物化未找到绝对序号 ${requested[nextPinOffset]}`);
    }
    return pinnedEvents;
  }

  interface LastStepContentGroups {
    hashesByEventId: Map<string, Set<string>>;
    shellIndexesByHash: Map<string, number[]>;
  }

  interface DecodedBoundedRunHistory {
    hotEvents: WorldEvent[];
    pinnedEvents: RunStatePinnedEvent[];
    tailEventId: string | null;
    ledgerOccurrencesByLastStepHash: Map<string, number>;
  }

  function lastStepContentGroups(lastStep: readonly WorldEvent[]): LastStepContentGroups {
    const hashesByEventId = new Map<string, Set<string>>();
    const shellIndexesByHash = new Map<string, number[]>();
    for (let index = 0; index < lastStep.length; index += 1) {
      const event = lastStep[index];
      const hash = eventContentHash(event);
      const hashes = hashesByEventId.get(event.id);
      if (hashes) hashes.add(hash);
      else hashesByEventId.set(event.id, new Set([hash]));
      const shellIndexes = shellIndexesByHash.get(hash);
      if (shellIndexes) shellIndexes.push(index);
      else shellIndexesByHash.set(hash, [index]);
    }
    return { hashesByEventId, shellIndexesByHash };
  }

  function countLastStepContentOccurrences(
    events: readonly WorldEvent[],
    groups: LastStepContentGroups,
    counts: Map<string, number>,
  ): void {
    for (const event of events) {
      // Event IDs are a cheap rejection filter. Content hashing is needed only
      // for the handful of IDs present in the bounded shell's last step.
      const candidateHashes = groups.hashesByEventId.get(event.id);
      if (!candidateHashes) continue;
      const hash = eventContentHash(event);
      if (candidateHashes.has(hash)) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
  }

  /**
   * Verify the ledger from its head towards the genesis without materializing
   * the node chain. `totalEventCount -> startEventIndex` must strictly decrease,
   * so a cycle or discontinuity fails with O(1) node metadata residency.
   */
  function decodeBoundedRunHistoryReverse(
    root: RunStateRootMetadata,
    readChunk: (hash: string) => RunStateChunk,
    hotStartIndex: number,
    requestedColdPins: readonly number[],
    lastStepGroups: LastStepContentGroups,
  ): DecodedBoundedRunHistory {
    const hotEventCount = root.eventCount - hotStartIndex;
    const hotEvents = new Array<WorldEvent>(hotEventCount);
    const pinnedEvents = new Array<RunStatePinnedEvent>(requestedColdPins.length);
    const ledgerOccurrencesByLastStepHash = new Map<string, number>();
    let filledHotEventCount = 0;
    let nextPinOffset = requestedColdPins.length - 1;
    let expectedNodeTotal = root.eventCount;
    let nodeHash = root.historyHeadHash;
    let tailEventId: string | null = null;
    let streamedTailEventContentHash: string | null = null;
    let sawTailSegment = false;

    while (nodeHash) {
      const node = parseRunHistoryNode(readReferencedRunStateChunk(readChunk, nodeHash, '运行历史节点'));
      if (node.lineageId !== root.lineageId) {
        throw new Error(`运行历史节点 ${nodeHash} 与状态根 lineage 不一致`);
      }
      if (node.totalEventCount !== expectedNodeTotal
        || node.startEventIndex >= expectedNodeTotal) {
        throw new Error(`运行历史节点 ${nodeHash} 的累计事件数没有严格递减`);
      }

      let segmentEndIndex = node.totalEventCount;
      for (let segmentIndex = node.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
        const reference = node.segments[segmentIndex];
        const segmentStartIndex = segmentEndIndex - reference.eventCount;
        if (segmentStartIndex < node.startEventIndex) {
          throw new Error(`运行历史节点 ${nodeHash} 的事件分段序号不连续`);
        }
        const decoded = decodeCompressedV8<unknown>(
          readReferencedRunStateChunk(readChunk, reference.hash, '运行状态事件分段'),
          RUN_STATE_EVENT_SEGMENT_CODEC,
          '运行状态事件分段',
        );
        if (!Array.isArray(decoded) || decoded.length !== reference.eventCount) {
          throw new Error(`运行状态事件分段 ${reference.hash} 的事件数量与历史节点不一致`);
        }
        const segment = decoded as WorldEvent[];
        if (!sawTailSegment) {
          streamedTailEventContentHash = tailEventContentHash(segment);
          tailEventId = segment.at(-1)?.id ?? null;
          sawTailSegment = true;
        }
        countLastStepContentOccurrences(
          segment,
          lastStepGroups,
          ledgerOccurrencesByLastStepHash,
        );

        while (nextPinOffset >= 0
          && requestedColdPins[nextPinOffset] >= segmentStartIndex) {
          const absoluteIndex = requestedColdPins[nextPinOffset];
          if (absoluteIndex >= segmentEndIndex) {
            throw new Error(`bounded decode 未找到 pin 绝对序号 ${absoluteIndex}`);
          }
          pinnedEvents[nextPinOffset] = {
            absoluteIndex,
            event: segment[absoluteIndex - segmentStartIndex],
          };
          nextPinOffset -= 1;
        }

        const retainedStartIndex = Math.max(segmentStartIndex, hotStartIndex);
        if (retainedStartIndex < segmentEndIndex) {
          for (let absoluteIndex = retainedStartIndex;
            absoluteIndex < segmentEndIndex;
            absoluteIndex += 1) {
            hotEvents[absoluteIndex - hotStartIndex] = segment[absoluteIndex - segmentStartIndex];
          }
          filledHotEventCount += segmentEndIndex - retainedStartIndex;
        }
        segmentEndIndex = segmentStartIndex;
      }
      if (segmentEndIndex !== node.startEventIndex) {
        throw new Error(`运行历史节点 ${nodeHash} 的事件分段没有覆盖完整节点`);
      }
      expectedNodeTotal = node.startEventIndex;
      nodeHash = node.parentHash;
    }

    if (expectedNodeTotal !== 0) throw new Error('运行历史节点链缺少前缀');
    if (filledHotEventCount !== hotEventCount) {
      throw new Error('bounded decode 的连续历史热窗口与状态根不一致');
    }
    if (nextPinOffset !== -1) {
      throw new Error(`bounded decode 未找到 pin 绝对序号 ${requestedColdPins[nextPinOffset]}`);
    }
    if (streamedTailEventContentHash !== root.tailEventContentHash
      || (root.eventCount === 0
        ? tailEventId !== null
        : typeof tailEventId !== 'string')) {
      throw new Error('运行状态事件历史与状态根不一致');
    }
    return {
      hotEvents,
      pinnedEvents,
      tailEventId,
      ledgerOccurrencesByLastStepHash,
    };
  }

  function rebindLastStepToRetainedEvents(
    lastStep: readonly WorldEvent[],
    pinnedEvents: readonly RunStatePinnedEvent[],
    hotEvents: readonly WorldEvent[],
    hotStartIndex: number,
    groups: LastStepContentGroups,
    ledgerOccurrencesByHash: ReadonlyMap<string, number>,
  ): WorldEvent[] {
    const retainedByContentHash = new Map<string, RunStatePinnedEvent[]>();
    const retain = (retained: RunStatePinnedEvent): void => {
      const candidateHashes = groups.hashesByEventId.get(retained.event.id);
      if (!candidateHashes) return;
      const hash = eventContentHash(retained.event);
      if (!candidateHashes.has(hash)) return;
      const matches = retainedByContentHash.get(hash);
      if (matches) matches.push(retained);
      else retainedByContentHash.set(hash, [retained]);
    };
    for (const pinned of pinnedEvents) retain(pinned);
    for (let index = 0; index < hotEvents.length; index += 1) {
      retain({ absoluteIndex: hotStartIndex + index, event: hotEvents[index] });
    }

    const rebound = [...lastStep];
    for (const [hash, shellIndexes] of groups.shellIndexesByHash) {
      const retained = retainedByContentHash.get(hash);
      const ledgerOccurrenceCount = ledgerOccurrencesByHash.get(hash) ?? 0;
      // A single exact fact is globally unique. Repeated byte-equal facts are
      // rebound only when every occurrence is retained and represented in the
      // shell group; a partial pin cannot impersonate another identical fact.
      if (!retained
        || ledgerOccurrenceCount !== shellIndexes.length
        || retained.length !== shellIndexes.length) {
        continue;
      }
      retained.sort((left, right) => left.absoluteIndex - right.absoluteIndex);
      for (let index = 0; index < shellIndexes.length; index += 1) {
        rebound[shellIndexes[index]] = retained[index].event;
      }
    }
    return rebound;
  }

  /**
   * Decode a schema-2/3 state while retaining only a continuous hot tail and a
   * small set of cold facts selected by absolute ordinal. The shell is restored
   * independently, then every history node and segment is verified from the head
   * towards genesis with only one node and segment resident at a time. All
   * retained values remain staged until the complete root event count and tail
   * content hash have passed; no partial state is ever returned.
   *
   * This is a dedicated continuation seam. It deliberately does not change the
   * full decoder, public store restore path or worker behavior.
   */
  async function decodeSegmentedRunStateBoundedFromShell(
    rootChunk: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    options: RunStateBoundedDecodeOptions,
    shell: SimulationStateShell,
  ): Promise<DecodedBoundedRunState> {
    const root = parseRunStateRoot(rootChunk);
    if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
      throw new Error('bounded decode 只支持带权威尾校验的 schema 2/3 运行状态');
    }
    if (!options || !Number.isSafeInteger(options.hotEventLimit) || options.hotEventLimit < 0) {
      throw new Error('bounded decode 的 hotEventLimit 必须是非负安全整数');
    }

    const hotStartIndex = Math.max(0, root.eventCount - options.hotEventLimit);
    const requestedColdPins = boundedPinnedEventIndexes(
      options.pinnedEventIndexes,
      root.eventCount,
      hotStartIndex,
    );

    if (!shell || typeof shell !== 'object' || !shell.world || typeof shell.world !== 'object') {
      throw new Error('运行状态 shell 内容无效');
    }
    if (Object.prototype.hasOwnProperty.call(shell.world, 'past')) {
      throw new Error('运行状态 shell 非法包含 world.past');
    }
    if (!Array.isArray(shell.lastStep)) throw new Error('运行状态 shell 的 lastStep 内容无效');

    const originalDomainCursor = shell.world.historyCursor;
    if (originalDomainCursor) {
      // The shell omits its old `world.past`, so its former hot length is not
      // available here. This still validates every cursor field that can agree
      // with the authoritative root before the streamed tail id is known.
      assertDomainHistoryCursorMatchesLedger(
        originalDomainCursor,
        root.eventCount,
        originalDomainCursor.tailEventId,
        originalDomainCursor.eventCount - originalDomainCursor.hotStartIndex,
        'bounded decode shell',
      );
    }

    const lastStepGroups = lastStepContentGroups(shell.lastStep);
    const boundedHistory = decodeBoundedRunHistoryReverse(
      root,
      readChunk,
      hotStartIndex,
      requestedColdPins,
      lastStepGroups,
    );
    if (originalDomainCursor) {
      assertDomainHistoryCursorMatchesLedger(
        originalDomainCursor,
        root.eventCount,
        boundedHistory.tailEventId,
        originalDomainCursor.eventCount - originalDomainCursor.hotStartIndex,
        'bounded decode shell',
      );
    }

    const historyCursor: WorldHistoryCursorV1 = {
      version: 1,
      eventCount: root.eventCount,
      hotStartIndex,
      tailEventId: boundedHistory.tailEventId,
    };
    const lastStep = rebindLastStepToRetainedEvents(
      shell.lastStep,
      boundedHistory.pinnedEvents,
      boundedHistory.hotEvents,
      hotStartIndex,
      lastStepGroups,
      boundedHistory.ledgerOccurrencesByLastStepHash,
    );
    return {
      state: {
        ...shell,
        world: {
          ...shell.world,
          historyCursor,
          past: boundedHistory.hotEvents,
        },
        lastStep,
      },
      metadata: root,
      pinnedEvents: boundedHistory.pinnedEvents,
    };
  }

  /**
   * Generic bounded history decoder. It restores every shell field exactly and
   * therefore remains unsuitable for legacy roots whose observer blobs dominate
   * memory; gameplay continuation uses the closed profile below.
   */
  async function decodeSegmentedRunStateBounded(
    rootChunk: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    options: RunStateBoundedDecodeOptions,
  ): Promise<DecodedBoundedRunState> {
    const root = parseRunStateRoot(rootChunk);
    const shell = decodeRunStateShell(root, readChunk);
    return decodeSegmentedRunStateBoundedFromShell(rootChunk, readChunk, options, shell);
  }

  /**
   * Decode the closed schema-3 gameplay continuation profile. Large observer
   * history is carried opaquely, terminal rule objects are filtered in manifest
   * order, and no staged shell is returned before both shell and history seals
   * have succeeded.
   */
  async function decodeSegmentedRunStateGameplayBounded(
    rootChunkInput: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    options: RunStateGameplayBoundedDecodeOptions,
  ): Promise<DecodedBoundedGameplayRunState> {
    const rootChunk = snapshotRunStateChunk(rootChunkInput);
    const root = parseRunStateRoot(rootChunk);
    if (root.schemaVersion !== 3) {
      throw new Error('bounded gameplay decode 只接受 schemaVersion 3 root');
    }
    if (!options
      || !Number.isSafeInteger(options.hotEventLimit)
      || options.hotEventLimit < 0
      || !options.observerAuthority
      || options.observerAuthority.stateHash !== rootChunk.hash) {
      throw new Error('bounded gameplay decode options/observer authority 无效');
    }

    const accumulator = createBoundedGameplayShellAccumulator(options.observerAuthority);
    const receipt = await streamVerifiedSchema3GameplayShell(
      rootChunk,
      readChunk,
      accumulator.visitor,
    );
    assertVerifiedSchema3RunStateShellReceipt(receipt, rootChunk.hash);
    const gameplayShell = accumulator.finish(receipt);
    const { past: _emptyPast, ...world } = gameplayShell.state.world;
    if (_emptyPast.length !== 0) {
      throw new Error('bounded gameplay shell accumulator 非法预装 world.past');
    }
    const shell = {
      ...gameplayShell.state,
      world,
    } as SimulationStateShell;
    const decoded = await decodeSegmentedRunStateBoundedFromShell(
      rootChunk,
      readChunk,
      options,
      shell,
    );
    return {
      ...decoded,
      gameplayShell: Object.freeze({
        sourceArrayLengths: gameplayShell.sourceArrayLengths,
        retainedArrayLengths: gameplayShell.retainedArrayLengths,
      }),
    };
  }

  return {
    materializeVerifiedRunHistoryPinnedEvents,
    decodeSegmentedRunStateBounded,
    decodeSegmentedRunStateGameplayBounded,
  };
}
