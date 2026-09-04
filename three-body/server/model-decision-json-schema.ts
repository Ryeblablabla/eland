import type {
  DecisionProbeHandleMap,
} from '../src/game/eland/application/model-decision/capability-handles';
import type {
  MentalActRequestContext,
} from '../src/game/eland/application/model-decision/mental-act-context';
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

function mentalActProperties(protocol: MentalActSchemaProtocol): Record<string, JsonSchema> {
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  return {
    utterance: stringSchema(180, '人物本次决定形成的唯一第一人称语言波；三体人没有与说话分离的私密思考'),
    delivery: {
      type: 'string',
      enum: ['whisper', 'normal', 'call'],
      description: 'whisper 低强度、normal 正常、call 高强度；只改变传播，不指定听者',
    },
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
    required: ['utterance', 'delivery', 'goal', 'orientation', 'horizon'],
    properties: {
      utterance: stringSchema(180, '人物此刻形成并向外传播的第一人称原话'),
      delivery: {
        type: 'string',
        enum: ['whisper', 'normal', 'call'],
        description: '语言波强度；不选择听者',
      },
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
    required: ['steps', 'disposition'],
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

export function buildWorldResolutionJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return {
    name: 'eland_world_resolution_v1',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'result', 'effects'],
      properties: {
        status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
        result: stringSchema(320, '仅描述这次动作在世界中实际发生的结果'),
        effects: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            required: ['kind'],
            additionalProperties: true,
            properties: { kind: stringSchema(32) },
          },
        },
        feedback: {
          type: 'object',
          additionalProperties: false,
          required: ['correction', 'adjustment'],
          properties: {
            correction: stringSchema(240),
            adjustment: stringSchema(240),
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
