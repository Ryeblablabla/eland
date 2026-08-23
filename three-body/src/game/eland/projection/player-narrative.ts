import type { NarrativeEntryView } from '../../societyContract';
import type { SimulationState, WorldEvent } from '../simulation';
import type { HolderRef } from '../domain/action';
import { animalSpecies, type AnimalSpeciesId } from '../domain/animal';
import { Material, materialDefinition } from '../domain/material';

type ActionEvent = Extract<WorldEvent, { kind: 'action' }>;
type DecisionEvent = Extract<WorldEvent, { kind: 'decision' }>;
type EnvironmentEvent = Extract<WorldEvent, { kind: 'environment' }>;
type AgreementEvent = Extract<WorldEvent, { kind: 'agreement' }>;
type AnimalAttackEvent = EnvironmentEvent & {
  change: 'animal';
  diff: EnvironmentEvent['diff'] & { process: 'attack-human' };
};

interface NarrativeCandidate extends NarrativeEntryView {
  orderInMonth: number;
  dedupeKey?: string;
}

interface DeathAttackEvidence {
  sourceEventIds: string[];
  sourceEvents: WorldEvent[];
  attacks: AnimalAttackEvent[];
  directAttacks: AnimalAttackEvent[];
}

interface BodySnapshot {
  health: number;
  hydration: number;
  nutrition: number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function briefNameList(names: string[]): string {
  if (names.length <= 2) return names.join('和');
  if (names.length === 3) return `${names[0]}、${names[1]}和${names[2]}`;
  return `${names[0]}等${names.length}人`;
}

function personName(state: SimulationState, personId: string | undefined): string {
  return state.people.find((person) => person.id === personId)?.name ?? '某人';
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function displayNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, '');
}

function bodySnapshot(value: unknown): BodySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const health = finiteNumber(record.health);
  const hydration = finiteNumber(record.hydration);
  const nutrition = finiteNumber(record.nutrition);
  return health === null || hydration === null || nutrition === null
    ? null
    : { health, hydration, nutrition };
}

const BODY_FIELD_LABELS: Record<keyof BodySnapshot, string> = {
  health: '健康',
  hydration: '水分',
  nutrition: '营养',
};

const BODY_CAUSE_LABELS: Record<string, string> = {
  dehydration: '缺水',
  malnutrition: '营养不足',
  'heat-exposure': '炎热暴露',
  drought: '干旱',
  'cold-exposure': '寒冷暴露',
  illness: '疾病',
  wound: '伤势',
  'dehydrated-hibernation': '脱水休眠消耗',
  aging: '衰老与低储备叠加',
  pregnancy: '妊娠负担',
  'postpartum-recovery': '产后恢复负担',
  'resource-competition': '人口资源竞争',
  'favorable-recovery': '食水充足且获得环境保护',
};

function bodyEventSnapshots(event: EnvironmentEvent): { before: BodySnapshot | null; after: BodySnapshot | null } {
  const before = bodySnapshot(event.diff.bodyBefore);
  const after = bodySnapshot(event.diff.bodyAfter) ?? bodySnapshot({
    health: event.diff.health,
    hydration: event.diff.hydration,
    nutrition: event.diff.nutrition,
  });
  return { before, after };
}

function bodyCauseLabels(event: EnvironmentEvent, after: BodySnapshot | null): string[] {
  const stored = stringIds(event.diff.bodyCauseCodes);
  const inferred = [
    ...(event.diff.hibernationMonthlySettlement === true ? ['dehydrated-hibernation'] : []),
    ...(after && after.hydration < 25 ? ['dehydration'] : []),
    ...(after && after.nutrition < 25 ? ['malnutrition'] : []),
  ];
  return unique([...stored, ...inferred]).map((code) => BODY_CAUSE_LABELS[code] ?? code);
}

function bodyEventPlayerText(state: SimulationState, event: EnvironmentEvent): string {
  const name = personName(state, event.who);
  const { before, after } = bodyEventSnapshots(event);
  const causes = bodyCauseLabels(event, after);
  if (before && after) {
    const changes = (Object.keys(BODY_FIELD_LABELS) as (keyof BodySnapshot)[])
      .filter((field) => Math.abs(after[field] - before[field]) >= 0.05)
      .map((field) => `${BODY_FIELD_LABELS[field]} ${displayNumber(before[field])}→${displayNumber(after[field])}`);
    const deltas = (Object.keys(BODY_FIELD_LABELS) as (keyof BodySnapshot)[])
      .map((field) => after[field] - before[field]);
    const stateLabel = deltas.some((delta) => delta < -0.05)
      ? '身体储备下降'
      : deltas.some((delta) => delta > 0.05)
        ? '身体有所恢复'
        : '身体储备处于警戒状态';
    return finishSentence(`${name}${stateLabel}${changes.length ? `：${changes.join('，')}` : ''}${causes.length ? `；原因：${causes.join('、')}` : ''}`);
  }
  if (after) {
    const healthDelta = finiteNumber(event.diff.healthDelta);
    const current = (Object.keys(BODY_FIELD_LABELS) as (keyof BodySnapshot)[])
      .map((field) => `${BODY_FIELD_LABELS[field]} ${displayNumber(after[field])}`)
      .join('，');
    return finishSentence(`${name}当前身体储备：${current}${healthDelta !== null && Math.abs(healthDelta) >= 0.05 ? `；健康变化 ${healthDelta > 0 ? '+' : ''}${displayNumber(healthDelta)}` : ''}${causes.length ? `；原因：${causes.join('、')}` : ''}`);
  }
  return finishSentence(event.result);
}

export function bodyHistoryLabel(event: WorldEvent): string {
  if (event.kind !== 'environment' || event.change !== 'body') return '身体变化';
  const { before, after } = bodyEventSnapshots(event);
  if (before && after) {
    const deltas = (Object.keys(BODY_FIELD_LABELS) as (keyof BodySnapshot)[])
      .map((field) => after[field] - before[field]);
    if (deltas.some((delta) => delta < -0.05)) return '身体恶化';
    if (deltas.some((delta) => delta > 0.05)) return '身体恢复';
  }
  const healthDelta = finiteNumber(event.diff.healthDelta);
  if (healthDelta !== null && healthDelta < -0.05) return '身体恶化';
  if (after && (after.hydration < 25 || after.nutrition < 25)) return '身体警戒';
  return healthDelta !== null && healthDelta > 0.05 ? '身体恢复' : '身体变化';
}

function isAnimalSpeciesId(value: unknown): value is AnimalSpeciesId {
  return value === 'deer' || value === 'rabbit' || value === 'boar' || value === 'wolf';
}

function isAnimalAttackEvent(event: WorldEvent | undefined): event is AnimalAttackEvent {
  return event?.kind === 'environment'
    && event.change === 'animal'
    && event.diff.process === 'attack-human';
}

function animalNameForAttack(state: SimulationState, event: EnvironmentEvent): string {
  const animalId = typeof event.diff.animalId === 'string' ? event.diff.animalId : undefined;
  const animal = animalId ? state.world.animals?.find((candidate) => candidate.id === animalId) : undefined;
  const speciesId = animal?.speciesId ?? event.diff.animalSpeciesId;
  if (isAnimalSpeciesId(speciesId)) return animalSpecies(speciesId).name;
  return event.result.match(/^(.+?)(?:袭击|在被近身时冲撞)/u)?.[1] ?? '野兽';
}

function animalAttackDetail(event: EnvironmentEvent): string {
  const healthBefore = finiteNumber(event.diff.healthBefore);
  const healthAfter = finiteNumber(event.diff.healthAfter);
  const woundStageBefore = finiteNumber(event.diff.woundStageBefore);
  const woundStageAfter = finiteNumber(event.diff.woundStageAfter);
  return unique([
    event.result,
    healthBefore !== null && healthAfter !== null
      ? `健康值 ${displayNumber(healthBefore)}→${displayNumber(healthAfter)}`
      : '',
    woundStageBefore !== null && woundStageAfter !== null
      ? `伤势阶段 ${displayNumber(woundStageBefore)}→${displayNumber(woundStageAfter)}`
      : '',
  ].filter(Boolean)).join('；');
}

const WEATHER_NAMES: Record<string, string> = {
  clear: '晴朗',
  rain: '降雨',
  storm: '风暴',
  drought: '干旱',
  snow: '降雪',
  fog: '浓雾',
};

const CLIMATE_NAMES: Record<string, string> = {
  temperate: '温和',
  cold: '寒冷',
  heat: '炎热',
  fire: '烈火',
};

const EPOCH_NAMES: Record<string, string> = {
  stable: '恒纪元',
  chaotic: '乱纪元',
};

const HISTORICAL_WEATHER_KINDS = new Set(['storm', 'drought', 'snow']);

function weatherName(value: unknown): string {
  return typeof value === 'string' ? WEATHER_NAMES[value] ?? value : '未知天气';
}

function climateName(value: unknown): string {
  return typeof value === 'string' ? CLIMATE_NAMES[value] ?? value : '未知气候';
}

function epochName(value: unknown): string {
  return typeof value === 'string' ? EPOCH_NAMES[value] ?? value : '未知纪元';
}

function climateHistoryCandidate(event: EnvironmentEvent): NarrativeCandidate | null {
  if (event.change !== 'climate') return null;
  const epoch = typeof event.diff.epoch === 'string' ? event.diff.epoch : undefined;
  const previousEpoch = typeof event.diff.previousEpoch === 'string'
    ? event.diff.previousEpoch
    : epoch === 'stable' ? 'chaotic' : epoch === 'chaotic' ? 'stable' : undefined;
  const kind = typeof event.diff.kind === 'string' ? event.diff.kind : undefined;
  const previousKind = typeof event.diff.previousKind === 'string' ? event.diff.previousKind : undefined;
  const severity = finiteNumber(event.diff.severity);
  const previousSeverity = finiteNumber(event.diff.previousSeverity);
  const epochChanged = event.diff.eraTransition === true || event.diff.epochChanged === true;
  const kindChanged = event.diff.climateKindChanged === true
    && kind !== undefined && previousKind !== undefined && kind !== previousKind;
  if (!epochChanged && !kindChanged) return null;

  const initialObservation = event.atMonth <= 1;
  const text = initialObservation
    ? `文明开端处于${epochName(epoch)}，地表为${climateName(kind)}`
    : epochChanged
      ? `${epochName(previousEpoch)}结束，${epochName(epoch)}开始，地表${epoch === 'stable' ? '恢复' : '转为'}${climateName(kind)}`
      : `${epochName(epoch)}中，地表气候由${climateName(previousKind)}转为${climateName(kind)}`;
  return {
    id: `narrative:${event.id}`,
    month: event.atMonth,
    text: finishSentence(text),
    detail: unique([
      event.result,
      epochChanged && !initialObservation ? `纪元 ${epochName(previousEpoch)}→${epochName(epoch)}` : '',
      kindChanged ? `气候 ${climateName(previousKind)}→${climateName(kind)}` : '',
      severity !== null && previousSeverity !== null
        ? `严酷度 ${displayNumber(previousSeverity)}→${displayNumber(severity)}`
        : severity !== null ? `严酷度 ${displayNumber(severity)}` : '',
    ].filter(Boolean)).join('；'),
    tone: epochChanged ? 'era' : kind === 'temperate' ? 'good' : 'bad',
    kind: 'epoch',
    importance: epochChanged ? 132 : 94,
    sourceEventIds: [event.id],
    actorIds: [],
    orderInMonth: event.orderInMonth,
  };
}

function weatherHistoryCandidate(event: EnvironmentEvent): NarrativeCandidate | null {
  if (event.change !== 'weather') return null;
  const kind = typeof event.diff.kind === 'string' ? event.diff.kind : undefined;
  const previousKind = typeof event.diff.previousKind === 'string' ? event.diff.previousKind : undefined;
  const intensity = finiteNumber(event.diff.intensity);
  const previousIntensity = finiteNumber(event.diff.previousIntensity);
  const kindChanged = event.diff.episodeStarted === true
    && kind !== undefined && previousKind !== undefined && kind !== previousKind;
  const initialObservation = event.atMonth <= 1;
  const historicallyMeaningfulKindChange = kindChanged && (
    HISTORICAL_WEATHER_KINDS.has(kind)
    || HISTORICAL_WEATHER_KINDS.has(previousKind)
    || (kind !== 'clear' && intensity !== null && intensity >= 2)
    || (previousKind !== 'clear' && previousIntensity !== null && previousIntensity >= 2)
  );
  const becameHighImpact = event.diff.episodeStarted === false && kind !== 'clear'
    && intensity !== null && previousIntensity !== null && previousIntensity < 2 && intensity >= 2;
  const leftHighImpact = event.diff.episodeStarted === false && kind !== 'clear'
    && intensity !== null && previousIntensity !== null && previousIntensity >= 2 && intensity < 2;
  if (!historicallyMeaningfulKindChange && !becameHighImpact && !leftHighImpact) return null;
  const currentName = weatherName(kind);
  const text = historicallyMeaningfulKindChange
    ? initialObservation
      ? `文明开端天气为${currentName}`
      : `天气由${weatherName(previousKind)}转为${currentName}`
    : becameHighImpact
      ? `${currentName}强度升至 ${displayNumber(intensity ?? 2)}`
      : `${currentName}强度降至 ${displayNumber(intensity ?? 1)}`;
  const adverse = kind === 'storm' || kind === 'drought' || becameHighImpact;
  return {
    id: `narrative:${event.id}`,
    month: event.atMonth,
    text: finishSentence(text),
    detail: unique([
      event.result,
      historicallyMeaningfulKindChange && !initialObservation
        ? `天气过程 ${weatherName(previousKind)}→${currentName}`
        : '',
      intensity !== null && previousIntensity !== null
        ? `强度 ${displayNumber(previousIntensity)}→${displayNumber(intensity)}`
        : intensity !== null ? `强度 ${displayNumber(intensity)}` : '',
    ].filter(Boolean)).join('；'),
    tone: kind === 'clear' ? 'good' : adverse ? 'bad' : 'plain',
    kind: 'epoch',
    importance: becameHighImpact ? 92 : leftHighImpact ? 84 : adverse ? 88 : 80,
    sourceEventIds: [event.id],
    actorIds: [],
    orderInMonth: event.orderInMonth,
  };
}

function eventLookup(state: SimulationState, events: WorldEvent[]): Map<string, WorldEvent> {
  return new Map([...state.world.past, ...events].map((event) => [event.id, event]));
}

function deathAttackEvidence(event: EnvironmentEvent, eventsById: Map<string, WorldEvent>): DeathAttackEvidence {
  const personId = event.who ?? (typeof event.diff.personId === 'string' ? event.diff.personId : undefined);
  const sourceEventIds = unique(stringIds(event.diff.sourceEventIds));
  const sourceEvents = sourceEventIds.flatMap((eventId) => {
    const source = eventsById.get(eventId);
    return source ? [source] : [];
  });
  const attacks = sourceEvents.filter((source): source is AnimalAttackEvent => (
    isAnimalAttackEvent(source)
      && (source.diff.victimId === personId || (source.diff.victimId === undefined && source.who === personId))
  ));
  const directAttacks = attacks.filter((attack) => {
    const healthAfter = finiteNumber(attack.diff.healthAfter);
    return healthAfter !== null && healthAfter <= 0;
  });
  return { sourceEventIds, sourceEvents, attacks, directAttacks };
}

function finishSentence(text: string): string {
  const clean = text.trim().replace(/[：；，、]+$/u, '');
  return /[。！？]$/u.test(clean) ? clean : `${clean}。`;
}

function stripSentenceEnd(text: string): string {
  return text.trim().replace(/[。！？]+$/u, '');
}

function concisePlayerText(value: string, max = 96): string {
  const clean = value
    .replace(/\s+/gu, ' ')
    .replace(/[}\]'’"“”`]+$/gu, '')
    .replaceAll('物质', '材料')
    .replaceAll('体素', '位置')
    .replaceAll('近身范围', '身边')
    .replaceAll('施力', '加工')
    .replaceAll('是否愿意共同生育后代', '愿不愿意一起要个孩子')
    .trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const boundary = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'));
  return boundary >= Math.floor(max * 0.55) ? head.slice(0, boundary + 1) : `${head}…`;
}

function naturalIntent(summary: string): string {
  return stripSentenceEnd(summary)
    .replace(/^持续观察/u, '继续观察')
    .replace(/^取得/u, '拿到')
    .replace(/^食用/u, '吃下')
    .replace(/^接近并饮用地表水$/u, '去水边喝水')
    .replace(/^走向尚未熟悉的地表$/u, '去看看陌生的地方')
    .replace(/^主动进入/u, '进入');
}

function naturalReason(actor: string, reason: string): string | null {
  const clean = stripSentenceEnd(reason);
  const seenGround = clean.match(/^看见地上的(.+)$/u);
  if (seenGround) return `${actor}看见地上有${seenGround[1]}`;
  if (clean === '眼前物质尚未形成可靠认识') return `${actor}还不熟悉眼前的材料`;
  if (clean === '这种活体的行为还没有形成可靠认识') return `${actor}还不了解这种动物的习性`;
  if (clean === '探索可能发现新的物质与路径') return `${actor}想看看附近还有什么`;
  if (clean === '背包里有可食物质') return `${actor}背包里正好有食物`;
  if (clean === '看见邻近地表水') return `${actor}看见附近有水`;
  if (clean === '记得一处仍存在且可以走到的水源') return `${actor}记得附近有一处水源`;
  if (clean === '自己已有这项物质经验') return `${actor}知道这种做法可行`;
  if (clean === '背包中的两种物质可以尝试局部结合，但结果未知') return `${actor}想试试手头的材料能不能组合`;
  if (/压力 \d|当前|本地规则|规划|合法目标|可执行|意图|状态目标|物质响应|局部施力|来源事实|项目缺口|需求项|规则签名/u.test(clean)) return null;
  if (clean.length > 28) return null;
  return clean ? `${actor}${clean.replaceAll('物质', '材料').replaceAll('近身', '身边')}` : null;
}

function humanizeFailure(result: string): string {
  const exact: Record<string, string> = {
    '目标地表当前不可达': '去不了目标位置',
    '来源中已经没有这种物质': '原来的地方已经没有可拿的材料了',
    '物品持有者不在近身范围': '物品持有者已经不在身边',
    '接收者不在近身范围': '接收者已经不在身边',
    '目标容器不在近身操作范围': '储物容器离得太远',
    '目标容器已经没有可用容量': '储物容器已经装满了',
    '这些随身物质当前没有可发生的结合规则': '手头这些材料没能组合出新东西',
    '这些物质当前没有可发生的结合规则': '这些材料没能组合出新东西',
    '这些物质当前没有可发生的施力响应': '这次加工没有产生变化',
    '背包中的结合材料已经不存在': '需要的材料已经不在背包里',
    '背包中的结合材料数量不足': '背包里的材料不够',
    '背包中的材料已经不存在': '需要的材料已经不在背包里',
    '目标空气体素正被身体占据，不能放入固体物质': '目标位置被人占着，暂时放不下材料',
    '观察目标超出感知范围': '观察对象离得太远',
  };
  return exact[result] ?? result
    .replaceAll('体素', '位置')
    .replaceAll('物质', '材料')
    .replaceAll('近身范围', '身边')
    .replaceAll('施力', '加工');
}

function holderName(state: SimulationState, holder: HolderRef): string {
  if (holder.kind === 'ground') return '地上';
  if (holder.kind === 'container') return '储物容器';
  return personName(state, holder.personId);
}

function materialName(materialId: unknown): string {
  const id = Number(materialId);
  if (!Number.isInteger(id)) return '材料';
  const name = materialDefinition(id).name;
  return name === '石' ? '石头' : name;
}

function materialAmounts(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const quantity = Number(value.quantity);
    if (!Number.isFinite(quantity)) return [];
    return [`${Math.max(1, quantity)}份${materialName(value.materialId)}`];
  }).join('和');
}

function placedStructureText(event: ActionEvent, actor: string, outputId: number): string | null {
  const position = event.diff.position;
  if (!position || typeof position !== 'object') return null;
  const definition = materialDefinition(outputId);
  if (!definition.tags.some((tag) => tag === 'building' || tag === 'placeable' || tag === 'facility')) return null;
  const inputId = Number(event.diff.inputMaterialId);
  const targetId = Number(event.diff.targetMaterialId);
  if (targetId === Material.Air) {
    if (Number.isInteger(inputId) && inputId !== outputId) {
      return `${actor}把${materialName(inputId)}加工成${materialName(outputId)}，用于搭建`;
    }
    return definition.tags.includes('placeable') || definition.tags.includes('facility')
      ? `${actor}安放了${materialName(outputId)}`
      : `${actor}把${materialName(outputId)}放在了搭建处`;
  }
  if (Number.isInteger(inputId) && Number.isInteger(targetId)) {
    return `${actor}用${materialName(inputId)}把${materialName(targetId)}改造成了${materialName(outputId)}`;
  }
  return `${actor}安放了${materialName(outputId)}`;
}

function dialogueText(state: SimulationState, event: ActionEvent, actor: string): string {
  if (event.action.kind !== 'communicate') return event.result;
  const audience = event.action.audience.map((id) => personName(state, id)).join('、') || '身边的人';
  const content = event.action.content;
  if (content.kind === 'accept') return `${actor}接受了${audience}的提议`;
  if (content.kind === 'reject') return `${actor}拒绝了${audience}的提议`;
  if (content.kind === 'revoke-agreement') return `${actor}向${audience}撤回了尚未执行的生殖同意`;
  if (content.kind === 'withdraw') return `${actor}告诉${audience}，自己将退出共同体`;
  if (content.kind === 'revoke') return `${actor}撤回了给${audience}的取用许可`;
  return `${actor}对${audience}说：${concisePlayerText(content.summary)}`;
}

function transferText(state: SimulationState, event: ActionEvent, actor: string): string {
  if (event.action.kind !== 'transfer') return event.result;
  const action = event.action;
  const quantity = Number(event.diff.quantity ?? action.quantity);
  const amount = `${Math.max(1, quantity)}份${materialName(event.diff.materialId ?? action.materialId)}`;
  const authorized = event.diff.authorized !== false;
  if (action.from.kind === 'ground' && action.to.kind === 'person' && action.to.personId === event.who) {
    return `${actor}${authorized ? '捡起了' : '拿走了'}${amount}`;
  }
  if (action.from.kind === 'person' && action.from.personId === event.who && action.to.kind === 'person') {
    return `${actor}把${amount}交给了${personName(state, action.to.personId)}`;
  }
  if (action.from.kind === 'person' && action.to.kind === 'person' && action.to.personId === event.who) {
    return `${actor}${authorized ? '从' : '擅自从'}${personName(state, action.from.personId)}那里拿了${amount}`;
  }
  if (action.from.kind === 'container' && action.to.kind === 'person') return `${actor}从储物容器里取出了${amount}`;
  if (action.to.kind === 'container') return `${actor}把${amount}放进了储物容器`;
  if (action.to.kind === 'ground') return `${actor}把${amount}放在了地上`;
  return `${actor}把${amount}从${holderName(state, action.from)}移到了${holderName(state, action.to)}`;
}

function verifiedAirCombination(state: SimulationState, event: ActionEvent): { inputId: number; outputId: number } | null {
  if (event.action.kind !== 'attend' || event.diff.verifiedTechnique !== true) return null;
  const verifiedSourceEventId = typeof event.diff.verifiedSourceEventId === 'string'
    ? event.diff.verifiedSourceEventId
    : undefined;
  const source = verifiedSourceEventId
    ? state.world.past.find((candidate) => candidate.id === verifiedSourceEventId)
    : undefined;
  if (source?.kind === 'action'
    && source.action.kind === 'act'
    && source.action.operation === 'combine'
    && Number(source.diff.targetMaterialId) === Material.Air) {
    const inputId = Number(source.diff.inputMaterialId);
    const outputId = Number(source.diff.outputMaterialId);
    if (Number.isInteger(inputId) && Number.isInteger(outputId)) return { inputId, outputId };
  }
  const techniqueId = event.action.verification?.techniqueId
    ?? (typeof event.diff.factId === 'string' ? event.diff.factId : '');
  const match = techniqueId.match(/^technique:combine:(\d+):(\d+):(\d+)$/u);
  if (!match) return null;
  const [, inputId, targetId, outputId] = match.map(Number);
  return targetId === Material.Air ? { inputId, outputId } : null;
}

function attendText(state: SimulationState, event: ActionEvent, actor: string): string {
  const airCombination = verifiedAirCombination(state, event);
  if (airCombination) {
    return airCombination.inputId === airCombination.outputId
      ? `${actor}确认${materialName(airCombination.outputId)}可以直接安放`
      : `${actor}确认搭建时可以把${materialName(airCombination.inputId)}加工成${materialName(airCombination.outputId)}`;
  }
  const recognized = event.result.match(/^观察并辨认了(.+)$/u);
  if (recognized) return `${actor}仔细观察后，认出了${recognized[1]}`;
  const verified = event.result.match(/^核验了(.+)$/u);
  if (verified) return `${actor}通过观察，确认了${verified[1]}`;
  return event.result.startsWith(actor) ? event.result : `${actor}${event.result}`;
}

function actText(state: SimulationState, event: ActionEvent, actor: string): string {
  if (event.action.kind !== 'act') return event.result;
  const operation = event.action.operation;
  if (operation === 'ingest') {
    const definition = materialDefinition(Number(event.diff.materialId ?? Material.Food));
    return definition.tags.includes('drinkable') && !definition.tags.includes('edible')
      ? `${actor}喝了${definition.name}`
      : `${actor}吃下了1份${definition.name}`;
  }
  if (operation === 'combine') {
    const outputId = Number(event.diff.outputMaterialId);
    if (Number.isInteger(outputId)) {
      const placement = placedStructureText(event, actor, outputId);
      if (placement) return placement;
      const inputIds = Array.isArray(event.diff.inputMaterialIds)
        ? event.diff.inputMaterialIds.map(Number)
        : [Number(event.diff.inputMaterialId), Number(event.diff.targetMaterialId)].filter((id) => Number.isInteger(id) && id !== Material.Air);
      const inputs = inputIds.map(materialName).join('和');
      return `${actor}用${inputs || '手头的材料'}做出了${materialName(outputId)}`;
    }
  }
  if (operation === 'exert') {
    if (typeof event.diff.victimId === 'string') return `${actor}动手伤害了${personName(state, event.diff.victimId)}`;
    const outputId = Number(event.diff.outputMaterialId);
    if (Number.isInteger(outputId)) {
      return `${actor}用${materialName(event.diff.toolMaterialId)}加工${materialName(event.diff.inputMaterialId)}，做出了${materialName(outputId)}`;
    }
  }
  if (operation === 'expose') {
    const outputId = Number(event.diff.outputMaterialId);
    if (Number.isInteger(outputId)) {
      return `${actor}把${materialName(event.diff.inputMaterialId)}放到${materialName(event.diff.targetMaterialId)}旁，得到了${materialName(outputId)}`;
    }
  }
  if (operation === 'reproduce' && event.diff.conceived === false) {
    const partner = event.action.targets.find((target): target is Extract<typeof target, { kind: 'person' }> => target.kind === 'person');
    const partnerName = partner ? personName(state, partner.personId) : '';
    const woman = state.people.find((person) => (
      person.id === event.who || person.id === partner?.personId
    ) && person.sex === 'female');
    return partner
      ? `${actor}和${partnerName}想要个孩子，但${woman ? woman.name : '这次'}没有怀上`
      : `${actor}想要个孩子，但这次没有怀上`;
  }
  if (operation === 'reproduce' && event.diff.conceived === true) {
    return `${personName(state, typeof event.diff.femaleId === 'string' ? event.diff.femaleId : event.who)}怀孕了`;
  }
  if (operation === 'separate') {
    if (typeof event.diff.releasedPersonId === 'string') return `${actor}帮${personName(state, event.diff.releasedPersonId)}解开了绳索`;
    const outputs = materialAmounts(event.diff.outputs);
    const sourceMaterialId = Number(event.diff.sourceMaterialId);
    if (sourceMaterialId === Material.BerryBush) {
      return `${actor}采集了野果${outputs ? `，得到${outputs}` : ''}`;
    }
    if (sourceMaterialId === Material.CropMature) {
      return `${actor}收割了成熟作物${outputs ? `，得到${outputs}` : ''}`;
    }
    if (outputs) return `${actor}处理了${materialName(event.diff.sourceMaterialId)}，得到${outputs}`;
  }
  if (operation === 'dehydrate' && event.diff.entered === true) {
    const sleeperId = typeof event.diff.dehydratedPersonId === 'string' ? event.diff.dehydratedPersonId : event.who;
    return sleeperId === event.who
      ? `${actor}进入脱水休眠，尽量熬过乱纪元`
      : `${actor}帮助${personName(state, sleeperId)}进入脱水休眠，尽量熬过乱纪元`;
  }
  if (operation === 'rehydrate' && typeof event.diff.rehydratedPersonId === 'string') {
    return `${actor}用附近的水唤醒了${personName(state, event.diff.rehydratedPersonId)}`;
  }
  if (operation === 'hunt') {
    const animal = event.result.match(/(?:捕获了|捕到|捕猎)([^，。]+?)(?:失败|，|。|$)/u)?.[1] ?? '猎物';
    const products = materialAmounts(event.diff.products);
    if (event.diff.killed === true) return `${actor}捕到了${animal}${products ? `，得到${products}` : ''}`;
  }
  return event.result.startsWith(actor)
    ? event.result.replaceAll('施力', '动手')
    : `${actor}${event.result.replaceAll('物质', '材料').replaceAll('施力', '加工')}`;
}

function intentSummary(state: SimulationState, event: ActionEvent | DecisionEvent): string | null {
  if (!event.intentId) return null;
  return state.intents.find((intent) => intent.id === event.intentId)?.summary ?? null;
}

function actionText(state: SimulationState, event: ActionEvent): string {
  const actor = personName(state, event.who);
  if (event.status === 'blocked' || event.status === 'failed') {
    const goal = intentSummary(state, event);
    const attempted = goal ? naturalIntent(goal).replace(/^尝试/u, '') : event.action.kind === 'move' ? '抵达目的地' : '完成眼前的行动';
    return `${actor}没能${attempted}：${humanizeFailure(event.result)}`;
  }
  if (event.action.kind === 'move') return event.status === 'completed' ? `${actor}抵达了目的地` : `${actor}正在赶往目的地`;
  if (event.action.kind === 'transfer') return transferText(state, event, actor);
  if (event.action.kind === 'attend') return attendText(state, event, actor);
  if (event.action.kind === 'communicate') return dialogueText(state, event, actor);
  return actText(state, event, actor);
}

function decisionText(state: SimulationState, event: DecisionEvent): string {
  const actor = personName(state, event.who);
  const summary = intentSummary(state, event)
    ?? event.result.split(/[：:]/u).slice(1).join('：')
    ?? '安排下一步';
  const goal = naturalIntent(summary || '安排下一步');
  const reason = naturalReason(actor, event.decision.reason);
  if (event.decision.kind === 'resume') return `${actor}重新开始${goal}`;
  if (event.decision.kind === 'suspend') return `${actor}暂时停下${goal}`;
  if (event.decision.kind === 'abandon') return `${actor}放弃了${goal}`;
  if (event.decision.kind === 'idle') return `${actor}继续原来的安排`;
  const verb = event.decision.kind === 'revise'
    ? event.decision.mode === 'interrupt' ? '先去' : '改为'
    : '决定';
  return reason ? `${reason}，${verb}${goal}` : `${actor}${verb}${goal}`;
}

function actionImportance(event: ActionEvent): number {
  if (event.status === 'blocked' || event.status === 'failed') return 104;
  if (event.diff.victimId || event.diff.restrainedPersonId) return 102;
  if (event.action.kind === 'communicate') return 88;
  if (event.action.kind === 'act') {
    if (event.action.operation === 'ingest' || event.action.operation === 'rehydrate') return 86;
    if (event.action.operation === 'hunt') return 84;
    return 80;
  }
  if (event.action.kind === 'attend') return 74;
  if (event.action.kind === 'transfer') return 70;
  return event.status === 'completed' ? 46 : 24;
}

function actionTone(event: ActionEvent): NarrativeEntryView['tone'] {
  if (event.status === 'blocked' || event.status === 'failed') return 'bad';
  if (event.diff.authorized === false || event.diff.victimId || event.diff.restrainedPersonId) return 'bad';
  if (event.action.kind === 'move') return 'plain';
  if (event.action.kind === 'act' && (event.action.operation === 'hunt' || event.action.operation === 'reproduce' || event.action.operation === 'dehydrate')) return 'plain';
  return event.status === 'completed' ? 'good' : 'plain';
}

function eventPrecedes(first: WorldEvent, second: WorldEvent): boolean {
  return first.atMonth < second.atMonth
    || (first.atMonth === second.atMonth && first.orderInMonth < second.orderInMonth);
}

function repeatsConditionStage(state: SimulationState, event: EnvironmentEvent): boolean {
  if (event.change !== 'condition') return false;
  const condition = event.diff.condition;
  const stage = Number(event.diff.stage);
  if ((condition !== 'cold' && condition !== 'heat' && condition !== 'illness') || !Number.isInteger(stage)) return false;
  const fromStage = Number(event.diff.fromStage);
  if (Number.isInteger(fromStage)) return fromStage === stage;
  // 旧疾病事件没有 fromStage，且中间可能经由治疗动作恢复或清除；
  // 只看环境事件会把真实复发误当成重复。
  if (condition === 'illness') return false;
  if (!/加重|恶化|持续/u.test(event.result)) return false;
  const previous = [...state.world.past].reverse().find((candidate): candidate is EnvironmentEvent => (
    candidate.kind === 'environment'
      && candidate.change === 'condition'
      && candidate.id !== event.id
      && candidate.who === event.who
      && candidate.diff.condition === condition
      && eventPrecedes(candidate, event)
  ));
  if (!previous || previous.diff.exited === true) return false;
  return Number(previous.diff.stage) === stage;
}

function animalAttackCandidate(state: SimulationState, event: EnvironmentEvent): NarrativeCandidate {
  const victimId = typeof event.diff.victimId === 'string' ? event.diff.victimId : event.who;
  const animalName = animalNameForAttack(state, event);
  const victimName = personName(state, victimId);
  const woundStageAfter = finiteNumber(event.diff.woundStageAfter);
  const healthAfter = finiteNumber(event.diff.healthAfter);
  const verb = event.diff.behavior === 'defensive-charge' ? '冲撞了' : '袭击了';
  const consequence = healthAfter !== null && healthAfter <= 0
    ? '，造成致命伤害'
    : woundStageAfter !== null && woundStageAfter >= 3
      ? '，使其身受重伤'
      : '，使其受伤';
  return {
    id: `narrative:${event.id}`,
    month: event.atMonth,
    text: finishSentence(`${animalName}${verb}${victimName}${consequence}`),
    detail: animalAttackDetail(event),
    tone: 'bad',
    kind: 'epoch',
    importance: 110,
    sourceEventIds: [event.id],
    actorIds: victimId ? [victimId] : [],
    orderInMonth: event.orderInMonth,
  };
}

function environmentCandidate(
  state: SimulationState,
  event: EnvironmentEvent,
  eventsById: Map<string, WorldEvent>,
): NarrativeCandidate | null {
  if (isAnimalAttackEvent(event)) return animalAttackCandidate(state, event);
  if (event.change === 'weather') return weatherHistoryCandidate(event);
  if (event.change === 'climate') {
    const climate = climateHistoryCandidate(event);
    if (climate) return climate;
  }
  const founding = event.change === 'founding';
  const born = typeof event.diff.bornPersonId === 'string';
  const era = event.diff.eraTransition === true;
  const severeCondition = event.change === 'condition' && /加重|中止|受伤|患病/u.test(event.result);
  if (event.change !== 'death' && !founding && !born && !era && !severeCondition) return null;
  if (severeCondition && repeatsConditionStage(state, event)) return null;
  const foundingParticipantIds = Array.isArray(event.diff.participantIds)
    ? event.diff.participantIds.filter((id): id is string => typeof id === 'string')
    : [];
  const actorIds = founding
    ? foundingParticipantIds
    : event.who ? [event.who] : typeof event.diff.bornPersonId === 'string' ? [event.diff.bornPersonId] : [];
  const deathEvidence = event.change === 'death' ? deathAttackEvidence(event, eventsById) : null;
  const directAnimalNames = deathEvidence
    ? unique(deathEvidence.directAttacks.map((attack) => animalNameForAttack(state, attack)))
    : [];
  const relatedAnimalNames = deathEvidence
    ? unique(deathEvidence.attacks.map((attack) => animalNameForAttack(state, attack)))
    : [];
  const text = founding
    ? `第 ${state.civilization.number} 号文明在自然地表上开始，${foundingParticipantIds.length} 位先民共同抵达`
    : event.change === 'death'
      ? event.diff.cause === 'triple-sun-vaporization'
        ? `${personName(state, event.who)}在三日凌空中瞬间汽化`
        : directAnimalNames.length
        ? `${personName(state, event.who)}被${briefNameList(directAnimalNames)}袭击致死，随身物品留在原地`
        : relatedAnimalNames.length
          ? `${personName(state, event.who)}去世了；生前曾遭${briefNameList(relatedAnimalNames)}袭击，随身物品留在原地`
          : `${personName(state, event.who)}去世了，随身物品留在原地`
    : era
      ? event.diff.epoch === 'chaotic'
        ? `恒纪元结束，乱纪元开始，地表转为${event.diff.kind === 'cold' ? '寒冷' : event.diff.kind === 'heat' ? '炎热' : '灼热'}`
        : '乱纪元结束，恒纪元开始，地表恢复温和'
      : event.result.replaceAll('的身体储备发生显著变化', '的身体状况明显变化');
  const prioritizedDeathAttacks = deathEvidence
    ? unique([
      ...deathEvidence.directAttacks,
      ...[...deathEvidence.attacks].reverse(),
    ]).slice(0, 2)
    : [];
  const recentOtherDeathSources = deathEvidence
    ? deathEvidence.sourceEvents
      .filter((source) => !isAnimalAttackEvent(source))
      .slice(-2)
    : [];
  const detail = deathEvidence
    ? unique([
      event.result,
      ...prioritizedDeathAttacks.map(animalAttackDetail),
      ...recentOtherDeathSources.map((source) => source.result),
    ].filter(Boolean)).map((part) => concisePlayerText(part, 120)).join('；')
    : event.result;
  return {
    id: `narrative:${event.id}`,
    month: event.atMonth,
    text: finishSentence(text),
    detail,
    tone: event.change === 'death' || severeCondition || event.diff.correct === false ? 'bad' : founding || era ? 'era' : 'good',
    kind: 'epoch',
    importance: founding ? 140 : era ? 132 : event.change === 'death' ? 124 : born ? 116 : severeCondition ? 96 : 90,
    sourceEventIds: deathEvidence
      ? unique([...deathEvidence.sourceEventIds, event.id])
      : [event.id],
    actorIds,
    orderInMonth: event.orderInMonth,
  };
}

function agreementLabel(state: SimulationState, event: AgreementEvent): string {
  const agreement = state.agreements.find((candidate) => candidate.id === event.agreementId);
  const proposal = agreement?.proposal;
  if (!proposal) return '约定';
  if (proposal.kind === 'reproduce') return '共同生育的约定';
  if (proposal.kind === 'companion') return '结伴生活的约定';
  if (proposal.kind === 'collective') return '组建共同体的约定';
  if (proposal.kind === 'membership') return '加入共同体的约定';
  if (proposal.kind === 'decision-rule') return '共同决策的约定';
  if (proposal.kind === 'mandate') return '物资协调的委托';
  if (proposal.kind === 'permission') return `取用${materialName(proposal.materialId)}的许可`;
  if (proposal.kind === 'assist') {
    const need = proposal.need === 'water' ? '饮水' : proposal.need === 'food' ? '食物' : proposal.need === 'shelter' ? '庇护' : '陪伴';
    return `${need}互助的约定`;
  }
  return `${proposal.offererQuantity}份${materialName(proposal.offererMaterialId)}换${proposal.partnerQuantity}份${materialName(proposal.partnerMaterialId)}的约定`;
}

function agreementSemanticKey(state: SimulationState, event: AgreementEvent): string {
  const agreement = state.agreements.find((candidate) => candidate.id === event.agreementId);
  if (!agreement) return `agreement:${event.agreementId}`;
  const proposal = agreement.proposal;
  const parties = unique(event.partyIds).sort().join(',');
  const agreementWindow = `${agreement.proposedAtMonth}:${agreement.acceptedAtMonth ?? ''}:${agreement.dueAtMonth ?? ''}`;
  if (proposal.kind === 'reproduce') return `${proposal.kind}:${parties}:${agreementWindow}`;
  if (proposal.kind === 'companion') return `${proposal.kind}:${parties}:${agreementWindow}:${agreement.coLocatedMonths}`;
  // 只有共同生育和结伴是真正对称的关系事实。交换、援助、入会、
  // 委托与许可即使条款相似，也可能是同月各自履行的不同协议。
  return `${proposal.kind}:${event.agreementId}`;
}

function agreementCandidate(state: SimulationState, event: AgreementEvent): NarrativeCandidate | null {
  if (event.change !== 'fulfilled' && event.change !== 'breached') return null;
  const agreement = state.agreements.find((candidate) => candidate.id === event.agreementId);
  const symmetric = agreement?.proposal.kind === 'companion' || agreement?.proposal.kind === 'reproduce';
  const personOrder = new Map(state.people.map((person, index) => [person.id, index]));
  const partyIds = unique(event.partyIds).sort((first, second) => (
    symmetric ? (personOrder.get(first) ?? Number.MAX_SAFE_INTEGER) - (personOrder.get(second) ?? Number.MAX_SAFE_INTEGER) : 0
  ));
  const names = briefNameList(partyIds.map((id) => personName(state, id)));
  return {
    id: `narrative:${event.id}`,
    month: event.atMonth,
    text: finishSentence(`${names}${event.change === 'fulfilled' ? '履行了' : '未能履行'}${agreementLabel(state, event)}`),
    detail: event.result,
    tone: event.change === 'fulfilled' ? 'good' : 'bad',
    kind: 'epoch',
    importance: event.change === 'fulfilled' ? 94 : 106,
    sourceEventIds: [event.id],
    actorIds: partyIds,
    orderInMonth: event.orderInMonth,
    dedupeKey: `agreement:${event.atMonth}:${event.change}:${agreementSemanticKey(state, event)}`,
  };
}

function standaloneCandidate(state: SimulationState, event: ActionEvent | DecisionEvent): NarrativeCandidate {
  const actorId = event.who;
  return {
    id: `narrative:${event.id}`,
    month: event.atMonth,
    text: finishSentence(event.kind === 'action' ? actionText(state, event) : decisionText(state, event)),
    detail: event.result,
    tone: event.kind === 'action' ? actionTone(event) : 'plain',
    kind: event.kind,
    importance: event.kind === 'action' ? actionImportance(event) : 60,
    sourceEventIds: [event.id],
    actorIds: [actorId],
    ...(event.intentId ? { intentId: event.intentId } : {}),
    orderInMonth: event.orderInMonth,
  };
}

function isMajorHistoricalAction(state: SimulationState, event: ActionEvent): boolean {
  if (event.status !== 'completed') return false;
  if (typeof event.diff.victimId === 'string'
    || typeof event.diff.restrainedPersonId === 'string'
    || typeof event.diff.releasedPersonId === 'string') return true;
  if (event.diff.verifiedTechnique === true) return true;
  if (event.action.kind !== 'act') return false;
  if (event.action.operation === 'reproduce') return event.diff.conceived === true;
  if (event.action.operation === 'dehydrate') return event.diff.entered === true;
  if (event.action.operation === 'rehydrate') return typeof event.diff.rehydratedPersonId === 'string';
  const person = state.people.find((candidate) => candidate.id === event.who);
  return Boolean(person?.knowledge.some((knowledge) => (
    knowledge.kind === 'technique'
      && knowledge.learnedAtMonth === event.atMonth
      && knowledge.sourceEventIds.includes(event.id)
  )));
}

function completedProjectCandidates(state: SimulationState, events: WorldEvent[]): NarrativeCandidate[] {
  const eventMap = new Map(events.map((event) => [event.id, event]));
  return state.projects.flatMap((project): NarrativeCandidate[] => {
    if (project.status !== 'completed' || project.completedAtMonth !== state.clock.elapsedMonths) return [];
    const sourceEventIds = project.completionEventIds.filter((eventId) => eventMap.has(eventId));
    if (!sourceEventIds.length) return [];
    const sourceEvents = sourceEventIds.map((eventId) => eventMap.get(eventId)!);
    const participantIds = [...new Set([project.ownerId, ...project.contributorIds])];
    const names = participantIds.map((personId) => personName(state, personId)).join('、');
    return [{
      id: `narrative:project:${project.id}:${project.completedAtMonth}`,
      month: project.completedAtMonth,
      text: finishSentence(`${names || personName(state, project.ownerId)}完成了“${naturalIntent(project.summary)}”`),
      detail: sourceEvents.map((event) => event.result).join('；'),
      tone: 'good',
      kind: 'action',
      importance: 112,
      sourceEventIds,
      actorIds: participantIds,
      orderInMonth: Math.min(...sourceEvents.map((event) => event.orderInMonth)),
    }];
  });
}

function mergeCandidate(primary: NarrativeCandidate, duplicate: NarrativeCandidate): NarrativeCandidate {
  const preferred = duplicate.importance > primary.importance
    || (duplicate.importance === primary.importance && duplicate.orderInMonth < primary.orderInMonth)
    ? duplicate
    : primary;
  return {
    ...preferred,
    detail: unique([primary.detail, duplicate.detail].filter(Boolean)).join('；'),
    importance: Math.max(primary.importance, duplicate.importance),
    sourceEventIds: unique([...primary.sourceEventIds, ...duplicate.sourceEventIds]),
    actorIds: unique([...primary.actorIds, ...duplicate.actorIds]),
    orderInMonth: Math.min(primary.orderInMonth, duplicate.orderInMonth),
  };
}

function mergeCandidatesBy(candidates: NarrativeCandidate[], keyFor: (candidate: NarrativeCandidate) => string): NarrativeCandidate[] {
  const merged = new Map<string, NarrativeCandidate>();
  for (const candidate of candidates) {
    const key = keyFor(candidate);
    const existing = merged.get(key);
    merged.set(key, existing ? mergeCandidate(existing, candidate) : candidate);
  }
  return [...merged.values()];
}

export function playerTextForEvent(state: SimulationState, event: WorldEvent): string {
  if (event.kind === 'action' || event.kind === 'decision') return standaloneCandidate(state, event).text;
  if (event.kind === 'environment') {
    if (event.change === 'body') return bodyEventPlayerText(state, event);
    return environmentCandidate(state, event, eventLookup(state, [event]))?.text ?? finishSentence(event.result);
  }
  if (event.kind === 'agreement') return agreementCandidate(state, event)?.text ?? finishSentence(event.result);
  return finishSentence(event.result);
}

export function projectPlayerNarrative(state: SimulationState, events: WorldEvent[], limit = 4): NarrativeEntryView[] {
  const eventsById = eventLookup(state, events);
  const attacksAbsorbedByDeath = new Set(events.flatMap((event) => (
    event.kind === 'environment' && event.change === 'death'
      ? deathAttackEvidence(event, eventsById).attacks
        .filter((attack) => attack.atMonth === event.atMonth)
        .map((attack) => attack.id)
      : []
  )));
  const projectCandidates = completedProjectCandidates(state, events);
  const projectSourceEventIds = new Set(projectCandidates.flatMap((candidate) => candidate.sourceEventIds));
  const candidates: NarrativeCandidate[] = [];
  for (const event of events) {
    if (event.kind === 'action') {
      if (!projectSourceEventIds.has(event.id) && isMajorHistoricalAction(state, event)) candidates.push(standaloneCandidate(state, event));
    } else if (event.kind === 'environment') {
      if (isAnimalAttackEvent(event) && attacksAbsorbedByDeath.has(event.id)) continue;
      const candidate = environmentCandidate(state, event, eventsById);
      if (candidate) candidates.push(candidate);
    } else if (event.kind === 'agreement') {
      const candidate = agreementCandidate(state, event);
      if (candidate) candidates.push(candidate);
    }
  }
  candidates.push(...projectCandidates);
  if (!candidates.length) return [];
  const semanticCandidates = mergeCandidatesBy(candidates, (candidate) => candidate.dedupeKey ?? candidate.id);
  const distinctCandidates = mergeCandidatesBy(semanticCandidates, (candidate) => candidate.dedupeKey ?? `${candidate.month}:${candidate.text}`);
  return distinctCandidates
    .sort((first, second) => second.importance - first.importance || first.orderInMonth - second.orderInMonth)
    .slice(0, Math.max(1, limit))
    .sort((first, second) => first.orderInMonth - second.orderInMonth)
    .map(({ orderInMonth: _orderInMonth, dedupeKey: _dedupeKey, ...entry }) => entry);
}
