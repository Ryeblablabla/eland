import { animalSpecies } from '../../domain/animal';
import { cognitionStateOf, outcomeBeliefSuccess, outcomeBeliefUncertainty } from '../../domain/cognition';
import { materialHas } from '../../domain/material';
import type { DecisionContext } from '../../domain/model';
import { personalityScore } from '../../domain/personality';
import { strongestBereavement } from '../../domain/mortuary';
import { worldEventById } from '../../domain/event-index';
import { agreementsForPerson } from '../../domain/agreement';
import { personById, projectById } from '../../domain/state-index';
import { ageMonths } from '../../domain/person';
import {
  companionLivingAnchor,
  companionReturnRequired,
  personWithinLivingArea,
} from '../../domain/shared-living';
import { assessFamilyReadiness } from './family-readiness';
import { crowdingUrgency } from '../../domain/social-space';
import { relationTo } from '../../domain/relation';

export type NeedKind =
  | 'homeostasis'
  | 'safety'
  | 'spatial-comfort'
  | 'care'
  | 'bereavement'
  | 'reserve'
  | 'capability'
  | 'commitment'
  | 'belonging'
  | 'generativity'
  | 'autonomy'
  | 'inquiry';

export type ReserveResource = 'food' | 'water';
export type HomeostasisField = 'health' | 'hydration' | 'nutrition';

export interface NeedSignal {
  key: string;
  kind: NeedKind;
  /** Keep food and water deficits distinct so one resource cannot satisfy the other. */
  resource?: ReserveResource;
  /** Body deficits remain distinct so hydration cannot motivate food, or vice versa. */
  bodyField?: HomeostasisField;
  /** Project pressure is scoped so unrelated ordinary actions cannot claim it. */
  projectId?: string;
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

function combinedSatisfaction(values: number[]): number {
  return clamp(1 - values.reduce(
    (remaining, value) => remaining * (1 - clamp(value)),
    1,
  ));
}

function trait(person: DecisionContext['person'], key: Parameters<typeof personalityScore>[1]): number {
  return personalityScore(person, key) / 100;
}

function signal(
  kind: NeedKind,
  urgency: number,
  reasons: string[],
  sourceFactIds: string[] = [],
  resource?: ReserveResource,
  projectId?: string,
  bodyField?: HomeostasisField,
): NeedSignal {
  return {
    key: `need:${kind}${resource ? `:${resource}` : ''}${bodyField ? `:${bodyField}` : ''}${projectId ? `:project:${projectId}` : ''}`,
    kind,
    ...(resource ? { resource } : {}),
    ...(bodyField ? { bodyField } : {}),
    ...(projectId ? { projectId } : {}),
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
      || action?.content.kind === 'reject';
  });
}

export function deriveNeedAgenda(context: DecisionContext, atMonth: number): NeedSignal[] {
  const person = context.person;
  const needs: NeedSignal[] = [];
  const positiveReproductionOptions = context.options.filter((option) => option.id.startsWith('offer-reproduce:')
    || option.id.startsWith('accept-reproduce:')
    || option.id.startsWith('reproduce:'));
  const succubusReproductionOptions = positiveReproductionOptions.filter((option) => option.id.startsWith('reproduce:succubus:'));
  const reproductiveWithdrawalOptions = context.options.filter((option) => option.id.startsWith('reject-reproduce:')
    || option.id.startsWith('withdraw-reproduce:'));
  const familyReadiness = positiveReproductionOptions.length || reproductiveWithdrawalOptions.length
    ? assessFamilyReadiness(context, atMonth)
    : undefined;
  const bodyDeficits = (['health', 'hydration', 'nutrition'] as const).map((field) => ({
    field,
    deficit: Math.max(0, COGNITIVE_POLICY.bodyComfort - person.body[field]),
  }));
  const bodyUrgency = Math.max(...bodyDeficits.map(({ deficit }) => saturating(deficit, COGNITIVE_POLICY.bodyDeficitScale)));
  for (const { field, deficit } of bodyDeficits) {
    const urgency = saturating(deficit, COGNITIVE_POLICY.bodyDeficitScale);
    if (urgency <= 0) continue;
    needs.push(signal(
      'homeostasis',
      urgency,
      [`${field}低于本人舒适储备`],
      person.conditions.flatMap((condition) => condition.sourceEventIds),
      undefined,
      undefined,
      field,
    ));
  }

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

  const spatialPressure = crowdingUrgency(context.state, person);
  if (spatialPressure > 0) needs.push(signal(
    'spatial-comfort',
    spatialPressure,
    ['本人能够直接感到同一站立位置过于拥挤，附近较空位置会更舒适'],
  ));

  const grief = strongestBereavement(context.state, person, atMonth);
  if (grief && grief.urgency > 0) {
    const deceased = personById(context.state, grief.bereavement.deceasedPersonId);
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
  const reserveUrgency = (units: number) => Math.max(
    0,
    1 - Math.min(1, units / COGNITIVE_POLICY.personalReserveUnits),
  ) * (0.45 + Math.max(bodyUrgency, conditionDanger) * 0.55);
  const foodReserveGap = reserveUrgency(edibleUnits);
  if (foodReserveGap > 0) needs.push(signal(
    'reserve',
    foodReserveGap,
    ['本人可携带的食物缓冲不足'],
    person.inventory.filter((stack) => materialHas(stack.materialId, 'edible'))
      .flatMap((stack) => stack.sourceEventIds),
    'food',
  ));
  const waterReserveGap = reserveUrgency(drinkableUnits);
  if (waterReserveGap > 0) needs.push(signal(
    'reserve',
    waterReserveGap,
    ['本人可携带的饮水缓冲不足'],
    person.inventory.filter((stack) => materialHas(stack.materialId, 'drinkable'))
      .flatMap((stack) => stack.sourceEventIds),
    'water',
  ));

  const recentNeedResolutions = cognitionStateOf(person).needResolutionEpisodes ?? [];
  const projectCandidates = context.options
    .filter((option) => option.projectId || option.projectProposal)
    .map((option) => {
      const project = option.projectProposal
        ?? (option.projectId ? projectById(context.state, option.projectId) : undefined);
      const rawPressure = option.projectPressure ?? project?.pressure ?? 0;
      const matchingResolution = !option.projectId && project
        ? recentNeedResolutions
          .filter((episode) => episode.projectNeed === project.need
            && episode.desiredFunction === project.desiredFunction
            && episode.observedAtMonth <= atMonth
            && atMonth - episode.observedAtMonth < 12)
          .sort((left, right) => right.observedAtMonth - left.observedAtMonth || left.id.localeCompare(right.id))[0]
        : undefined;
      const resolutionAge = matchingResolution ? atMonth - matchingResolution.observedAtMonth : 12;
      const relief = matchingResolution ? 0.45 * (1 - resolutionAge / 12) : 0;
      return { option, project, matchingResolution, pressure: rawPressure * (1 - relief) };
    })
    .sort((left, right) => right.pressure - left.pressure || left.option.id.localeCompare(right.option.id));
  const strongestProjectCandidate = projectCandidates[0];
  if (strongestProjectCandidate) {
    const { option: strongestProjectOption, project, matchingResolution, pressure } = strongestProjectCandidate;
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
    const resource: ReserveResource | undefined = projectNeed === 'water-security'
      ? 'water'
      : projectNeed === 'reserve-security' || projectNeed === 'food-preparation'
        ? 'food'
        : undefined;
    needs.push(signal(
      kind,
      pressure / (pressure + 45),
      [matchingResolution
        ? `本人近期亲手完成过同类${projectNeed ?? '持续项目'}，新建压力暂时缓解但仍可重新出现`
        : `一个由局部事实触发的${projectNeed ?? '持续项目'}正在等待投入`],
      [...strongestProjectOption.sourceFactIds, ...(matchingResolution?.sourceFactIds ?? [])],
      resource,
      project?.id,
    ));
  }

  let strongestCare = 0;
  const careSources: string[] = [];
  const careReasons: string[] = [];
  for (const other of context.visiblePeople) {
    if (other.id === person.id) continue;
    const relation = relationTo(person, other.id);
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

  if (familyReadiness && positiveReproductionOptions.length) {
    const possibleFemaleAges = positiveReproductionOptions.flatMap((option) => {
      const target = option.target?.kind === 'person' ? personById(context.state, option.target.personId) : undefined;
      const female = person.sex === 'female' ? person : target?.sex === 'female' ? target : undefined;
      return female ? [ageMonths(female, atMonth) / 12] : [];
    });
    const oldestFemaleAge = possibleFemaleAges.length ? Math.max(...possibleFemaleAges) : 0;
    const ageWindow = oldestFemaleAge < 30
      ? 0
      : oldestFemaleAge < 35
        ? 0.1
        : oldestFemaleAge < 38
          ? 0.2
          : 0.3;
    // A real, sourced relationship and a finite reproductive window can make
    // somebody consider family formation before every material condition is
    // already solved. Readiness still changes the strength continuously, and
    // is appraised again as the practical gate on the concrete option, but it
    // must not erase the generativity need itself.
    const relationshipSources = positiveReproductionOptions.flatMap((option) => option.sourceFactIds);
    const generativityConsideration = 0.34 + ageWindow * 0.6;
    const readinessModulation = 0.78 + Math.sqrt(familyReadiness.readiness) * 0.22;
    const readinessUrgency = generativityConsideration * readinessModulation;
    const urgency = succubusReproductionOptions.length
      ? Math.max(0.48 + ageWindow * 0.2, readinessUrgency)
      : readinessUrgency;
    needs.push(signal(
      'generativity',
      urgency,
      succubusReproductionOptions.length
        ? ['魅魔特质产生了不依赖关系、双方协议或家庭准备度的单方生殖机会']
        : [
            '本人眼前存在一段可追溯关系，因而开始考虑是否共同形成下一代',
            `本人当前可感知的食物、水源、住所、照护余量与气候共同形成${Math.round(familyReadiness.readiness * 100)}%的家庭准备度`,
            ...familyReadiness.reasons,
          ],
      succubusReproductionOptions.length
        ? [...new Set(succubusReproductionOptions.flatMap((option) => option.sourceFactIds))]
        : [...new Set([...relationshipSources, ...familyReadiness.sourceFactIds])],
    ));
  }

  const active = context.activeIntent;
  let commitmentUrgency = 0;
  const commitmentReasons: string[] = [];
  const commitmentSources: string[] = [];
  if (active) {
    const project = active.projectId ? projectById(context.state, active.projectId) : undefined;
    const staleMonths = Math.max(0, atMonth - Math.max(active.lastProgressAtMonth, active.lastResumedAtMonth ?? active.lastProgressAtMonth));
    const continuity = clamp(0.28
      + active.progress * 0.35
      + (project?.pressure ?? 0) / 250
      + trait(person, 'conscientiousness') * 0.22
      - saturating(staleMonths, COGNITIVE_POLICY.staleCommitmentMonths) * 0.3);
    commitmentUrgency = Math.max(commitmentUrgency, continuity);
    commitmentReasons.push(project ? '本人已经承担一个有真实进度的项目' : '本人已有尚未完成的长期意图');
    commitmentSources.push(...(active.sourceFactIds ?? []), ...(project?.triggerFactIds ?? []));
  }

  const dueCompanionCommitments = agreementsForPerson(context.state, person.id).filter((agreement) => {
    if (agreement.status !== 'active'
      || agreement.proposal.kind !== 'companion'
      || !agreement.partyIds.includes(person.id)) return false;
    const anchor = companionLivingAnchor(context.state, agreement);
    if (!anchor) return false;
    return !personWithinLivingArea(person, anchor)
      && companionReturnRequired(agreement, atMonth);
  });
  if (dueCompanionCommitments.length) {
    // The domain owns the maintenance calendar. Once it says the established
    // commitment is due, the need is substantial without multiplying by
    // conscientiousness here; personality remains a choice gate in appraisal.
    commitmentUrgency = Math.max(commitmentUrgency, 0.62);
    commitmentReasons.push('本人已离开约定的共同生活地点，且有来源的长期共同生活承诺已到维护时点');
    commitmentSources.push(...dueCompanionCommitments.flatMap((agreement) => agreement.sourceEventIds));
  }
  if (commitmentUrgency > 0) needs.push(signal(
    'commitment',
    commitmentUrgency,
    commitmentReasons,
    commitmentSources,
  ));

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

  const visibleRelationshipOpportunities = context.visiblePeople.filter((other) => other.id !== person.id);
  const activeCompanions = agreementsForPerson(context.state, person.id).filter((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'companion'
    && agreement.partyIds.includes(person.id));
  const companionSatisfaction = combinedSatisfaction(activeCompanions.flatMap((agreement) => {
    const otherId = agreement.partyIds.find((candidate) => candidate !== person.id);
    const other = otherId ? personById(context.state, otherId) : undefined;
    const relation = otherId ? relationTo(person, otherId) : undefined;
    if (!other) return [];
    const relationalSecurity = clamp(
      (Math.max(0, relation?.trust ?? 0) + Math.max(0, relation?.bond ?? 0) - Math.max(0, relation?.fear ?? 0)) / 100,
    );
    const anchor = companionLivingAnchor(context.state, agreement);
    const currentlyShared = Boolean(anchor && personWithinLivingArea(person, anchor));
    return [clamp(
      (agreement.companionEstablishedAtMonth !== undefined ? 0.72 : 0.46)
      + relationalSecurity * 0.18
      + (currentlyShared ? 0.12 : 0),
      0,
      0.92,
    )];
  }));
  const availableRelationshipOpportunities = visibleRelationshipOpportunities.filter((other) => !activeCompanions
    .some((agreement) => agreement.partyIds.includes(other.id)));
  const visibleSourcedRelations = person.relations.flatMap((relation) => {
    if (!visibleRelationshipOpportunities.some((other) => other.id === relation.personId)) return [];
    const sourceFactIds = relation.sourceEventIds.filter((eventId) => worldEventById(context.state, eventId));
    return sourceFactIds.length ? [{ relation, sourceFactIds }] : [];
  });
  const affiliationRelations = visibleSourcedRelations.filter(({ relation }) => availableRelationshipOpportunities
    .some((other) => other.id === relation.personId));
  if (availableRelationshipOpportunities.length) {
    const strongestRelation = affiliationRelations.reduce((maximum, { relation }) => Math.max(
      maximum,
      clamp((Math.max(0, relation.bond) + Math.max(0, relation.trust) - Math.max(0, relation.fear)) / 100),
    ), 0);
    const opportunityUrgency = 0.42 + strongestRelation * 0.38;
    needs.push(signal(
      'belonging',
      opportunityUrgency * (1 - companionSatisfaction),
      [
        ...(activeCompanions.length
          ? [`本人已有${activeCompanions.length}项仍在生效的共同生活承诺；已接受或已建立的关系会连续缓解归属缺口，只有未满足部分推动新关系`]
          : []),
        affiliationRelations.length
          ? '本人眼前出现了曾与自己形成可追溯经历的人，可以主动延续这段关系'
          : '本人眼前有可以沟通的人，但尚未形成稳定陪伴关系；当前局部相遇本身构成一次低风险接近机会',
      ],
      [
        ...affiliationRelations.flatMap(({ sourceFactIds }) => sourceFactIds),
        ...activeCompanions.flatMap((agreement) => agreement.sourceEventIds),
      ],
    ));
  }

  const waitingForResponse = isResponseOption(context);
  const adverseRelations = visibleSourcedRelations.filter(({ relation }) => (
    relation.fear >= Math.max(relation.trust, relation.bond) + 10
  ));
  const adverseRelationshipUrgency = adverseRelations.reduce((maximum, { relation }) => Math.max(
    maximum,
    clamp(0.35 + (relation.fear - Math.max(relation.trust, relation.bond)) / 100),
  ), 0);
  const activeAgreements = agreementsForPerson(context.state, person.id).filter((agreement) => agreement.status === 'active'
    && agreement.partyIds.includes(person.id));
  const severeBodyUrgency = activeAgreements.length
    ? Math.max(
        saturating(35 - person.body.health, 18),
        saturating(35 - person.body.hydration, 18),
        saturating(35 - person.body.nutrition, 18),
        person.conditions.reduce((maximum, condition) => Math.max(maximum, condition.stage >= 3 ? 0.65 : 0), 0),
      )
    : 0;
  const responseUrgency = waitingForResponse ? 0.45 + person.motiveSensitivity.control / 200 : 0;
  const readinessWithdrawalUrgency = reproductiveWithdrawalOptions.length && familyReadiness
    ? 0.18 + (1 - familyReadiness.readiness) * 0.42
    : 0;
  const autonomyUrgency = Math.max(responseUrgency, adverseRelationshipUrgency, severeBodyUrgency, readinessWithdrawalUrgency);
  if (autonomyUrgency > 0) needs.push(signal(
    'autonomy',
    autonomyUrgency,
    [
      ...(waitingForResponse ? ['一项具体提议正在等待本人接受或拒绝'] : []),
      ...(adverseRelations.length ? ['本人眼前一段有来源的关系中，恐惧已经明显压过信任与羁绊'] : []),
      ...(severeBodyUrgency > 0 ? ['本人正处于严重身体状态，需要重新判断仍在生效的承诺'] : []),
      ...(readinessWithdrawalUrgency > 0 ? ['当前家庭准备度使本人有理由重新判断生殖提议或已给出的单次同意'] : []),
    ],
    [
      ...context.options.flatMap((option) => option.sourceFactIds),
      ...adverseRelations.flatMap(({ sourceFactIds }) => sourceFactIds),
      ...activeAgreements.flatMap((agreement) => agreement.sourceEventIds),
      ...(familyReadiness?.sourceFactIds ?? []),
      ...person.conditions.filter((condition) => condition.stage >= 3).flatMap((condition) => condition.sourceEventIds),
    ],
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
