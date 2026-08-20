import type { SkySample } from '../societyContract';

interface FluxRange {
  min: number;
  max: number;
  sum: number;
  count: number;
}

export interface SkyObservation {
  time: number;
  flux: number;
  nearestStarDistance: number;
  fate: SkySample['fate'];
}

export interface PreparedSkySample {
  readonly sample: SkySample;
}

interface PendingSkySample {
  prepared: PreparedSkySample;
  range: FluxRange;
}

function emptyRange(): FluxRange {
  return { min: 1, max: 1, sum: 0, count: 0 };
}

function mergeRanges(left: FluxRange, right: FluxRange): FluxRange {
  if (left.count === 0) return { ...right };
  if (right.count === 0) return { ...left };
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
    sum: left.sum + right.sum,
    count: left.count + right.count,
  };
}

/**
 * Separates an observed sky interval from the last interval acknowledged by the
 * evolution service. Observations made while a request is in flight are kept in
 * the next interval; a failed request folds the attempted interval back in.
 */
export class TransactionalSkySampler {
  private committedTime = 0;
  private ready = emptyRange();
  private pending: PendingSkySample | null = null;
  private latest: SkyObservation | null = null;

  observe(observation: SkyObservation): void {
    this.latest = observation;
    const range = this.ready;
    range.min = range.count ? Math.min(range.min, observation.flux) : observation.flux;
    range.max = range.count ? Math.max(range.max, observation.flux) : observation.flux;
    range.sum += observation.flux;
    range.count += 1;
  }

  prepare(fallbackFate: SkySample['fate']): PreparedSkySample {
    if (this.pending) throw new Error('已有天空采样正在等待演化后端确认');
    const current = this.latest;
    const range = this.ready;
    const flux = current?.flux ?? 1;
    const prepared: PreparedSkySample = {
      sample: {
        fromTime: this.committedTime,
        toTime: current?.time ?? this.committedTime,
        fluxMean: range.count ? range.sum / range.count : flux,
        fluxMin: range.count ? range.min : flux,
        fluxMax: range.count ? range.max : flux,
        nearestStarDistance: current?.nearestStarDistance ?? 1,
        fate: current?.fate ?? fallbackFate,
      },
    };
    this.pending = { prepared, range };
    this.ready = emptyRange();
    return prepared;
  }

  commit(prepared: PreparedSkySample): boolean {
    if (this.pending?.prepared !== prepared) return false;
    this.committedTime = prepared.sample.toTime;
    this.pending = null;
    return true;
  }

  rollback(prepared: PreparedSkySample): boolean {
    if (this.pending?.prepared !== prepared) return false;
    this.ready = mergeRanges(this.pending.range, this.ready);
    this.pending = null;
    return true;
  }

  restore(sample: SkySample): void {
    this.committedTime = sample.toTime;
    this.ready = emptyRange();
    this.pending = null;
    this.latest = null;
  }

  reset(): void {
    this.committedTime = 0;
    this.ready = emptyRange();
    this.pending = null;
    this.latest = null;
  }
}
