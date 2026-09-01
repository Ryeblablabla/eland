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
  const held = protocol.handles.held.map((item) => item.handle);
  const visible = protocol.handles.visible.map((item) => item.handle);
  const voxels = protocol.handles.voxels.map((item) => item.handle);
  const variants: JsonSchema[] = [];
  const observable = [...held, ...visible, ...voxels];
  if (observable.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['observe'] },
        targetHandle: handleSchema(observable, 'possibleExperiments 中当前可观察的句柄'),
      },
    });
  }
  if (held.length >= 2) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'stackHandles'],
      properties: {
        kind: { type: 'string', enum: ['combine'] },
        stackHandles: {
          type: 'array',
          minItems: 2,
          maxItems: Math.min(3, held.length),
          uniqueItems: true,
          items: handleSchema(held, '本人当前持有的物品句柄'),
        },
      },
    });
  }
  if (held.length && voxels.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'inputHandle', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['expose'] },
        inputHandle: handleSchema(held, '本人当前持有的输入物句柄'),
        targetHandle: handleSchema(voxels, '当前可见体素句柄'),
      },
    });
  }
  if (held.length >= 2 && voxels.length) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'toolHandle', 'inputHandle', 'targetHandle'],
      properties: {
        kind: { type: 'string', enum: ['exert'] },
        toolHandle: handleSchema(held, '本人当前持有的工具句柄'),
        inputHandle: handleSchema(held, '本人当前持有的输入物句柄'),
        targetHandle: handleSchema(voxels, '当前可见体素句柄'),
      },
    });
  }
  return variants.length ? { oneOf: variants } : undefined;
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

function mentalActProperties(protocol: MentalActSchemaProtocol): Record<string, JsonSchema> {
  const memoryHandles = protocol.handles.memories.map((item) => item.handle);
  return {
    thoughtLine: stringSchema(180, '人物此刻形成的第一人称思考原话；它会像语言一样向周围透明传播'),
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
        items: handleSchema(memoryHandles, 'mind.markdown 中本轮可引用的记忆句柄'),
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
    allowUtterance?: boolean;
    requireUtterance?: boolean;
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
      'thoughtLine',
      'goal',
      'strategy',
      'assumptions',
      ...(options.requireStep ? ['firstStepHandle'] : []),
      ...(options.requireUtterance ? ['utterance'] : []),
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
      ...(options.allowUtterance ? {
        utterance: stringSchema(180, '选择 talk 行为时额外主动说出的核心原话'),
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
        allowUtterance: true,
        requireUtterance: true,
        allowGrounding: true,
        allowConcern: true,
      })] : []),
      mentalActObjectSchema(protocol, ['continue', 'wait']),
    ],
  };
}

export function buildMentalActJsonSchema(protocol: MentalActSchemaProtocol): ModelJsonSchema {
  return {
    name: 'eland_mental_act_v1',
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
