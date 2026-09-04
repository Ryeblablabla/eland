import {
  applyAgentMemoryCompaction,
  nextAgentMemoryCompactionBatch,
  type AgentMemoryCompactionCapsuleInput,
} from '../src/game/eland/infrastructure-api';
import { livingPeople } from '../src/game/eland/domain/state-index';
import type { SimulationState, TokenUsage } from '../src/game/eland/simulation';
import { MEMORY_COMPACTION_SYSTEM_PROMPT_V2 } from './agent-prompt-templates';
import { requestModelText } from './model-client';
import { resolveModelEndpoint } from './model-config';

export interface MemoryCompactionResult {
  usage: TokenUsage;
  providerRequests: number;
  appliedCapsules: number;
  ownerId?: string;
}

function text(value: unknown, maximum = 360): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/gu, ' ').slice(0, maximum)
    : '';
}

function parseCapsules(value: unknown): AgentMemoryCompactionCapsuleInput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const capsules = (value as Record<string, unknown>).capsules;
  if (!Array.isArray(capsules)) return [];
  return capsules.slice(0, 4).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const raw = candidate as Record<string, unknown>;
    const summary = text(raw.summary);
    if (raw.lane !== 'semantic' && raw.lane !== 'procedural' && raw.lane !== 'social') return [];
    const lane = raw.lane;
    const sourceHandles = Array.isArray(raw.sourceHandles)
      ? [...new Set(raw.sourceHandles.map((handle) => text(handle, 24)).filter(Boolean))].slice(0, 64)
      : [];
    return summary && sourceHandles.length >= 1 ? [{
      summary,
      lane,
      sourceHandles,
      unresolved: raw.unresolved === true,
    }] : [];
  });
}

export async function compactOneAgentMemoryArchive(
  state: SimulationState,
  endpointId: string,
): Promise<MemoryCompactionResult> {
  const batch = [...livingPeople(state)]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((person) => nextAgentMemoryCompactionBatch(state, person, state.clock.elapsedMonths))
    .find((candidate) => candidate !== null);
  if (!batch) return {
    usage: { inputTokens: 0, outputTokens: 0 },
    providerRequests: 0,
    appliedCapsules: 0,
  };
  const endpoint = resolveModelEndpoint('decision', endpointId);
  const response = await requestModelText(endpoint, {
    messages: [
      { role: 'system', content: MEMORY_COMPACTION_SYSTEM_PROMPT_V2 },
      {
        role: 'user',
        content: JSON.stringify({
          schemaVersion: 'agent-memory-compaction-context-v3',
          person: batch.ownerName,
          throughMonth: batch.atMonth,
          existingCapsules: batch.existingCapsules.map((capsule) => ({
            handle: capsule.handle,
            lane: capsule.lane,
            summary: capsule.summary,
            sourceCount: capsule.sourceCount,
          })),
          memories: batch.sources.map((source) => ({
            handle: source.handle,
            lane: source.lane,
            when: source.firstExperiencedAtMonth === source.lastExperiencedAtMonth
              ? `第 ${source.lastExperiencedAtMonth} 月`
              : `第 ${source.firstExperiencedAtMonth}–${source.lastExperiencedAtMonth} 月`,
            memory: source.gist,
            unresolved: source.unresolved,
          })),
        }),
      },
    ],
    temperature: 0.2,
    maxOutputTokens: 800,
    jsonObject: true,
    timeoutMs: endpoint.timeoutMs,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    parsed = null;
  }
  const appliedCapsules = applyAgentMemoryCompaction(state, batch, parseCapsules(parsed));
  return {
    usage: response.usage,
    providerRequests: 1,
    appliedCapsules,
    ownerId: batch.ownerId,
  };
}
