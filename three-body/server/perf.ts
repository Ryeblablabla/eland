import { performance } from 'node:perf_hooks';

const PERF_ENABLED = /^(?:1|true|yes|on)$/iu.test(process.env.ELAND_PERF_LOG ?? '');

export function perfNow(): number {
  return performance.now();
}

export function perfElapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function logPerf(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!PERF_ENABLED) return;
  console.info(JSON.stringify({ scope: 'eland-perf', event, ...fields }));
}

export function isPerfLoggingEnabled(): boolean {
  return PERF_ENABLED;
}
