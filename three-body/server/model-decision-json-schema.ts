import { SPEECH_PROPOSAL_KINDS, deriveWorldTargets, NATIVE_ACT_PARAMETER_SHAPES, scopedNativeMethods,
  type NativeActTargetRole, type WorldTargetDerivationContext } from '../src/game/eland/infrastructure-api';
import { MATERIAL_PALETTE } from '../src/game/eland/domain/material';
import { AGREEMENT_STATUSES } from '../src/game/eland/domain/agreement';
import type {
  DecisionProbeHandleMap,
  MentalActRequestContext,
} from '../src/game/eland/infrastructure-api';
import type { ModelJsonSchema } from './model-client';
import { NATIVE_ACT_WIRE_DEFINITIONS, hasDedicatedNativeActWire } from '../src/game/eland/application/model-decision/native-act-wire';

interface MentalActSchemaProtocol {
  requestContext: MentalActRequestContext;
  handles: DecisionProbeHandleMap;
  characterAgendaProposal: boolean;
  targetContext?: WorldTargetDerivationContext;
}

type JsonSchema = Record<string, unknown>;

export interface WorldPlanAttemptConstraint {
  mode: 'observe' | 'act' | 'wait';
  targetHandles: string[];
  hasExplicitFocus: boolean;
  unavailableTargetCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function describedRefs(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const ref = record(item).ref;
    return typeof ref === 'string' && ref ? [ref] : [];
  }) : [];
}

function stringSchema(maxLength: number, description?: string): JsonSchema {
  return {
    type: 'string',
    minLength: 1,
    maxLength,
    ...(description ? { description } : {}),
  };
}

function handleSchema(values: readonly string[], description: string): JsonSchema {
  return {
    type: 'string',
    enum: [...new Set(values)],
    description,
  };
}

function experimentSchema(protocol: MentalActSchemaProtocol): JsonSchema | undefined {
  const actionSpace = record(protocol.requestContext.actionSpace);
  const visibleContext = record(protocol.requestContext.visible);
  const held = describedRefs(actionSpace.heldObjects);
  // Foreign possessions are addressable by open world actions. The native
  // observation probe has no foreign-inventory target type yet.
  const foreignPossessions = new Set(protocol.handles.visible
    .filter((item) => item.kind === 'inventory-stack').map((item) => item.handle));
  const visible = describedRefs(visibleContext.nearbyObjects).filter((handle) => !foreignPossessions.has(handle));
  const voxels = describedRefs(visibleContext.surfaces);
  const described = held.length || visible.length || voxels.length;
  const allowedHeld = described ? held : protocol.handles.held.map((item) => item.handle);
  const allowedVisible = described ? visible : protocol.handles.visible
    .filter((item) => item.kind !== 'inventory-stack').map((item) => item.handle);
  const allowedVoxels = described ? voxels : protocol.handles.voxels.map((item) => item.handle);
  const variants: JsonSchema[] = [];
  const observable = [...allowedHeld, ...allowedVisible, ...allowedVoxels];
  if (observable.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['observe'] },
        targetHandle: handleSchema(observable, 'actionSpace.heldObjects 或 visible 中当前可观察对象的 ref'),
      },
    });
  }
  if (allowedHeld.length >= 2) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'stackHandles'],
      properties: {
        kind: { type: 'string', enum: ['combine'] },
        stackHandles: {
          type: 'array',
          minItems: 2,
          maxItems: Math.min(3, allowedHeld.length),
          uniqueItems: true,
          items: handleSchema(allowedHeld, 'actionSpace.heldObjects 中本人当前持有物品的 ref'),
        },
      },
    });
  }
  if (allowedHeld.length && allowedVoxels.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'inputHandle', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['expose'] },
        inputHandle: handleSchema(allowedHeld, 'actionSpace.heldObjects 中输入物的 ref'),
        targetHandle: handleSchema(allowedVoxels, 'visible.surfaces 中环境或设施的 ref'),
      },
    });
  }
  if (allowedHeld.length >= 2 && allowedVoxels.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'toolHandle', 'inputHandle', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['exert'] },
        toolHandle: handleSchema(allowedHeld, 'actionSpace.heldObjects 中工具的 ref'),
        inputHandle: handleSchema(allowedHeld, 'actionSpace.heldObjects 中输入物的 ref'),
        targetHandle: handleSchema(allowedVoxels, 'visible.surfaces 中环境或设施的 ref'),
      },
    });
  }
  if (allowedVoxels.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['move'] },
        targetHandle: handleSchema(allowedVoxels, 'visible.surfaces 中当前可见的地表位置 ref'),
      },
    });
  }
  return variants.length ? { oneOf: variants } : undefined;
}

function worldTargetHandles(protocol: MentalActSchemaProtocol): string[] {
  const actionSpace = record(protocol.requestContext.actionSpace);
  const visible = record(protocol.requestContext.visible);
  return [...new Set([
    'self',
    ...describedRefs(actionSpace.heldObjects),
    ...describedRefs(visible.nearbyObjects),
    ...describedRefs(visible.surfaces),
  ])];
}

function currentStepSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const targets = worldTargetHandles(protocol);
  const shared = {
    description: stringSchema(240, '人物此刻准备实施的具体动作；不写结果'),
    targetHandles: {
      type: 'array', minItems: 1, maxItems: Math.min(8, targets.length), uniqueItems: true,
      items: handleSchema(targets, '本步提及或实际作用的对象；自己用 self'),
    },
    expectedResult: stringSchema(180, '人物主观希望或猜测的结果，不是世界事实'),
  };
  const physical = {
    type: 'object', additionalProperties: false, required: ['kind', 'description', 'targetHandles'],
    properties: {
      kind: { type: 'string', enum: ['physical'], description: '本人这一步实际进行身体或物品操作，包含实际取放、观察、加工与创造' },
      ...shared,
      ...(protocol.requestContext.knownMethods?.length ? {
        methodHandle: handleSchema(protocol.requestContext.knownMethods.map((method) => method.handle), '参考已学方法进行本次重新绑定与试验，不复制旧结果'),
      } : {}),
      ...((protocol.handles.speechReferences ?? []).some((reference) => reference.kind === 'project') ? {
        projectHandle: handleSchema((protocol.handles.speechReferences ?? []).filter((reference) => reference.kind === 'project')
          .map((reference) => reference.handle), '本人已知且本次准备继续的项目或真实项目提案'),
      } : {}),
    },
  };
  // The declaration is committed with the decision. Plan schedules only the
  // additional bodily work; a speech-only choice can use stay/continue.
  return physical;
}

function planFeedbackSchema(protocol: MentalActSchemaProtocol): JsonSchema | undefined {
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  const current = record(protocol.requestContext.current);
  const compilationIds = [...new Set((Array.isArray(current.compilationFeedback) ? current.compilationFeedback : [])
    .flatMap((entry) => typeof record(entry).eventId === 'string' ? [record(entry).eventId as string] : []))];
  if (!memoryHandles.length && !compilationIds.length) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['correction', 'adjustment'],
    anyOf: [
      ...(memoryHandles.length ? [{ required: ['sourceMemoryHandles'] }] : []),
      ...(compilationIds.length ? [{ required: ['sourceCompilationEventIds'] }] : []),
    ],
    properties: {
      ...(memoryHandles.length ? { sourceMemoryHandles: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(3, memoryHandles.length),
        uniqueItems: true,
        items: handleSchema(memoryHandles, '本次修正依据的亲历失败'),
      } } : {}),
      ...(compilationIds.length ? { sourceCompilationEventIds: {
        type: 'array', minItems: 1, uniqueItems: true,
        items: handleSchema(compilationIds, 'current.compilationFeedback 中本人这次可核对的真实 Decision eventId；编译诊断不需要伪装成人物记忆'),
      } } : {}),
      correction: stringSchema(240, '被事实纠正的前提或缺失条件'),
      adjustment: stringSchema(240, '本次具体怎样改变做法'),
    },
  };
}

function concernSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const agendaHandles = protocol.handles.agendas.map((item) => item.handle);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['create', 'revise', 'pause', 'abandon'] },
      ...(agendaHandles.length ? {
        agendaHandle: handleSchema(agendaHandles, '已有 concern 的请求内句柄'),
      } : {}),
      importance: { type: 'integer', minimum: 0, maximum: 100 },
      horizonMonths: { type: 'integer', minimum: 6, maximum: 240 },
      reason: stringSchema(180, '暂停或放弃这一关切的第一人称理由'),
    },
  };
}

const RELATIONSHIP_APPRAISAL_MEANINGS = [
  'gratitude', 'care', 'affection', 'attraction', 'respect', 'solidarity', 'obligation',
  'hurt', 'anger', 'fear', 'suspicion', 'jealousy', 'rivalry', 'grief', 'ambivalence', 'uncertainty',
] as const;

function relationshipAppraisalSchema(protocol: MentalActSchemaProtocol): JsonSchema | undefined {
  const visible = record(protocol.requestContext.visible);
  const personHandles = Array.isArray(visible.nearbyObjects)
    ? visible.nearbyObjects.flatMap((value) => {
        const item = record(value);
        return item.kind === '人物' && typeof item.ref === 'string' && item.ref ? [item.ref] : [];
      })
    : [];
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  if (!personHandles.length || !memoryHandles.length) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['otherPersonHandle', 'sourceMemoryHandles', 'meanings', 'interpretation'],
    properties: {
      otherPersonHandle: handleSchema(personHandles, '眼前被本人理解的人物'),
      sourceMemoryHandles: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(4, memoryHandles.length),
        uniqueItems: true,
        items: handleSchema(memoryHandles, '确实涉及对方的亲历记忆'),
      },
      meanings: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        items: { type: 'string', enum: [...RELATIONSHIP_APPRAISAL_MEANINGS] },
      },
      interpretation: stringSchema(320, '本人对真实经历的主观理解'),
      unresolvedExpectation: stringSchema(240, '未解的期待、疑虑、债或怨'),
      desiredResponse: stringSchema(240, '本人当前倾向采取的回应，不是行动命令'),
    },
  };
}

function proposalTermsSchema(protocol: MentalActSchemaProtocol, kind: string): JsonSchema {
  if (kind === 'joint-action') return {
    type: 'object', additionalProperties: false,
    description: '临时一起做一件具体的事；事项采用本人本次原话，不需要协助类别或默认期限',
    properties: {
      summary: stringSchema(240, '仅在调用者没有原话时显式说明事项；本人已有utterance时采用原话，不从goal或commitment补条款'),
      expiresAtMonth: { type: 'integer', minimum: 0, description: '只有本人明确声明期限时填写；未声明则省略，不换算未说出的时间' },
    },
  };
  const references = protocol.handles.speechReferences ?? [];
  const reference = (referenceKind: string) => references.filter((item) => item.kind === referenceKind).map((item) => item.handle);
  const people = ['self', ...protocol.handles.visible.filter((item) => item.kind === 'person').map((item) => item.handle)];
  const knownMaterialKeys = new Set<string>();
  const collectMaterials = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collectMaterials); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const material = MATERIAL_PALETTE.find((material) => material.id !== 0
      && (material.key === item.materialKey || material.name === item.name));
    if (material) knownMaterialKeys.add(material.key);
    Object.values(item).forEach(collectMaterials);
  };
  collectMaterials(protocol.requestContext.actionSpace);
  collectMaterials(protocol.requestContext.visible);
  collectMaterials(protocol.requestContext.knownMethods);
  const material = knownMaterialKeys.size ? handleSchema([...knownMaterialKeys], '本人已经见过或学过的实际材料') : undefined;
  const integer = { type: 'integer', minimum: 0 };
  const positive = { type: 'integer', minimum: 1 };
  const props: Record<string, JsonSchema> = {
    expiresAtMonth: { ...integer, description: '本人提出的有效期，使用实际世界月数；不由Plan代填默认期限' },
  };
  const addReference = (field: string, referenceKind: string): void => {
    const values = reference(referenceKind);
    if (values.length) props[field] = handleSchema(values, '本人已知的实际事项引用');
  };
  const approvers = { type: 'array', minItems: 1, uniqueItems: true, items: handleSchema(people, '本人提议需要参与决定的人，不表示他们已同意') };
  if (kind === 'assist') props.need = { type: 'string', enum: ['water', 'food', 'shelter', 'company'], description: '本人请求的具体协助；company是陪伴，不自动代指任意施工任务' };
  if (kind === 'companion' && protocol.handles.voxels.length) {
    props.anchorHandle = handleSchema(protocol.handles.voxels.map((item) => item.handle), '本人提出的共同生活位置');
    props.anchorRadius = { type: 'number', minimum: 0 };
  }
  if (kind === 'collective') props.purposeSummary = stringSchema(240, '本人提出的共同体实际目的，不替换为系统默认目的');
  if (kind === 'exchange') {
    if (material) { props.offererMaterialKey = material; props.partnerMaterialKey = material; }
    props.offererQuantity = positive; props.partnerQuantity = positive;
  }
  if (['membership', 'permission', 'decision-rule', 'mandate'].includes(kind)) addReference('collectiveHandle', 'collective');
  if (['membership', 'decision-rule', 'mandate'].includes(kind)) props.requiredApproverHandles = approvers;
  if (kind === 'membership') props.candidateHandle = handleSchema(people, '本人提出的加入人');
  if (kind === 'permission') {
    if (material) props.materialKey = material;
    props.maxQuantityPerTransfer = positive; props.validUntilMonth = integer;
  }
  if (kind === 'decision-rule') {
    props.method = { type: 'string', enum: ['unanimous', 'majority-vote'] };
    props.mandateDurationMonths = positive;
    props.scope = { type: 'string', enum: ['coordinate-material', 'assign-recurring-duty'] };
    if (material) props.materialKey = material;
    const functions = [...new Set((protocol.requestContext.knownProjects ?? []).flatMap((project) =>
      typeof project.desiredFunction === 'string' ? [project.desiredFunction] : []))];
    props.projectDuty = { type: 'object', additionalProperties: false, properties: {
      projectKind: { type: 'string', enum: ['production', 'construction', 'inquiry'] },
      ...(functions.length ? { desiredFunction: handleSchema(functions, '本人已知的项目功能') } : {}),
      progressKind: { type: 'string', enum: ['material-contribution', 'knowledge-contribution', 'logistics-advance', 'action-progress'] },
    } };
  }
  if (kind === 'mandate') {
    addReference('decisionRuleHandle', 'decision-rule'); addReference('projectHandle', 'project');
    props.holderHandle = handleSchema(people, '本人提议承担职责的人');
  }
  return {
    type: 'object', additionalProperties: false, properties: props,
    description: '只填写本人这次确实提出的条款；缺少条款时保留原话与缺失反馈，不凭空补出承诺',
  };
}

function speechIntentSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const people = protocol.handles.visible.filter((item) => item.kind === 'person').map((item) => item.handle);
  const references = protocol.handles.speechReferences ?? [];
  const referenceKinds = {
    accept: 'agreement', reject: 'agreement', 'end-agreement': 'agreement',
    'revoke-permission': 'permission', 'leave-collective': 'collective', 'share-knowledge': 'knowledge',
  };
  const variant = (kind: string, properties: Record<string, JsonSchema> = {}, required = Object.keys(properties)): JsonSchema => ({
    type: 'object', additionalProperties: false, required: ['kind', ...required],
    properties: { kind: { type: 'string', enum: [kind] }, ...properties },
  });
  return {
    description: '人物自己说明原话的实际含义和条款；普通表达不建立协议，Plan和World不能增加本人未选择的承诺',
    oneOf: [
      variant('expression'), variant('request-information'),
      variant('prediction', { terms: { type: 'object', additionalProperties: false, properties: {
        targetEpoch: { type: 'string', enum: ['stable', 'chaotic'] },
        predictedStartMonth: { type: 'integer', minimum: 0 }, toleranceMonths: { type: 'integer', minimum: 0 },
        expiresAtMonth: { type: 'integer', minimum: 0 },
      } } }, []),
      ...(people.length ? SPEECH_PROPOSAL_KINDS.map((kind) => variant('proposal', {
        proposalKind: { type: 'string', enum: [kind] },
        counterpartHandles: { type: 'array', minItems: 1, uniqueItems: true, items: handleSchema(people, '本人提议的可见对方') },
        ...(kind !== 'joint-action' ? { commitment: stringSchema(240, '本人具体提出的事项，不表示对方已经同意') } : {}),
        terms: proposalTermsSchema(protocol, kind),
      }, kind === 'joint-action' ? ['proposalKind', 'counterpartHandles'] : ['proposalKind', 'counterpartHandles', 'commitment'])) : []),
      ...Object.entries(referenceKinds).flatMap(([kind, referenceKind]) => {
        const refs = references.filter((item) => item.kind === referenceKind).map((item) => item.handle);
        return refs.length ? [variant(kind, { referenceHandle: handleSchema(refs, 'speechReferences 中这句话实际针对的事项') })] : [];
      }),
    ],
  };
}

function mentalActProperties(protocol: MentalActSchemaProtocol): Record<string, JsonSchema> {
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  return {
    utterance: stringSchema(180, '人物本次决定形成的唯一第一人称语言波；三体人没有与说话分离的私密思考'),
    delivery: {
      type: 'string',
      enum: ['whisper', 'normal', 'call'],
      description: 'whisper 低强度、normal 正常、call 高强度；只改变传播，不指定听者',
    },
    speechIntent: speechIntentSchema(protocol),
    goal: stringSchema(240, '人物此刻真正想达到或弄清的事情'),
    strategy: stringSchema(320, '人物现在准备采用的可失败方法'),
    assumptions: {
      type: 'array',
      minItems: 0,
      maxItems: 4,
      uniqueItems: true,
      items: stringSchema(180, '尚未证实的主观猜想'),
    },
    expectedObservation: stringSchema(240, '采取下一步后预计亲眼观察到的现象'),
    ...(memoryHandles.length ? {
      evidenceMemoryHandles: {
        type: 'array',
        minItems: 0,
        maxItems: Math.min(4, memoryHandles.length),
        uniqueItems: true,
        items: handleSchema(memoryHandles, 'mind.recentEvidence 或 learnedConclusions 中本轮可引用的记忆句柄'),
      },
    } : {}),
  };
}

function mentalActObjectSchema(
  protocol: MentalActSchemaProtocol,
  kinds: readonly string[],
  options: {
    stepHandles?: readonly string[];
    requireStep?: boolean;
    allowContinuation?: boolean;
    allowGrounding?: boolean;
    allowConcern?: boolean;
    allowExperiment?: boolean;
  } = {},
): JsonSchema {
  const stepHandles = [...new Set(options.stepHandles ?? [])];
  const continuationHandles = protocol.requestContext.continuations.map((step) => step.handle);
  const groundingHandles = protocol.handles.groundingFacts.map((item) => item.handle);
  const experiment = options.allowExperiment ? experimentSchema(protocol) : undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'kind',
      'utterance',
      'delivery',
      'goal',
      'strategy',
      'assumptions',
      ...(options.requireStep ? ['firstStepHandle'] : []),
    ],
    properties: {
      kind: { type: 'string', enum: [...kinds] },
      ...mentalActProperties(protocol),
      ...(stepHandles.length ? {
        firstStepHandle: handleSchema(stepHandles, 'availableSteps 中当前可尝试的步骤句柄'),
      } : {}),
      ...(options.allowContinuation && continuationHandles.length ? {
        continuationHandle: handleSchema(continuationHandles, 'continuations 中与当前步骤配套的后续句柄'),
      } : {}),
      ...(options.allowGrounding && groundingHandles.length ? {
        groundingFactHandles: {
          type: 'array',
          minItems: 0,
          maxItems: Math.min(3, groundingHandles.length),
          uniqueItems: true,
          items: handleSchema(groundingHandles, '本轮交流允许引用的事实句柄'),
        },
      } : {}),
      ...(options.allowConcern && protocol.characterAgendaProposal ? {
        concern: concernSchema(protocol),
      } : {}),
      ...(options.allowExperiment && protocol.characterAgendaProposal && experiment ? {
        experiment,
      } : {}),
    },
  };
}

function mentalActDecisionSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const communicationSteps = protocol.requestContext.availableSteps
    .filter((step) => typeof step.communicationKind === 'string')
    .map((step) => step.handle);
  const directionalSteps = protocol.requestContext.availableSteps
    .filter((step) => typeof step.communicationKind !== 'string')
    .map((step) => step.handle);
  return {
    oneOf: [
      mentalActObjectSchema(protocol, ['pursue', 'investigate', 'reconsider'], {
        stepHandles: directionalSteps,
        allowContinuation: true,
        allowConcern: true,
        allowExperiment: true,
      }),
      ...(communicationSteps.length ? [mentalActObjectSchema(protocol, ['talk'], {
        stepHandles: communicationSteps,
        requireStep: true,
        allowContinuation: true,
        allowGrounding: true,
        allowConcern: true,
      })] : []),
      mentalActObjectSchema(protocol, ['continue', 'wait']),
    ],
  };
}

function mindIntentionSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  const relationshipAppraisal = relationshipAppraisalSchema(protocol);
  const definitions: Record<string, JsonSchema> = {
      intentionChange: {
        type: 'object', additionalProperties: false,
        description: '本人明确建立或改变目标时填写，可以私下改变目标；是否发言独立选择，当前安排由attempt明确，不从目标自动生成话语或动作',
        required: ['goal', 'orientation', 'horizon'],
        properties: {
          goal: stringSchema(240, '本人现在选择的新目标'),
          orientation: { type: 'string', enum: ['social', 'inquiry', 'survival', 'construction', 'acquisition', 'exploration', 'rest'] },
          horizon: { type: 'string', enum: ['momentary', 'ongoing'] },
        },
      },
      attempt: {
        description: '本人本次明确选择的安排：creative描述身体尝试，speak描述想说的意思，continue保持当前工作或空闲，wait明确停下来；不要求动手或发言',
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['kind', 'description'], properties: {
            kind: { type: 'string', enum: ['creative'] },
            description: stringSchema(480, '本人现在想做什么、作用于什么对象；用清楚的自然语言，包括普通行动或新做法，结果尚未发生，不写引擎参数'),
          } },
          { type: 'object', additionalProperties: false, required: ['kind', 'description'], properties: {
            kind: { type: 'string', enum: ['speak'] },
            description: stringSchema(480, '本人这次想表达、询问或提议的意思；世界只实现这份说话意向，不增加未提出的条款。有declaration时采用已选原话，不再说第二遍'),
          } },
          { type: 'object', additionalProperties: false, required: ['kind'], properties: {
            kind: { type: 'string', enum: ['continue'] },
          } },
          { type: 'object', additionalProperties: false, required: ['kind'], properties: {
            kind: { type: 'string', enum: ['wait'] },
          } },
        ],
      },
      declaration: {
        type: 'object', additionalProperties: false,
        description: '本次新原话、本人言语含义及真实依据；单独发言不改变目标或身体计划',
        required: ['utterance', 'delivery', 'speechIntent'],
        properties: {
          utterance: stringSchema(180, '本人这次向外传播的第一人称原话'),
          delivery: { type: 'string', enum: ['whisper', 'normal', 'call'], description: '语言波强度，不选择听者' },
          speechIntent: speechIntentSchema(protocol),
          ...(memoryHandles.length ? { evidenceMemoryHandles: {
            type: 'array', uniqueItems: true,
            items: handleSchema(memoryHandles, '本轮可引用的本人记忆句柄'),
          } } : {}),
          ...(relationshipAppraisal ? { relationshipAppraisal } : {}),
        },
      },
  };
  return {
    type: 'object', additionalProperties: false, required: ['attempt'],
    description: '每次明确选择当前安排attempt；intentionChange与declaration独立可选，未填写就不改变目标或不发言',
    properties: Object.fromEntries(Object.keys(definitions).map((field) => [field, { $ref: `#/$defs/${field}` }])),
    $defs: definitions,
  };
}

function modelPlanSchema(protocol: MentalActSchemaProtocol, schemaPath = '#'): JsonSchema {
  const suspendedIntentHandles = (protocol.handles.suspendedIntents ?? []).map((intent) => intent.handle);
  const resumableIntentHandles = (protocol.handles.suspendedIntents ?? [])
    .filter((intent) => intent.resumable).map((intent) => intent.handle);
  const feedback = planFeedbackSchema(protocol);
  const properties: Record<string, JsonSchema> = {
    disposition: {
      type: 'string', enum: ['act', 'continue', 'pause', 'abandon', 'stay'],
      description: '本人本轮执行、继续、搁置、放弃或停留的安排；非 act 不携带新的动作描述',
    },
    steps: {
      type: 'array', minItems: 1,
      items: stringSchema(240, '围绕冻结意图的一个具体规划步骤，保留尚待实际结果决定的后续过程'),
    },
    completion: planCompletionSchema(protocol),
    currentStep: currentStepSchema(protocol),
    ...(resumableIntentHandles.length ? {
      resumeIntentHandle: handleSchema(resumableIntentHandles, '本人恢复的当前可恢复事务；与 currentStep 二选一'),
    } : {}),
    ...(suspendedIntentHandles.length ? {
      abandonIntentHandle: handleSchema(suspendedIntentHandles, '本人放弃的已有事务；只与 abandon 同用'),
    } : {}),
    ...(feedback ? { feedback } : {}),
  };
  const common = ['steps', 'completion', ...(feedback ? ['feedback'] : [])];
  const variant = (dispositions: string[], entry?: string, optional: string[] = []): JsonSchema => ({
    type: 'object', additionalProperties: false,
    required: ['steps', 'disposition', 'completion', ...(entry ? [entry] : [])],
    properties: {
      disposition: { type: 'string', enum: dispositions },
      ...Object.fromEntries([...common, ...(entry ? [entry] : []), ...optional]
        .filter((field) => properties[field])
        .map((field) => [field, { $ref: `${schemaPath}/properties/${field}` }])),
    },
  });
  return {
    type: 'object', additionalProperties: false,
    required: ['steps', 'disposition', 'completion'], properties,
    oneOf: [
      variant(['act'], 'currentStep'),
      ...(resumableIntentHandles.length ? [variant(['act'], 'resumeIntentHandle')] : []),
      variant(['continue', 'pause', 'stay']),
      variant(['abandon'], undefined, ['abandonIntentHandle']),
    ],
  };
}

function planCompletionSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const targets = worldTargetHandles(protocol);
  const agreementHandles = [...new Set([...(protocol.handles.speechReferences ?? []), ...(protocol.handles.nativeReferences ?? [])]
    .filter((reference) => reference.kind === 'agreement').map((reference) => reference.handle))];
  const personHandles = targets.filter((handle) => handle === 'self'
    || protocol.handles.visible.some((entry) => entry.handle === handle && entry.kind === 'person'));

  const visibleTargets = new Set(targets);
  const workTargets = [
    'produced-work',
    ...protocol.handles.visible.filter((target) => target.kind === 'work' && visibleTargets.has(target.handle)).map((target) => target.handle),
    ...protocol.handles.voxels.filter((target) => visibleTargets.has(target.handle)).map((target) => target.handle),
  ];
  const voxelTargets = protocol.handles.voxels.filter((target) => visibleTargets.has(target.handle)).map((target) => target.handle);
  const material = handleSchema(MATERIAL_PALETTE.filter((material) => material.id !== 0).map((material) => material.key), '真实基础材料');
  const quantity = { type: 'integer', minimum: 1 };
  const physicalValue = { type: 'number', minimum: 0, maximum: 100 };
  const conditionMeanings: Record<string, string> = {
    'inventory-at-least': '本人当前实际持有的该材料数量达到要求；附近可见材料不算持有',
    'near-target': '本人当前与对象的实际距离满足要求；只证明位置，不证明观察、交谈或创造已完成',
    'reached-target': '本计划期间本人曾实际到达指定距离内；只证明到访，不证明交谈、合作或创造已完成',
    'voxel-is': '指定的精确体素当前位置确实是该材料；不依据物件名称或设想判断',
    'body-at-least': '本人当前实际身体指标达到指定数值；不是对身体的观察或愿望',
    sheltered: '本人当前身体位置确有可用墙顶几何提供遮蔽；看过、接近或想建住所均不满足',
    'work-state': '实际存在的造物及其当前材料、磨损或物理属性满足所填条件；不证明别人的同意或设施的任意预期功能',
  };
  const variant = (kind: string, properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
    type: 'object', description: conditionMeanings[kind], additionalProperties: false, required: ['kind', ...required],
    properties: { kind: { type: 'string', enum: [kind] }, ...properties },
  });
  const condition = { oneOf: [
    variant('inventory-at-least', { materialKey: material, quantity }),
    variant('near-target', { targetHandle: handleSchema(targets, '当前需要保持在附近的可见对象'), maxDistance: physicalValue }),
    variant('reached-target', { targetHandle: handleSchema(targets, '本计划中需要实际到访一次的对象；到达事件会被保留，不要求之后一直站在那里'), maxDistance: physicalValue }),
    ...(voxelTargets.length ? [variant('voxel-is', {
      targetHandle: handleSchema(voxelTargets, '需要实际变成该材料的精确位置'), materialKey: material,
    })] : []),
    variant('body-at-least', { field: { type: 'string', enum: ['health', 'hydration', 'nutrition'] }, value: physicalValue }),
    variant('sheltered', {}),
    ...(agreementHandles.length ? [
      variant('agreement-status', {
        agreementHandle: handleSchema(agreementHandles, '本轮已知的真实协议'),
        status: { type: 'string', enum: [...AGREEMENT_STATUSES],
          description: '协议当前实际状态，不用位置或提议替代有效同意；active仍不代表已经履约' },
      }),
      ...(personHandles.length ? [variant('agreement-response-recorded', {
        agreementHandle: handleSchema(agreementHandles, '本轮已知的真实协议'),
        personHandle: handleSchema(personHandles, '其真实回应需要被核对的本人或其他人'),
        response: { type: 'string', enum: ['accepted', 'rejected'],
          description: '本人对该协议已有明确回应记录；历史接受不证明仍获许可，也不表示他人已完成行动' },
      })] : []),
    ] : []),
    variant('work-state', {
      targetHandle: handleSchema(workTargets, '已有构件用 w 引用；本次新造物用 produced-work，执行后绑定真实实体；v 只表示精确槽位'),
      minCondition: physicalValue,
      minProfile: {
        type: 'object', additionalProperties: false,
        properties: { cover: physicalValue, rigidity: physicalValue, stability: physicalValue },
      },
      components: {
        type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['materialKey', 'quantity'],
          properties: { materialKey: material, quantity },
        },
      },
    }, ['targetHandle']),
  ] };
  const check = {
    type: 'object', additionalProperties: false, required: ['description', 'conditions'],
    properties: {
      description: stringSchema(240, '该步骤或总目标具体达到什么状态才算完成'),
      conditions: {
        type: 'array',
        description: '全部条件同时满足才完成；不具备当前可核验条件时可为空，系统会记为未验证，绝不凭名称宣布成功',
        items: condition,
      },
    },
  };
  return {
    type: 'object', additionalProperties: false, required: ['step', 'goal'],
    properties: { step: check, goal: check },
  };
}

function batchSchema(
  name: string,
  protocols: readonly MentalActSchemaProtocol[],
  schemaFor: (protocol: MentalActSchemaProtocol, schemaPath: string) => JsonSchema,
): ModelJsonSchema {
  const rowVariants = protocols.map((protocol, index): JsonSchema => ({
    type: 'object',
    additionalProperties: false,
    required: ['agentHandle', 'value'],
    properties: {
      agentHandle: { type: 'string', enum: [`a${index + 1}`] },
      value: { anyOf: [{ type: 'null' }, schemaFor(protocol, `#/properties/items/items/oneOf/${index}/properties/value/anyOf/1`)] },
    },
  }));
  return {
    name,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          minItems: protocols.length,
          maxItems: protocols.length,
          items: { oneOf: rowVariants },
        },
      },
    },
  };
}

export function buildMindIntentionJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return { name: 'eland_mind_intention_v4', schema: mindIntentionSchema(protocol) };
}

/** Only realizes the actor's selected meaning; no physical operation or new goal. */
export function buildWorldSpeechJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return { name: 'eland_world_speech_v1', schema: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['declaration'], properties: {
      declaration: { type: 'object', additionalProperties: false, required: ['utterance', 'delivery', 'speechIntent'],
        description: '将本人已选的说话意思形成原话；不新增对象、数量、期限、承诺或他人同意。条款不完整仍可表达询问或不完整提议',
        properties: {
          utterance: stringSchema(180, '本人实际说出的完整原话，忠实于selectedSpeech'),
          delivery: { type: 'string', enum: ['whisper', 'normal', 'call'] },
          speechIntent: speechIntentSchema(protocol),
        },
      },
    } },
    { type: 'object', additionalProperties: false, required: ['uncompiled'], properties: {
      uncompiled: { type: 'object', additionalProperties: false, required: ['reason'],
        properties: { reason: stringSchema(480, '只有无法保留本人选定意思时说明具体原因；缺少交换数量或对方同意不阻止本人提出问题') } },
    } },
  ] } };
}

export function buildModelPlanJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return { name: 'eland_model_plan_v1', schema: modelPlanSchema(protocol) };
}

function nativeOperationSchema(protocol: MentalActSchemaProtocol, selectedTargets?: string[], allowSpeech = true): JsonSchema {
  const targets = deriveWorldTargets(protocol.targetContext ?? protocol.requestContext, protocol.handles,
    selectedTargets ?? worldTargetHandles(protocol)).allowedHandles;
  const target = handleSchema(targets, '本次语义步骤所引用的实际实体；self 表示行动者本人');
  const explicitTargets = new Set(selectedTargets ?? worldTargetHandles(protocol));
  const movementTargets = targets.filter((handle) => explicitTargets.has(handle)
    || !protocol.handles.voxels.some((voxel) => voxel.handle === handle)
      && !protocol.handles.held.some((held) => held.handle === handle));
  const movementTarget = handleSchema(movementTargets, '本人行走到实体身边或明确选定的精确体素；不搬动目标物，为实体派生的位置锚点仍用于放置和搭建');
  const heldTargets = targets.filter((handle) => protocol.handles.held.some((item) => item.handle === handle));
  const heldObject = heldTargets.length ? handleSchema(heldTargets, '本人真实持有、可明确选作材料或工具的物件；徒手操作时省略工具字段') : undefined;
  const refs = protocol.handles.nativeReferences ?? [];
  const refsOf = (kind: string) => refs.filter((reference) => reference.kind === kind).map((reference) => reference.handle);
  const refProperties = Object.fromEntries(['project', 'record', 'knowledge', 'technique', 'agreement'].flatMap((kind) => {
    const values = refsOf(kind);
    return values.length ? [[`${kind}Handle`, handleSchema(values, '本轮描述中真实的项目、记录、知识或约定来源')]] : [];
  }));
  const sources = refsOf('source');
  if (sources.length) refProperties.sourceHandles = {
    type: 'array', uniqueItems: true, items: handleSchema(sources, '本次操作所依据的已有事实'),
  };
  const backgroundReferences = { type: 'object', additionalProperties: false, properties: refProperties,
    description: '本人已知的事实或共同事项背景；仅保留来源，不选择方法、不授予技能或同意，也不产生项目进度' };
  const variant = (kind: string, properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
    type: 'object', additionalProperties: false, required: ['kind', ...required],
    properties: { kind: { type: 'string', enum: [kind] }, ...properties,
      ...(kind !== 'speech' && kind !== 'use-method' && Object.keys(refProperties).length ? { backgroundReferences } : {}) },
  });
  const material = handleSchema(MATERIAL_PALETTE.filter((item) => item.id !== 0).map((item) => item.key), '真实要处理或转移的基础材料');
  const assemblyLayout = {
    type: 'array', minItems: 1,
    description: '相对固定锚点的完整布局，包含零偏移；每格对应一份实际固体组件，改造时是修改后的全布局',
    items: { type: 'object', additionalProperties: false, required: ['offset', 'materialKey'], properties: {
      offset: { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'], properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
      } },
      materialKey: handleSchema(MATERIAL_PALETTE.filter((item) => item.phase === 'solid').map((item) => item.key), '本次投入或原造物中真实已有的材料，不由布局生成物料'),
    } },
  };
  const assemblyInputs = { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['targetHandle', 'quantity'], properties: {
      targetHandle: handleSchema(heldTargets, '本次实际投入的本人持物'),
      quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
  } };
  const assemblyProperties = { arrangement: { type: 'string', enum: ['support', 'pile', 'lash', 'form'] },
    layout: assemblyLayout, summary: stringSchema(160, '可选的本人命名或形态描述，不指定设施功能或成功结果') };
  const knowledge = refsOf('knowledge');
  const projects = refs.filter((reference) => reference.kind === 'project'
    && (protocol.requestContext.knownProjects ?? []).some((project) => project.status !== 'proposed'
      && (project.id === reference.id || project.ref === reference.handle))).map((reference) => reference.handle);
  const sites = targets.filter((handle) => protocol.handles.voxels.some((voxel) => voxel.handle === handle));
  const workTargets = targets.filter((handle) => protocol.handles.visible.some((item) => item.handle === handle && item.kind === 'work'));
  const actorId = protocol.handles.actorId ?? record(protocol.requestContext.person).id;
  const roleHandles = (role: NativeActTargetRole): string[] => targets.filter((handle) => {
    if (role === 'held') return heldTargets.includes(handle);
    if (role === 'voxel') return sites.includes(handle);
    const visible = protocol.handles.visible.find((item) => item.handle === handle);
    if (role === 'person') return handle === 'self' || visible?.kind === 'person';
    if (role === 'other-person') return visible?.kind === 'person' && visible.personId !== actorId;
    return visible?.kind === role;
  });
  const actVariants = Object.entries(NATIVE_ACT_PARAMETER_SHAPES).flatMap(([operation, patterns]) => {
    if (hasDedicatedNativeActWire(operation)) return [];
    const alternatives: JsonSchema[] = patterns.filter((pattern) => !pattern.requiresBoundCapability
      && (pattern.tool !== 'required' || heldObject)
      && pattern.targets.every(({ role }) => roleHandles(role).length > 0)).map((pattern) => ({
      properties: { targetHandles: {
        type: 'array', minItems: pattern.targets.reduce((sum, role) => sum + role.min, 0),
        ...(pattern.targets.every((role) => role.max !== undefined)
          ? { maxItems: pattern.targets.reduce((sum, role) => sum + role.max!, 0) } : {}),
        items: handleSchema(pattern.targets.flatMap(({ role }) => roleHandles(role)), pattern.description),
        allOf: pattern.targets.map(({ role }) => ({ contains: handleSchema(roleHandles(role), '该参数角色需要实际对象') })),
      } },
      ...(pattern.tool === 'required' ? { required: ['toolHandle'] } : {}),
      ...(pattern.tool === 'forbidden' ? { not: { required: ['toolHandle'] } } : {}),
    }));
    return alternatives.length ? [{ ...variant('act', {
      operation: { type: 'string', enum: [operation] }, targetHandles: { type: 'array', items: target },
      ...(heldObject ? { toolHandle: heldObject } : {}),
    }, ['operation', 'targetHandles']), anyOf: alternatives }] : [];
  });
  const namedActVariants = NATIVE_ACT_WIRE_DEFINITIONS.flatMap((definition) => {
    if (definition.parameters.some((parameter) => !parameter.optional && !roleHandles(parameter.role).length)) return [];
    const parameters = definition.parameters.filter((parameter) => roleHandles(parameter.role).length);
    return [{ ...variant(definition.kind, Object.fromEntries(parameters.map((parameter) => [parameter.field,
      handleSchema(roleHandles(parameter.role), parameter.description)])),
      parameters.filter((parameter) => !parameter.optional).map((parameter) => parameter.field)), description: definition.meaning }];
  });
  const methods = scopedNativeMethods(protocol.targetContext ?? protocol.requestContext, protocol.handles, selectedTargets);
  return {
    description: '按当前步骤语义选择原生操作和真实参数；既有descriptor保留能力来源，不是按序号执行的菜单。实际结果由原生执行器产生。',
    oneOf: [
      { ...variant('approach', { targetHandle: movementTarget }),
        description: '靠近所选人物、物件或环境，到可接触的邻位；已经在接触范围内就不必移动，不要求走进对象占据的位置。' },
      variant('walk-to', { targetHandle: movementTarget, withinDistance: { type: 'number', minimum: 0,
        description: '到达后与目标允许剩余的最大间隔，不是当前距离或要走的步数；操作材料需要到可接触位置。省略时寻找接触邻位，0表示目标所在空位。' } }, ['targetHandle']),
      variant('observe', { targetHandle: target }, ['targetHandle']),
      ...(methods.length ? [variant('use-method', {
        methodHandle: handleSchema(methods.map((method) => method.handle), '精确调用本轮已展示的方法；作用对象、参数、实际来源与目标均由该方法绑定，不重填或拼接'),
      })] : []),
      variant('transfer', {
        sourceHandle: target, destinationHandle: target,
        quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        materialKey: material, ...(heldObject ? { containerHandle: heldObject } : {}),
        ...(refsOf('stack').length ? { sourceStackHandle: handleSchema(refsOf('stack'), '已描述容器中真实的那份物品，区分同材载体') } : {}),
      }, ['sourceHandle', 'destinationHandle', 'quantity']),
      ...(sites.length && heldTargets.length ? [variant('assemble', {
        targetHandle: handleSchema(sites, '真实位置；创建新造物的锚点，空位、接触和支撑由执行器核验'),
        inputs: { ...assemblyInputs, minItems: 1 }, ...assemblyProperties,
      }, ['targetHandle', 'inputs', 'arrangement'])] : []),
      ...(workTargets.length ? [{ ...variant('assemble', {
        targetHandle: handleSchema(workTargets, '改造这件真实造物，保持其身份和锚点；只重排时inputs可为空'),
        inputs: heldTargets.length ? assemblyInputs : { type: 'array', maxItems: 0 }, ...assemblyProperties,
      }, ['targetHandle', 'inputs']), anyOf: [
        { properties: { inputs: { minItems: 1 } } }, { required: ['layout'] }, { required: ['arrangement'] },
      ] }] : []),
      ...actVariants,
      ...namedActVariants,
      ...(heldObject ? [variant('inscribe', {
        carrierHandle: heldObject,
        ...(knowledge.length ? { knowledgeHandle: handleSchema(knowledge, '本人记录的已知内容'), codebookHandle: handleSchema(knowledge, '本人已理解的符号约定') } : {}),
        text: stringSchema(240, '实际准备刻写的内容；不会由此产生已经理解或核验的知识'),
      }, ['carrierHandle'])] : []),
      ...(projects.length ? [variant('project', {
        projectHandle: handleSchema(projects, '只接续本人已知且真实存在的项目；新创造使用本次计划与开放物理编译'),
        ...(sites.length ? { siteHandle: handleSchema(sites, '实际项目位置') } : {}),
      }, ['projectHandle'])] : []),
      ...(!allowSpeech || record(protocol.requestContext.current).planContinuation ? [] : [variant('speech', {})]),
    ],
  };
}

function completionReviewSchema(): JsonSchema {
  const scopeReview = {
    type: 'object', additionalProperties: false, required: ['sufficiency', 'reason'],
    properties: {
      sufficiency: {
        type: 'string', enum: ['sufficient', 'insufficient', 'unverified'],
        description: '评审时假设每个候选条件都成立，再判断是否足以说明核心目标；不能因当前仍在准备、尚未执行完成而判 insufficient',
      },
      reason: stringSchema(240, '指明具体候选条件怎样覆盖或遗漏目标；不足时给出所有条件全真仍未达到核心目标的反例，不能只描述当前动作尚未完成'),
    },
  };
  return {
    type: 'object', additionalProperties: false, required: ['step', 'goal'],
    description: '对步骤与整体目标判据的可错语义评估；WorldPlan中来自同次编译，条件真假由执行器核验。缺失检查保持未验证，不取消合法动作',
    properties: { step: scopeReview, goal: scopeReview },
  };
}

/** Typed mutation vocabulary teaches the resolver how to materialize unfamiliar ideas.
 * Object identity is restricted to the actor's own request, never a generated id.
 */
export function buildWorldResolutionJsonSchema(
  protocol: MentalActSchemaProtocol,
  worldAction?: { targetHandles: string[]; kind?: 'speech' | 'physical' },
): ModelJsonSchema {
  const completionReview = completionReviewSchema();
  if (worldAction?.kind === 'speech') return {
    name: 'eland_world_resolution_v3',
    schema: {
      type: 'object', additionalProperties: false, required: ['nativeOperation'],
      properties: {
        completionReview,
        nativeOperation: {
          type: 'object', additionalProperties: false, required: ['kind'],
          properties: { kind: { type: 'string', enum: ['speech'] } },
        },
      },
    },
  };
  const targets = deriveWorldTargets(protocol.targetContext ?? protocol.requestContext, protocol.handles,
    worldAction?.targetHandles ?? worldTargetHandles(protocol)).allowedHandles;
  const target = handleSchema(targets, '人物已选对象、本人的真实持物及本轮已展示的位置引用；派生来源见 targetBindings');
  const foreignPossessions = new Set(protocol.handles.visible
    .filter((item) => item.kind === 'inventory-stack').map((item) => item.handle));
  const held = new Set(protocol.handles.held.map((item) => item.handle));
  const dropped = new Set(protocol.handles.visible.filter((item) => item.kind === 'drop').map((item) => item.handle));
  const people = new Set(protocol.handles.visible.filter((item) => item.kind === 'person').map((item) => item.handle));
  const voxels = new Set(protocol.handles.voxels.map((item) => item.handle));
  const placementTargets = targets.filter((handle) => voxels.has(handle));
  const structureTargets = targets.filter((handle) => voxels.has(handle)
    || protocol.handles.visible.some((item) => item.handle === handle && item.kind === 'work'));
  const consumable = targets.filter((handle) => held.has(handle) || dropped.has(handle) || voxels.has(handle));
  const transferable = targets.filter((handle) => held.has(handle) || dropped.has(handle) || foreignPossessions.has(handle));
  const transferDestinations = targets.filter((handle) => handle === 'self' || people.has(handle) || voxels.has(handle));
  const relocatable = targets.filter((handle) => held.has(handle) || dropped.has(handle));
  const groundDestinations = targets.filter((handle) => voxels.has(handle));
  const material = handleSchema(MATERIAL_PALETTE.filter((item) => item.id !== 0).map((item) => item.key),
    '实际基础材料；新复合造物使用 assemble，不需要预制同名材料');
  const quantity = { type: 'integer', minimum: 1, maximum: 8 };
  const summary = stringSchema(160, '本次变化的具体描述或人物命名');
  const arrangement = { type: 'string', enum: ['support', 'pile', 'lash', 'form'] };
  const layout = {
    type: 'array', minItems: 1,
    description: '相对造物固定锚点的完整实体布局；每个体素使用一份对应材料，必须包含零偏移锚点。modify-structure 提供修改后全布局，省略则保留原布局。墙顶效果来自真实位置与空腔，不来自名称或 cover 分数',
    items: {
      type: 'object', additionalProperties: false, required: ['offset', 'materialKey'],
      properties: {
        offset: { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'], properties: {
          x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        } },
        materialKey: handleSchema(MATERIAL_PALETTE.filter((item) => item.id !== 0 && item.phase === 'solid').map((item) => item.key), '本件原有组件或本次实际 consume 的固体材料'),
      },
    },
  };
  const variant = (kind: string, properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
    type: 'object',
    additionalProperties: false,
    required: ['kind', ...required],
    properties: { kind: { type: 'string', enum: [kind] }, ...properties },
  });
  const effects = [
    variant('knowledge', { summary: stringSchema(240, '人物亲历的新观察') }),
    variant('world-state', { targetHandle: target, stateKey: stringSchema(64), stateValue: stringSchema(160), summary }),
    ...(consumable.length ? [variant('consume', { targetHandle: handleSchema(consumable, '本人持物、地面物或体素；他人持物须先实际 transfer'), quantity })] : []),
    variant('produce', { materialKey: material, quantity, destination: { type: 'string', enum: ['inventory', 'ground'] } }),
    ...(relocatable.length && groundDestinations.length ? [variant('relocate', {
      targetHandle: handleSchema(relocatable, '本人持物或地面物，不能绕过他人持物的实际转移结算'),
      destinationHandle: handleSchema(groundDestinations, '本轮已展示的地面落点；真实支撑、占位和距离仍需结算'), quantity,
    })] : []),
    ...(transferable.length && transferDestinations.length ? [variant('transfer', {
      targetHandle: handleSchema(transferable, '实际拿取或交出的那一份持物/地面物'),
      destinationHandle: handleSchema(transferDestinations, '实际接收人或地面落点；本人为 self'),
      quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: '本人本次尝试转移的数量，真实可得数量与他人抵抗由共用转移执行器结算；不凭描述获得同意或成功' },
    })] : []),
    variant('replace-voxel', { targetHandle: target, materialKey: material }),
    variant('move-self', { targetHandle: target, withinDistance: { type: 'number', minimum: 0, description: '到达后与目标允许剩余的最大间隔，不是当前距离或要走的步数；省略时使用实际接触距离' } }, ['targetHandle']),
    ...(placementTargets.length ? [variant('assemble', {
      targetHandle: handleSchema(placementTargets, '本轮已展示的位置或表面，可独立于材料选择；实际空位、支撑和接触由执行器核验'), arrangement, summary, layout,
    }, ['targetHandle', 'arrangement', 'summary'])] : []),
    ...(structureTargets.length ? [variant('modify-structure', {
      targetHandle: handleSchema(structureTargets, '已有造物或其明确位置；优先使用已有w引用'), arrangement, summary, layout,
    }, ['targetHandle'])] : []),
    variant('bond-animal', { targetHandle: target, summary }),
    variant('body', {
      targetHandle: handleSchema([...new Set(['self', ...targets])], '本人或已点名人物的身体'),
      field: { type: 'string', enum: ['health', 'hydration', 'nutrition'] },
      delta: { type: 'integer', minimum: -25, maximum: 25 },
    }),
  ];
  const effectCompilation = {
      type: 'object',
      additionalProperties: false,
      required: ['effects', 'status', 'result'],
      properties: {
        completionReview,
        effects: {
          type: 'array',
          maxItems: 8,
          description: '先编译本次实际动作：移动用 move-self，持物拿取/交付用 transfer，搬放本人或地面物用 relocate，材料转化用 consume+produce，构造用 assemble；transfer 的实际结果由执行器结算，后续加工等待新持物事实；knowledge 不能替代这些变化',
          items: { oneOf: effects },
        },
        status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
        result: stringSchema(320, '仅描述本次实际发生、并与 effects 一致的结果'),
        feedback: {
          type: 'object',
          additionalProperties: false,
          required: ['correction', 'adjustment'],
          properties: {
            correction: stringSchema(240, '实际未满足或被试验否定的具体条件'),
            adjustment: stringSchema(240, '人物之后可以修正的条件或做法'),
          },
        },
      },
  };
  return {
    name: 'eland_world_resolution_v3',
    schema: {
      oneOf: [
        {
          type: 'object', additionalProperties: false, required: ['nativeOperation'],
          properties: { completionReview, nativeOperation: nativeOperationSchema(protocol, worldAction?.targetHandles, worldAction?.kind !== 'physical') },
        },
        effectCompilation,
      ],
    },
  };
}

/** Fresh creative choices compile one operation; they do not author plans or verdicts. */
export function buildWorldAttemptJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  const existing = buildWorldResolutionJsonSchema(protocol, {
    kind: 'physical', targetHandles: worldTargetHandles(protocol),
  }).schema;
  const effectBranch = (existing.oneOf as JsonSchema[]).find((branch) => record(branch.properties).effects);
  const effects = record(effectBranch?.properties).effects;
  if (!effects) throw new Error('当前物理编译缺少effects定义');
  const speechHandoff = { type: 'boolean', const: true,
    description: '本人本次已选意向包含当前要表达、询问或提议的意思，转交言语编译原句；不在此生成台词。已有declaration原话不再重复。可同时保留本人身体操作。' };
  return {
    name: 'eland_world_attempt_v1',
    schema: {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['nativeOperation'],
          properties: { nativeOperation: nativeOperationSchema(protocol, undefined, false), speechHandoff } },
        { type: 'object', additionalProperties: false, required: ['effects'], properties: { effects, speechHandoff } },
        { type: 'object', additionalProperties: false, required: ['uncompiled'], properties: {
          uncompiled: { type: 'object', additionalProperties: false, required: ['reason'], properties: {
            reason: stringSchema(480, '当前本人尝试尚不能绑定为可执行操作的具体原因；这是接口反馈，不是亲历结果或整个目标不可行的结论'),
          } },
          speechHandoff,
        } },
        { type: 'object', additionalProperties: false, required: ['speechHandoff'], properties: { speechHandoff } },
      ],
    },
  };
}

/** One world compiler owns the durable plan and its current executable attempt. */
export function buildWorldPlanJsonSchema(protocol: MentalActSchemaProtocol, attempt?: WorldPlanAttemptConstraint): ModelJsonSchema {
  const plan = modelPlanSchema(protocol, '#/$defs/plan');
  const variants = plan.oneOf as JsonSchema[];
  const selectedTargets = attempt?.hasExplicitFocus ? attempt.targetHandles : worldTargetHandles(protocol);
  const availableStepTargets = attempt?.hasExplicitFocus
    ? deriveWorldTargets(protocol.targetContext ?? protocol.requestContext, protocol.handles, selectedTargets).allowedHandles
    : selectedTargets;
  if (attempt?.hasExplicitFocus) {
    const currentStep = record(record(plan.properties).currentStep);
    record(record(currentStep.properties).targetHandles).items = handleSchema(
      availableStepTargets,
      '本人已选对象及其真实派生位置、本人可用材料；不能换成无关实体');
  }
  let resolution = buildWorldResolutionJsonSchema(protocol, {
    kind: 'physical', targetHandles: availableStepTargets,
  }).schema;
  if (attempt?.mode === 'observe') {
    const native = record((record(resolution).oneOf as JsonSchema[])[0]);
    const operation = record(record(native.properties).nativeOperation);
    operation.oneOf = (operation.oneOf as JsonSchema[]).filter((variant) =>
      ['observe', 'approach', 'walk-to'].includes(String((record(record(variant.properties).kind).enum as string[])[0])));
    resolution = native;
  }
  const controls = attempt?.mode === 'wait' || attempt?.mode === 'observe' || attempt?.hasExplicitFocus && !attempt.targetHandles.length
    ? variants.slice(1).filter((variant) => !(record(record(variant.properties).disposition).enum as string[]).includes('act'))
    : variants.slice(1);
  return {
    name: 'eland_world_plan_v1',
    schema: {
      $defs: { plan: { type: 'object', properties: plan.properties } },
      oneOf: [
        ...(attempt?.mode === 'wait' || attempt?.hasExplicitFocus && !attempt.targetHandles.length ? [] : [{
          type: 'object', additionalProperties: false, required: ['plan', 'resolution'],
          properties: { plan: variants[0], resolution },
        }]),
        {
          type: 'object', additionalProperties: false, required: ['plan'],
          properties: { plan: { oneOf: controls } },
        },
      ],
    },
  };
}

export function buildModelPlanBatchJsonSchema(
  protocols: readonly MentalActSchemaProtocol[],
): ModelJsonSchema {
  return batchSchema('eland_model_plans_v1', protocols, modelPlanSchema);
}

export function buildMentalActJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return {
    name: 'eland_mental_act_v2',
    schema: mentalActDecisionSchema(protocol),
  };
}

export function buildMentalActBatchJsonSchema(
  protocols: readonly MentalActSchemaProtocol[],
): ModelJsonSchema {
  const rowVariants = protocols.map((protocol, index): JsonSchema => ({
    type: 'object',
    additionalProperties: false,
    required: ['agentHandle', 'decision'],
    properties: {
      agentHandle: {
        type: 'string',
        enum: [`a${index + 1}`],
      },
      decision: {
        anyOf: [
          { type: 'null' },
          mentalActDecisionSchema(protocol),
        ],
      },
    },
  }));
  return {
    name: 'eland_monthly_agent_decisions_v1',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decisions'],
      properties: {
        decisions: {
          type: 'array',
          minItems: protocols.length,
          maxItems: protocols.length,
          items: { oneOf: rowVariants },
        },
      },
    },
  };
}
