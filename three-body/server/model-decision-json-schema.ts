import { SPEECH_PROPOSAL_KINDS } from '../src/game/eland/infrastructure-api';
import { MATERIAL_PALETTE } from '../src/game/eland/domain/material';
import type {
  DecisionProbeHandleMap,
  MentalActRequestContext,
} from '../src/game/eland/infrastructure-api';
import type { ModelJsonSchema } from './model-client';

interface MentalActSchemaProtocol {
  requestContext: MentalActRequestContext;
  handles: DecisionProbeHandleMap;
  characterAgendaProposal: boolean;
}

type JsonSchema = Record<string, unknown>;

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
  const visible = describedRefs(visibleContext.nearbyObjects);
  const voxels = describedRefs(visibleContext.surfaces);
  const described = held.length || visible.length || voxels.length;
  const allowedHeld = described ? held : protocol.handles.held.map((item) => item.handle);
  const allowedVisible = described ? visible : protocol.handles.visible.map((item) => item.handle);
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

function worldActionSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const targets = worldTargetHandles(protocol);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'targetHandles'],
    properties: {
      description: stringSchema(240, '人物此刻准备实施的具体动作；不写结果'),
      targetHandles: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(8, targets.length),
        uniqueItems: true,
        items: handleSchema(targets, '动作明确作用的当前对象'),
      },
      expectedResult: stringSchema(180, '人物主观希望或猜测的结果，不是世界事实'),
      ...(protocol.requestContext.knownMethods?.length ? {
        methodHandle: handleSchema(protocol.requestContext.knownMethods.map((method) => method.handle), '参考已学方法进行本次重新绑定与试验，不复制旧结果'),
      } : {}),
    },
  };
}

function planFeedbackSchema(protocol: MentalActSchemaProtocol): JsonSchema | undefined {
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  if (!memoryHandles.length) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['sourceMemoryHandles', 'correction', 'adjustment'],
    properties: {
      sourceMemoryHandles: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(3, memoryHandles.length),
        uniqueItems: true,
        items: handleSchema(memoryHandles, '本次修正依据的亲历失败'),
      },
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

function speechIntentSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const people = protocol.handles.visible.filter((item) => item.kind === 'person').map((item) => item.handle);
  const references = protocol.handles.speechReferences ?? [];
  const referenceKinds = {
    accept: 'agreement', reject: 'agreement', 'end-agreement': 'agreement',
    'revoke-permission': 'permission', 'leave-collective': 'collective', 'share-knowledge': 'knowledge',
  };
  const variant = (kind: string, properties: Record<string, JsonSchema> = {}): JsonSchema => ({
    type: 'object', additionalProperties: false, required: ['kind', ...Object.keys(properties)],
    properties: { kind: { type: 'string', enum: [kind] }, ...properties },
  });
  return {
    description: '人物自己说明这句话的实际含义；普通表达不建立协议，Plan 不能增加本人未选择的承诺',
    oneOf: [
      ...['expression', 'prediction', 'request-information'].map((kind) => variant(kind)),
      ...(people.length ? [variant('proposal', {
        proposalKind: { type: 'string', enum: [...SPEECH_PROPOSAL_KINDS] },
        counterpartHandles: { type: 'array', minItems: 1, uniqueItems: true, items: handleSchema(people, '本人提议的可见对方') },
        commitment: stringSchema(240, '本人具体提出的事项；只代表自己的提议，不表示对方同意'),
      })] : []),
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
  return {
    type: 'object',
    additionalProperties: false,
    required: ['utterance', 'delivery', 'goal', 'orientation', 'horizon', 'speechIntent'],
    properties: {
      utterance: stringSchema(180, '人物此刻形成并向外传播的第一人称原话'),
      delivery: {
        type: 'string',
        enum: ['whisper', 'normal', 'call'],
        description: '语言波强度；不选择听者',
      },
      speechIntent: speechIntentSchema(protocol),
      goal: stringSchema(240, '人物此刻真正想达到、维持或弄清的事情'),
      orientation: {
        type: 'string',
        enum: ['social', 'inquiry', 'survival', 'construction', 'acquisition', 'exploration', 'rest'],
        description: '人物在看到行动入口前形成的主观方向类别',
      },
      horizon: {
        type: 'string',
        enum: ['momentary', 'ongoing'],
        description: '这一目标是一时念头，还是本人希望跨行动继续记住的方向',
      },
      ...(memoryHandles.length ? {
        evidenceMemoryHandles: {
          type: 'array',
          uniqueItems: true,
          items: handleSchema(memoryHandles, 'mind.recentEvidence 或 learnedConclusions 中本轮可引用的记忆句柄'),
        },
      } : {}),
      ...(relationshipAppraisal ? { relationshipAppraisal } : {}),
    },
  };
}

function modelPlanSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const stepHandles = protocol.requestContext.availableSteps.map((step) => step.handle);
  const continuationHandles = protocol.requestContext.continuations.map((step) => step.handle);
  const suspendedIntentHandles = (protocol.handles.suspendedIntents ?? []).map((intent) => intent.handle);
  const resumableIntentHandles = (protocol.handles.suspendedIntents ?? [])
    .filter((intent) => intent.resumable)
    .map((intent) => intent.handle);
  const groundingHandles = protocol.handles.groundingFacts.map((item) => item.handle);
  const experiment = experimentSchema(protocol);
  const feedback = planFeedbackSchema(protocol);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['steps', 'disposition', 'completion'],
    properties: {
      disposition: {
        type: 'string',
        enum: ['act', 'continue', 'pause', 'abandon', 'stay'],
        description: '人物选择执行、继续、搁置、放弃或停留；非 act 不携带执行入口',
      },
      steps: {
        type: 'array',
        minItems: 1,
        items: stringSchema(240, '围绕冻结意图形成的一个领域规划步骤；不要求固定步数'),
      },
      completion: planCompletionSchema(protocol),
      ...(stepHandles.length ? {
        firstStepHandle: handleSchema(
          stepHandles,
          'Execution 当前能够编译的计划入口',
        ),
      } : {}),
      ...(continuationHandles.length ? {
        continuationHandle: handleSchema(continuationHandles, '与计划入口配套的现有后续入口'),
      } : {}),
      ...(resumableIntentHandles.length ? {
        resumeIntentHandle: handleSchema(
          resumableIntentHandles,
          'current.suspendedWork 中人物决定恢复的旧事务；它本身就是本轮 act 入口',
        ),
      } : {}),
      ...(suspendedIntentHandles.length ? {
        abandonIntentHandle: handleSchema(
          suspendedIntentHandles,
          'current.suspendedWork 中人物明确决定不再保留的旧事务；只与 disposition=abandon 同用',
        ),
      } : {}),
      ...(groundingHandles.length ? {
        groundingFactHandles: {
          type: 'array',
          uniqueItems: true,
          items: handleSchema(groundingHandles, '当前交流规划允许引用的事实句柄'),
        },
      } : {}),
      ...(experiment ? { experiment } : {}),
      worldAction: worldActionSchema(protocol),
      ...(feedback ? { feedback } : {}),
    },
  };
}

function planCompletionSchema(protocol: MentalActSchemaProtocol): JsonSchema {
  const targets = worldTargetHandles(protocol);
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
  const variant = (kind: string, properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
    type: 'object', additionalProperties: false, required: ['kind', ...required],
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
  schemaFor: (protocol: MentalActSchemaProtocol) => JsonSchema,
): ModelJsonSchema {
  const rowVariants = protocols.map((protocol, index): JsonSchema => ({
    type: 'object',
    additionalProperties: false,
    required: ['agentHandle', 'value'],
    properties: {
      agentHandle: { type: 'string', enum: [`a${index + 1}`] },
      value: { anyOf: [{ type: 'null' }, schemaFor(protocol)] },
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
  return { name: 'eland_mind_intention_v1', schema: mindIntentionSchema(protocol) };
}

export function buildModelPlanJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return { name: 'eland_model_plan_v1', schema: modelPlanSchema(protocol) };
}

/** Typed mutation vocabulary teaches the resolver how to materialize unfamiliar ideas.
 * Object identity is restricted to the actor's own request, never a generated id.
 */
export function buildWorldResolutionJsonSchema(
  protocol: MentalActSchemaProtocol,
  worldAction?: { targetHandles: string[] },
): ModelJsonSchema {
  const targets = worldAction?.targetHandles ?? worldTargetHandles(protocol);
  const target = handleSchema(targets, '人物已选中、由世界解析的真实对象');
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
    variant('consume', { targetHandle: target, quantity }),
    variant('produce', { materialKey: material, quantity, destination: { type: 'string', enum: ['inventory', 'ground'] } }),
    variant('relocate', { targetHandle: target, destinationHandle: target, quantity }),
    variant('replace-voxel', { targetHandle: target, materialKey: material }),
    variant('move-self', { targetHandle: target, withinDistance: { type: 'number', minimum: 0, description: '需要靠近至多远；与本次完成条件一致，不填时使用实际接触距离' } }, ['targetHandle']),
    variant('assemble', { targetHandle: target, arrangement, summary, layout }, ['targetHandle', 'arrangement', 'summary']),
    variant('modify-structure', { targetHandle: target, arrangement, summary, layout }, ['targetHandle']),
    variant('bond-animal', { targetHandle: target, summary }),
    variant('body', {
      targetHandle: handleSchema([...new Set(['self', ...targets])], '本人或已点名人物的身体'),
      field: { type: 'string', enum: ['health', 'hydration', 'nutrition'] },
      delta: { type: 'integer', minimum: -25, maximum: 25 },
    }),
  ];
  return {
    name: 'eland_world_resolution_v2',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['effects', 'status', 'result'],
      properties: {
        effects: {
          type: 'array',
          maxItems: 8,
          description: '先编译本次实际动作：移动用 move-self，物资转移用 consume+produce 或 relocate，构造用 assemble；knowledge 不能替代上述实际变化',
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
