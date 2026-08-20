import { animalSpecies } from '../../domain/animal';
import { cognitionStateOf, outcomeBeliefSuccess, outcomeBeliefUncertainty } from '../../domain/cognition';
import { materialHas } from '../../domain/material';
import type { DecisionContext } from '../../domain/model';
import { bereavementUrgency } from '../../domain/mortuary';
import { personalityScore } from '../../domain/personality';

export type NeedKind =
  | 'homeostasis'
  | 'safety'
  | 'care'
  | 'bereavement'
  | 'reserve'
  | 'capability'
  | 'commitment'
  | 'belonging'
  | 'autonomy'
  | 'inquiry';

export interface NeedSignal {
  key: string;
  kind: NeedKind;
  urgency: number;
  reasons: string[];
  sourceFactIds: string[];
}

/** Central policy scales have physical/cognitive meanings; they are not option scores. */
export const COGNITIVE_POLICY = {
  bodyComfort: 72,
  bodyDeficitScale: 24,
  personalReserveUnits: 4,
  failureExperienceScale: 4,
  staleCommitmentMonths: 4,
  minimumNeed: 0.035,
} as const;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function saturating(value: number, scale: number): number {
  const positive = Math.max(0, value);
  return positive / Math.max(0.0001, positive + scale);
}

function trait(person: DecisionContext['person'], key: Parameters<typeof personalityScore>[1]): number {
  return personalityScore(person, key) / 100;
}

function signal(
  kind: NeedKind,
  urgency: number,
  reasons: string[],
  sourceFactIds: string[] = [],
): NeedSignal {
  return {
    key: `need:${kind}`,
    kind,
    urgency: clamp(urgency),
    reasons: [...new Set(reasons)],
    sourceFactIds: [...new Set(sourceFactIds)].slice(-24),
  };
}

function isResponseOption(context: DecisionContext): boolean {
  return context.options.some((option) => {
    const action = option.nextAction.kind === 'communicate'
      ? option.nextAction
      : option.completionAction?.kind === 'communicate'
        ? option.completionAction
        : undefined;
    return action?.content.kind === 'accept'
      || action?.content.kind === 'reject'
      || action?.content.kind === 'revoke-agreement'
      || action?.content.kind === 'revoke'
      || action?.content.kind === 'withdraw';
  });
}

export function deriveNeedAgenda(context: DecisionContext, atMonth: number): NeedSignal[] {
  const person = context.person;
  const needs: NeedSignal[] = [];
  const bodyDeficits = (['health', 'hydration', 'nutrition'] as const).map((field) => ({
    field,
    deficit: Math.max(0, COGNITIVE_POLICY.bodyComfort - person.body[field]),
  }));
  const bodyUrgency = Math.max(...bodyDeficits.map(({ deficit }) => saturating(deficit, COGNITIVE_POLICY.bodyDeficitScale)));
  if (bodyUrgency > 0) needs.push(signal(
    'homeostasis',
    bodyUrgency,
    bodyDeficits.filter(({ deficit }) => deficit > 0).map(({ field }) => `${field}低于本人舒适储备`),
    person.conditions.flatMap((condition) => condition.sourceEventIds),
  ));

  const hazardousConditions = person.conditions.filter((condition) => condition.kind === 'cold'
    || condition.kind === 'heat'
    || condition.kind === 'wound'
    || condition.kind === 'illness'
    || condition.kind === 'restrained');
  const conditionDanger = hazardousConditions.reduce((maximum, condition) => Math.max(maximum, condition.stage / 3), 0);
  const visibleThreat = context.visibleAnimals.reduce((maximum, animal) => Math.max(
    maximum,
    animalSpecies(animal.speciesId).aggression / 100,
  ), 0);
  const safetyUrgency = Math.max(conditionDanger, visibleThreat * (0.55 + trait(person, 'emotionality') * 0.35));
  if (safetyUrgency > 0) needs.push(signal(
    'safety',
    safetyUrgency,
    [
      ...(hazardousConditions.length ? ['本人正经历可感知的伤病、冷热或拘束'] : []),
      ...(visibleThreat > 0 ? ['局部感知中存在有攻击性的动物'] : []),
    ],
    hazardousConditions.flatMap((condition) => condition.sourceEventIds),
  ));

  const grief = (person.bereavements ?? []).map((bereavement) => ({
    bereavement,
    urgency: bereavementUrgency(context.state, bereavement, atMonth),
  })).sort((left, right) => right.urgency - left.urgency)[0];
  if (grief?.urgency > 0) {
    const deceased = context.state.people.find((candidate) => candidate.id === grief.bereavement.deceasedPersonId);
    needs.push(signal(
      'bereavement',
      grief.urgency,
      [`本人以可追溯来源知道${deceased?.name ?? '一位熟识的人'}已经死亡，仍有悼念、遗物或遗体照料没有完成`],
      grief.bereavement.sourceEventIds,
    ));
  }

  let edibleUnits = 0;
  let drinkableUnits = 0;
  for (const stack of person.inventory) {
    if (stack.quantity <= 0) continue;
    if (materialHas(stack.materialId, 'edible')) edibleUnits += stack.quantity;
    if (materialHas(stack.materialId, 'drinkable')) drinkableUnits += stack.quantity;
  }
  const reserveGap = Math.max(
    0,
    1 - Math.min(1, Math.min(edibleUnits, drinkableUnits) / COGNITIVE_POLICY.personalReserveUnits),
  );
  if (reserveGap > 0) needs.push(signal(
    'reserve',
    reserveGap * (0.45 + Math.max(bodyUrgency, conditionDanger) * 0.55),
    ['本人可携带的食水缓冲不足'],
    person.inventory.flatMap((stack) => stack.sourceEventIds),
  ));

  const strongestProjectOption = [...context.options]
    .filter((option) => option.projectId || option.projectProposal)
    .sort((left, right) => (right.projectPressure ?? right.projectProposal?.pressure ?? 0)
      - (left.projectPressure ?? left.projectProposal?.pressure ?? 0))[0];
  if (strongestProjectOption) {
    const project = strongestProjectOption.projectProposal
      ?? context.state.projects.find((candidate) => candidate.id === strongestProjectOption.projectId);
    const pressure = strongestProjectOption.projectPressure ?? project?.pressure ?? 0;
    const projectNeed = project?.need;
    const kind: NeedKind = projectNeed === 'thermal-safety'
      || projectNeed === 'hunting-safety'
      || projectNeed === 'shelter-capacity'
      ? 'safety'
      : projectNeed === 'care-capability'
        ? 'care'
        : projectNeed === 'reserve-security'
          || projectNeed === 'water-security'
          || projectNeed === 'food-preparation'
          ? 'reserve'
          : projectNeed === 'coordination-capacity'
            ? 'belonging'
            : 'capability';
    needs.push(signal(
      kind,
      pressure / (pressure + 45),
      [`一个由局部事实触发的${projectNeed ?? '持续项目'}正在等待投入`],
      strongestProjectOption.sourceFactIds,
    ));
  }

  let strongestCare = 0;
  const careSources: string[] = [];
  const careReasons: string[] = [];
  for (const other of context.visiblePeople) {
    if (other.id === person.id) continue;
    const relation = person.relations.find((candidate) => candidate.personId === other.id);
    const danger = Math.max(
      saturating(COGNITIVE_POLICY.bodyComfort - other.body.health, COGNITIVE_POLICY.bodyDeficitScale),
      saturating(COGNITIVE_POLICY.bodyComfort - other.body.hydration, COGNITIVE_POLICY.bodyDeficitScale),
      saturating(COGNITIVE_POLICY.bodyComfort - other.body.nutrition, COGNITIVE_POLICY.bodyDeficitScale),
      other.conditions.reduce((maximum, condition) => Math.max(maximum, condition.stage / 3), 0),
    );
    if (danger <= 0) continue;
    const kin = other.geneticParents.includes(person.id) || person.geneticParents.includes(other.id);
    const relationship = clamp(((relation?.bond ?? 0) + (relation?.trust ?? 0) - Math.max(0, relation?.fear ?? 0)) / 100, -0.35, 0.65);
    const personalityGate = 0.55 + (trait(person, 'agreeableness') + trait(person, 'emotionality')) * 0.45;
    const urgency = clamp(danger * personalityGate * (kin ? 1.2 : 0.75 + relationship));
    if (urgency > strongestCare) {
      strongestCare = urgency;
      careReasons.splice(0, careReasons.length, `${other.name}在本人眼前存在身体风险`);
      careSources.splice(0, careSources.length, ...(relation?.sourceEventIds ?? []), ...other.conditions.flatMap((condition) => condition.sourceEventIds));
    }
  }
  if (strongestCare > 0) needs.push(signal('care', strongestCare, careReasons, careSources));

  const active = context.activeIntent;
  if (active) {
    const project = active.projectId
      ? context.state.projects.find((candidate) => candidate.id === active.projectId)
      : undefined;
    const staleMonths = Math.max(0, atMonth - Math.max(active.lastProgressAtMonth, active.lastResumedAtMonth ?? active.lastProgressAtMonth));
    const continuity = clamp(0.28
      + active.progress * 0.35
      + (project?.pressure ?? 0) / 250
      + trait(person, 'conscientiousness') * 0.22
      - saturating(staleMonths, COGNITIVE_POLICY.staleCommitmentMonths) * 0.3);
    needs.push(signal(
      'commitment',
      continuity,
      [project ? '本人已经承担一个有真实进度的项目' : '本人已有尚未完成的长期意图'],
      [...(active.sourceFactIds ?? []), ...(project?.triggerFactIds ?? [])],
    ));
  }

  const beliefs = cognitionStateOf(person).outcomeBeliefs;
  const difficult = beliefs.filter((belief) => belief.attempts > 0 && outcomeBeliefSuccess(belief) < 0.5);
  const capabilityUrgency = difficult.reduce((maximum, belief) => Math.max(
    maximum,
    (1 - outcomeBeliefSuccess(belief)) * saturating(belief.attempts, COGNITIVE_POLICY.failureExperienceScale),
  ), 0);
  if (capabilityUrgency > 0) needs.push(signal(
    'capability',
    capabilityUrgency * (0.65 + trait(person, 'conscientiousness') * 0.35),
    ['本人近期的行动结果显示现有方法不够可靠'],
    difficult.flatMap((belief) => belief.sourceEventIds),
  ));

  const socialOptions = context.options.filter((option) => option.domain === 'social');
  const sourcedRelations = person.relations.filter((relation) => relation.sourceEventIds.length > 0
    && context.visiblePeople.some((other) => other.id === relation.personId));
  if (socialOptions.length && sourcedRelations.length) {
    const strongestRelation = sourcedRelations.reduce((maximum, relation) => Math.max(
      maximum,
      clamp((Math.max(0, relation.bond) + Math.max(0, relation.trust) - Math.max(0, relation.fear)) / 100),
    ), 0);
    needs.push(signal(
      'belonging',
      strongestRelation * (0.35 + trait(person, 'extraversion') * 0.4 + trait(person, 'agreeableness') * 0.25),
      ['当前可见关系与本人社会接近倾向形成了真实互动机会'],
      sourcedRelations.flatMap((relation) => relation.sourceEventIds),
    ));
  }

  if (isResponseOption(context)) needs.push(signal(
    'autonomy',
    0.45 + person.motiveSensitivity.control / 200,
    ['一项具体提议、权限或共同体关系正在等待本人表态'],
    context.options.flatMap((option) => option.sourceFactIds),
  ));

  const inquiryOptions = context.options.filter((option) => option.goal.kind === 'knowledge'
    || option.nextAction.kind === 'attend'
    || Boolean(option.recordUseBasis));
  if (inquiryOptions.length) {
    const uncertainty = beliefs.length
      ? Math.max(...beliefs.map((belief) => outcomeBeliefUncertainty(belief)))
      : 1;
    const grounded = inquiryOptions.some((option) => option.sourceFactIds.length > 0 || option.projectId || option.recordUseBasis);
    needs.push(signal(
      'inquiry',
      (grounded ? 0.3 : 0.12) * (0.45 + trait(person, 'openness') * 0.55) * (0.7 + uncertainty * 0.3),
      [grounded ? '当前项目或观察留下了具体未知点' : '眼前存在可逆的观察机会'],
      inquiryOptions.flatMap((option) => option.sourceFactIds),
    ));
  }

  return needs
    .filter((need) => need.urgency >= COGNITIVE_POLICY.minimumNeed)
    .sort((left, right) => right.urgency - left.urgency || left.kind.localeCompare(right.kind));
}
