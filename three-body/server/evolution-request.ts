import type { SimulationState } from '../src/game/eland/simulation';
import type { EvolutionPath } from './evolution-artifacts';
import type { PersistedRun } from './run-persistence';

export interface EvolutionExpectedIdentity {
  label: string;
  seed: number;
  civilizationNo: number;
  chaosIntensity: number;
  climateBias: SimulationState['civilization']['conditions']['climateBias'];
  endpoint: { kind: 'months'; value: number };
  fromMonth: number;
}

export type EvolutionRunRequest =
  | { kind: 'legacy'; months: number }
  | {
      kind: 'ensure-through';
      requestedEndMonth: number;
      expected: EvolutionExpectedIdentity;
    };

export class EvolutionRequestValidationError extends Error {}
export class EvolutionIdentityConflictError extends Error {}

export function evolutionExpectedBasisKey(expected: EvolutionExpectedIdentity): string {
  return JSON.stringify([
    expected.label,
    expected.seed,
    expected.civilizationNo,
    expected.chaosIntensity,
    expected.climateBias,
    expected.endpoint.kind,
    expected.endpoint.value,
    expected.fromMonth,
  ]);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvolutionRequestValidationError(`${field} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function integerValue(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new EvolutionRequestValidationError(`${field} 必须是不小于 ${minimum} 的整数`);
  }
  return value;
}

function expectedIdentity(value: unknown, requestedEndMonth: number): EvolutionExpectedIdentity {
  const expected = objectValue(value, 'expected');
  const endpoint = objectValue(expected.endpoint, 'expected.endpoint');
  if (typeof expected.label !== 'string'
    || !expected.label.trim()
    || expected.label !== expected.label.trim()
    || expected.label.length > 100) {
    throw new EvolutionRequestValidationError('expected.label 必须是长度 1-100 且无首尾空格的字符串');
  }
  if (typeof expected.seed !== 'number' || !Number.isInteger(expected.seed)) {
    throw new EvolutionRequestValidationError('expected.seed 必须是整数');
  }
  const civilizationNo = integerValue(expected.civilizationNo, 'expected.civilizationNo', 1);
  if (typeof expected.chaosIntensity !== 'number'
    || !Number.isInteger(expected.chaosIntensity)
    || expected.chaosIntensity < 0
    || expected.chaosIntensity > 10) {
    throw new EvolutionRequestValidationError('expected.chaosIntensity 必须是 0-10 的整数');
  }
  if (expected.climateBias !== 'balanced' && expected.climateBias !== 'cold' && expected.climateBias !== 'hot') {
    throw new EvolutionRequestValidationError('expected.climateBias 必须是 balanced、cold 或 hot');
  }
  if (endpoint.kind !== 'months') {
    throw new EvolutionRequestValidationError('expected.endpoint.kind 必须是 months');
  }
  const endpointValue = integerValue(endpoint.value, 'expected.endpoint.value', 1);
  const fromMonth = integerValue(expected.fromMonth, 'expected.fromMonth', 0);
  if (endpointValue !== requestedEndMonth) {
    throw new EvolutionRequestValidationError('expected.endpoint.value 必须等于 requestedEndMonth');
  }
  if (fromMonth > requestedEndMonth) {
    throw new EvolutionRequestValidationError('expected.fromMonth 不得晚于 requestedEndMonth');
  }
  return {
    label: expected.label,
    seed: expected.seed,
    civilizationNo,
    chaosIntensity: expected.chaosIntensity,
    climateBias: expected.climateBias,
    endpoint: { kind: 'months', value: endpointValue },
    fromMonth,
  };
}

export function parseEvolutionRunRequest(value: unknown): EvolutionRunRequest {
  const body = objectValue(value, '请求体');
  if (body.requestedEndMonth !== undefined) {
    if (body.months !== undefined) {
      throw new EvolutionRequestValidationError('months 与 requestedEndMonth 不能同时提供');
    }
    const requestedEndMonth = integerValue(body.requestedEndMonth, 'requestedEndMonth', 1);
    return {
      kind: 'ensure-through',
      requestedEndMonth,
      expected: expectedIdentity(body.expected, requestedEndMonth),
    };
  }
  const months = body.months === undefined ? 1 : Number(body.months);
  if (!Number.isFinite(months) || months < 1) {
    throw new EvolutionRequestValidationError('months 必须是正整数');
  }
  return { kind: 'legacy', months: Math.floor(months) };
}

function conflict(field: string, actual: unknown, expected: unknown): never {
  throw new EvolutionIdentityConflictError(
    `运行身份冲突：${field} 实际为 ${JSON.stringify(actual)}，预期为 ${JSON.stringify(expected)}`,
  );
}

export function assertEvolutionIdentity(
  run: PersistedRun,
  path: EvolutionPath | null,
  request: Extract<EvolutionRunRequest, { kind: 'ensure-through' }>,
): void {
  const { expected, requestedEndMonth } = request;
  const state = run.state;
  if (run.meta.label !== expected.label) conflict('label', run.meta.label, expected.label);
  if (state.seed !== expected.seed) conflict('seed', state.seed, expected.seed);
  if (state.civilization.number !== expected.civilizationNo) {
    conflict('civilizationNo', state.civilization.number, expected.civilizationNo);
  }
  if (state.civilization.conditions.civilizationNo !== expected.civilizationNo) {
    conflict('conditions.civilizationNo', state.civilization.conditions.civilizationNo, expected.civilizationNo);
  }
  if (state.civilization.conditions.chaosIntensity !== expected.chaosIntensity) {
    conflict('chaosIntensity', state.civilization.conditions.chaosIntensity, expected.chaosIntensity);
  }
  if (state.civilization.conditions.climateBias !== expected.climateBias) {
    conflict('climateBias', state.civilization.conditions.climateBias, expected.climateBias);
  }
  const endpoint = state.civilization.conditions.endpoint;
  if (endpoint.kind !== expected.endpoint.kind || endpoint.value !== expected.endpoint.value) {
    conflict('endpoint', endpoint, expected.endpoint);
  }
  const stateMonth = state.clock.elapsedMonths;
  if (stateMonth < expected.fromMonth || stateMonth > requestedEndMonth) {
    conflict('state.elapsedMonths', stateMonth, `${expected.fromMonth}..${requestedEndMonth}`);
  }
  if (!path) {
    if (stateMonth !== expected.fromMonth) conflict('state.elapsedMonths without path', stateMonth, expected.fromMonth);
    return;
  }
  if (path.runId !== run.meta.id) conflict('path.runId', path.runId, run.meta.id);
  if (path.fromMonth !== expected.fromMonth) conflict('path.fromMonth', path.fromMonth, expected.fromMonth);
  if (path.requestedEndMonth !== requestedEndMonth) {
    conflict('path.requestedEndMonth', path.requestedEndMonth, requestedEndMonth);
  }
  if (path.reachedMonth < expected.fromMonth || path.reachedMonth > stateMonth) {
    conflict('path.reachedMonth', path.reachedMonth, `${expected.fromMonth}..${stateMonth}`);
  }
}
