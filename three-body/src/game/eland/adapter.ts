/** 领域状态到 UI 读取模型的纯投影。 */
import type { EraKey, SocietyState } from '../societyContract';
import type { ClimateKind, EpochKind, SimulationState, WorldEvent } from './simulation';
import { calendarDate } from './domain/calendar';

export const ERA_TO_ENV: Record<EraKey, { epoch: EpochKind; kind: ClimateKind; severity: number }> = {
  stable: { epoch: 'stable', kind: 'temperate', severity: 1 },
  chaotic: { epoch: 'chaotic', kind: 'temperate', severity: 4 },
  'chaotic-heat': { epoch: 'chaotic', kind: 'heat', severity: 7 },
  'chaotic-cold': { epoch: 'chaotic', kind: 'cold', severity: 7 },
  burned: { epoch: 'chaotic', kind: 'fire', severity: 10 },
  frozen: { epoch: 'chaotic', kind: 'cold', severity: 10 },
  extinct: { epoch: 'chaotic', kind: 'fire', severity: 10 },
};

const dense = (value: ArrayLike<number>): number[] => Array.from(value);

export function toSocietyState(state: SimulationState): SocietyState {
  const { grid } = state.world;
  return {
    world: {
      width: grid.width,
      height: grid.height,
      generator: grid.generator,
      cells: {
        terrainKind: dense(grid.cells.terrainKind),
        elevation: dense(grid.cells.elevation),
        fertility: dense(grid.cells.fertility),
        waterDepth: dense(grid.cells.waterDepth),
        surfaceCover: dense(grid.cells.surfaceCover),
        moisture: dense(grid.cells.moisture),
        temperature: dense(grid.cells.temperature),
        vegetation: dense(grid.cells.vegetation),
        fire: dense(grid.cells.fire),
        ice: dense(grid.cells.ice),
      },
      traces: {
        traffic: dense(grid.traces.traffic),
        rest: dense(grid.traces.rest),
        gathering: dense(grid.traces.gathering),
        cultivation: dense(grid.traces.cultivation),
        care: dense(grid.traces.care),
        trade: dense(grid.traces.trade),
        burial: dense(grid.traces.burial),
      },
    },
    agents: state.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.profile.personality.summary,
      cellId: agent.position.cellId,
      previousCellId: agent.position.previousCellId,
      lastPath: agent.position.lastPath,
      state: agent.body.state,
      doing: agent.limbs.actionText,
      ...(agent.activePlanId ? { activePlanId: agent.activePlanId } : {}),
      sex: agent.body.sex,
      lifespanMonths: agent.body.lifespanMonths,
      generation: agent.lineage.generation,
      respect: agent.standing.respect,
      mind: {
        want: agent.mind.needs.focus,
        choice: agent.mind.cognition.choice,
        ought: agent.mind.cognition.interpretation,
      },
      needs: agent.mind.needs.layers.map((need) => ({
        level: need.level,
        label: need.label,
        intensity: need.intensity,
        dominant: need.level === agent.mind.needs.dominantLevel,
      })),
      body: {
        health: agent.body.health,
        nutrition: agent.body.nutrition,
        hydration: agent.body.hydration,
        fatigue: agent.body.fatigue,
        ageMonths: agent.body.ageMonths,
      },
    })),
    matter: state.world.matter.flatMap((matter) => matter.holder.kind === 'cell' ? [{
      id: matter.id,
      kind: matter.kind,
      name: matter.name,
      cellId: matter.holder.cellId,
      quantity: matter.quantity,
      traits: matter.traits,
    }] : []),
    structures: state.world.structures.map((structure) => ({
      id: structure.id,
      name: structure.name ?? '未命名结构',
      occupiedCells: structure.occupiedCells,
      interiorCells: structure.interiorCells,
      componentCount: structure.componentIds.length,
      complete: structure.effects.accessible,
      effects: {
        structuralStability: structure.effects.structuralStability,
        weatherProtection: structure.effects.weatherProtection,
        thermalInsulation: structure.effects.thermalInsulation,
        enclosure: structure.effects.enclosure,
        capacity: structure.effects.capacity,
      },
      useCount: structure.useEventIds.length,
      sourceEventIds: structure.sourceEventIds,
    })),
    components: state.world.components.map((component) => ({
      id: component.id,
      structureId: component.structureId,
      kind: component.kind,
      cellId: component.cellId,
      integrity: component.integrity,
    })),
    plans: state.plans.map((plan) => ({
      id: plan.id,
      ownerId: plan.ownerId,
      objective: plan.objective,
      mode: plan.mode,
      status: plan.status,
      targetCellId: plan.target.cellId,
      progress: plan.progress,
      createdAtMonth: plan.createdAtMonth,
      lastProgressAtMonth: plan.lastProgressAtMonth,
    })),
    regions: state.derived.regions.map(({ id, kind, cells, confidence, label }) => ({ id, kind, cells, confidence, ...(label ? { label } : {}) })),
    observations: {
      practices: state.derived.practices.map(({ key, label, count, stability }) => ({ key, label, count, stability })),
      institutions: state.derived.institutions.map(({ key, label, note }) => ({ key, label, note })),
      milestones: state.derived.milestones.map(({ id, label, note }) => ({ id, label, note })),
    },
  };
}

export function eventToChronicle(event: WorldEvent): { text: string; tone: 'plain' | 'good' | 'bad' | 'era' } | null {
  if (event.kind === 'decision-opportunity' && !event.triggered) return null;
  const tone = event.kind === 'environment' && event.change === 'death'
    ? 'bad'
    : event.kind === 'plan-progress' && event.status === 'completed'
      ? 'good'
      : event.kind === 'environment' && event.change === 'climate'
        ? 'era'
        : 'plain';
  return { text: `${calendarDate(event.atMonth).label}：${event.result}`, tone };
}

export function monthSpeaker(state: SimulationState, events: WorldEvent[]): string | null {
  const person = [...events].reverse().find((event) => 'who' in event && event.who);
  return person && 'who' in person ? state.agents.find((agent) => agent.id === person.who)?.name ?? null : null;
}
