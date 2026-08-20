import fs from 'node:fs';
import path from 'node:path';

import { loadFirstServerEnvValue, loadServerEnvValue } from './env';

export const MODEL_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'ollama-chat'] as const;
export const MODEL_PURPOSES = ['decision', 'interaction', 'narrative', 'naming', 'strategy'] as const;
export const EVOLUTION_MODES = ['local', 'model'] as const;

export type ModelProtocol = typeof MODEL_PROTOCOLS[number];
export type ModelPurpose = typeof MODEL_PURPOSES[number];
export type EvolutionMode = typeof EVOLUTION_MODES[number];
export type ModelAuth = 'bearer' | 'x-api-key' | 'none';
export type StructuredOutputMode = 'prompt' | 'native-json';
export type ModelThinking = boolean | 'low' | 'medium' | 'high' | 'max';

export interface CivilizationStrategyDefinition {
  endpoint?: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

interface ModelEndpointDefinition {
  protocol: ModelProtocol;
  url: string;
  model: string;
  apiKeyEnv?: string;
  auth?: ModelAuth;
  headers?: Record<string, string>;
  timeoutMs?: number;
  temperature?: number;
  structuredOutput?: StructuredOutputMode;
  thinking?: ModelThinking;
}

interface ModelConfigFile {
  schemaVersion: 1;
  evolutionMode?: EvolutionMode;
  summaryMode?: EvolutionMode;
  endpoints: Record<string, ModelEndpointDefinition>;
  routes?: Partial<Record<ModelPurpose, string>>;
  strategies?: Record<string, CivilizationStrategyDefinition>;
}

export interface ModelSettingsEndpoint {
  id: string;
  protocol: ModelProtocol;
  url: string;
  model: string;
  configured: boolean;
  issue?: string;
}

export interface ModelSettingsSnapshot {
  source: 'config-file' | 'legacy-kimi';
  editable: boolean;
  evolutionMode: EvolutionMode;
  summaryMode: EvolutionMode;
  configFile?: string;
  purposes: readonly ModelPurpose[];
  endpoints: ModelSettingsEndpoint[];
  routes: Record<ModelPurpose, string>;
}

export interface ResolvedModelEndpoint {
  id: string;
  protocol: ModelProtocol;
  url: string;
  model: string;
  auth: ModelAuth;
  apiKeyEnv?: string;
  apiKey: string;
  headers: Record<string, string>;
  timeoutMs: number;
  temperature?: number;
  structuredOutput: StructuredOutputMode;
  thinking?: ModelThinking;
  source: 'config-file' | 'legacy-kimi';
}

export interface ModelEndpointStatus {
  configured: boolean;
  endpointId?: string;
  protocol?: ModelProtocol;
  model?: string;
  issue?: string;
}

const DEFAULT_KIMI_URL = 'https://api.kimi.com/coding/v1/chat/completions';
const DEFAULT_KIMI_MODEL = 'kimi-for-coding';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`);
  return value;
}

function optionalThinking(value: unknown, label: string): ModelThinking | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['low', 'medium', 'high', 'max'].includes(value)) return value as ModelThinking;
  throw new Error(`${label} 必须是布尔值或 low / medium / high / max`);
}

function parseEndpoint(id: string, input: unknown): ModelEndpointDefinition {
  const raw = object(input, `模型端点 ${id}`);
  const protocol = nonEmptyString(raw.protocol, `模型端点 ${id}.protocol`);
  if (!MODEL_PROTOCOLS.includes(protocol as ModelProtocol)) throw new Error(`模型端点 ${id} 使用了未知协议 ${protocol}`);
  const url = nonEmptyString(raw.url, `模型端点 ${id}.url`);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(`模型端点 ${id}.url 必须是 http(s) 地址`);
  }
  const auth = raw.auth === undefined ? undefined : nonEmptyString(raw.auth, `模型端点 ${id}.auth`);
  if (auth && !['bearer', 'x-api-key', 'none'].includes(auth)) throw new Error(`模型端点 ${id} 使用了未知认证方式 ${auth}`);
  const structuredOutput = raw.structuredOutput === undefined
    ? undefined
    : nonEmptyString(raw.structuredOutput, `模型端点 ${id}.structuredOutput`);
  if (structuredOutput && !['prompt', 'native-json'].includes(structuredOutput)) {
    throw new Error(`模型端点 ${id} 使用了未知结构化输出方式 ${structuredOutput}`);
  }
  const headers = raw.headers === undefined ? {} : object(raw.headers, `模型端点 ${id}.headers`);
  const normalizedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) normalizedHeaders[name] = nonEmptyString(value, `模型端点 ${id}.headers.${name}`);
  return {
    protocol: protocol as ModelProtocol,
    url,
    model: nonEmptyString(raw.model, `模型端点 ${id}.model`),
    ...(raw.apiKeyEnv === undefined ? {} : { apiKeyEnv: nonEmptyString(raw.apiKeyEnv, `模型端点 ${id}.apiKeyEnv`) }),
    ...(auth ? { auth: auth as ModelAuth } : {}),
    headers: normalizedHeaders,
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: optionalNumber(raw.timeoutMs, `模型端点 ${id}.timeoutMs`) }),
    ...(raw.temperature === undefined ? {} : { temperature: optionalNumber(raw.temperature, `模型端点 ${id}.temperature`) }),
    ...(structuredOutput ? { structuredOutput: structuredOutput as StructuredOutputMode } : {}),
    ...(raw.thinking === undefined ? {} : { thinking: optionalThinking(raw.thinking, `模型端点 ${id}.thinking`) }),
  };
}

function parseStrategy(id: string, input: unknown): CivilizationStrategyDefinition {
  const raw = object(input, `文明策略 ${id}`);
  return {
    ...(raw.endpoint === undefined ? {} : { endpoint: nonEmptyString(raw.endpoint, `文明策略 ${id}.endpoint`) }),
    ...(raw.systemPrompt === undefined ? {} : { systemPrompt: nonEmptyString(raw.systemPrompt, `文明策略 ${id}.systemPrompt`) }),
    ...(raw.temperature === undefined ? {} : { temperature: optionalNumber(raw.temperature, `文明策略 ${id}.temperature`) }),
    ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: optionalNumber(raw.maxOutputTokens, `文明策略 ${id}.maxOutputTokens`) }),
  };
}

function loadConfigFile(): ModelConfigFile | null {
  const filePath = modelConfigPath();
  if (!filePath) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`无法读取模型配置 ${filePath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = object(parsed, '模型配置');
  if (raw.schemaVersion !== 1) throw new Error('模型配置 schemaVersion 当前只支持 1');
  const evolutionMode = raw.evolutionMode === undefined ? undefined : nonEmptyString(raw.evolutionMode, '模型配置 evolutionMode');
  if (evolutionMode && !EVOLUTION_MODES.includes(evolutionMode as EvolutionMode)) {
    throw new Error('模型配置 evolutionMode 只能是 local 或 model');
  }
  const summaryMode = raw.summaryMode === undefined ? undefined : nonEmptyString(raw.summaryMode, '模型配置 summaryMode');
  if (summaryMode && !EVOLUTION_MODES.includes(summaryMode as EvolutionMode)) {
    throw new Error('模型配置 summaryMode 只能是 local 或 model');
  }
  const rawEndpoints = object(raw.endpoints, '模型配置 endpoints');
  const endpoints = Object.fromEntries(Object.entries(rawEndpoints).map(([id, endpoint]) => [id, parseEndpoint(id, endpoint)]));
  const rawRoutes = raw.routes === undefined ? {} : object(raw.routes, '模型配置 routes');
  const routes: Partial<Record<ModelPurpose, string>> = {};
  for (const purpose of MODEL_PURPOSES) {
    if (rawRoutes[purpose] !== undefined) routes[purpose] = nonEmptyString(rawRoutes[purpose], `模型配置 routes.${purpose}`);
  }
  for (const [purpose, endpointId] of Object.entries(routes)) {
    if (!endpointId || !endpoints[endpointId]) throw new Error(`模型用途 ${purpose} 引用了不存在的端点 ${endpointId}`);
  }
  const rawStrategies = raw.strategies === undefined ? {} : object(raw.strategies, '模型配置 strategies');
  const strategies = Object.fromEntries(Object.entries(rawStrategies).map(([id, strategy]) => [id, parseStrategy(id, strategy)]));
  for (const [id, strategy] of Object.entries(strategies)) {
    if (strategy.endpoint && !endpoints[strategy.endpoint]) throw new Error(`文明策略 ${id} 引用了不存在的端点 ${strategy.endpoint}`);
  }
  return {
    schemaVersion: 1,
    ...(evolutionMode ? { evolutionMode: evolutionMode as EvolutionMode } : {}),
    ...(summaryMode ? { summaryMode: summaryMode as EvolutionMode } : {}),
    endpoints,
    routes,
    strategies,
  };
}

function modelConfigPath(): string | null {
  const configuredPath = loadServerEnvValue('THREEBODY_MODEL_CONFIG');
  return configuredPath ? path.resolve(configuredPath) : null;
}

function defaultAuth(protocol: ModelProtocol): ModelAuth {
  if (protocol === 'ollama-chat') return 'none';
  return protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer';
}

function defaultApiKeyEnv(protocol: ModelProtocol): string {
  return protocol === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

function resolveDefinition(id: string, definition: ModelEndpointDefinition): ResolvedModelEndpoint {
  const auth = definition.auth ?? defaultAuth(definition.protocol);
  const apiKeyEnv = auth === 'none' ? definition.apiKeyEnv : definition.apiKeyEnv ?? defaultApiKeyEnv(definition.protocol);
  const apiKey = apiKeyEnv ? loadServerEnvValue(apiKeyEnv) : '';
  return {
    id,
    protocol: definition.protocol,
    url: definition.url,
    model: definition.model,
    auth,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    apiKey,
    headers: { ...definition.headers },
    timeoutMs: Math.max(1_000, Math.min(300_000, definition.timeoutMs ?? 90_000)),
    ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
    structuredOutput: definition.structuredOutput ?? 'prompt',
    ...(definition.thinking === undefined ? {} : { thinking: definition.thinking }),
    source: 'config-file',
  };
}

function legacyKimiEndpoint(): ResolvedModelEndpoint {
  return {
    id: 'kimi',
    protocol: 'openai-chat',
    url: loadServerEnvValue('KIMI_API_URL') || DEFAULT_KIMI_URL,
    model: loadServerEnvValue('KIMI_MODEL') || DEFAULT_KIMI_MODEL,
    auth: 'bearer',
    apiKeyEnv: 'KIMI_API_KEY',
    apiKey: loadFirstServerEnvValue(['KIMI_API_KEY', 'MOONSHOT_API_KEY']),
    headers: {},
    timeoutMs: 90_000,
    structuredOutput: 'native-json',
    source: 'legacy-kimi',
  };
}

export function resolveModelEndpoint(purpose: ModelPurpose, requestedEndpoint?: string): ResolvedModelEndpoint {
  const config = loadConfigFile();
  if (!config) {
    const requested = requestedEndpoint?.trim();
    if (requested && requested !== 'default' && requested !== 'kimi') throw new Error(`未配置模型端点 ${requested}`);
    return legacyKimiEndpoint();
  }
  const endpointId = requestedEndpoint?.trim()
    || config.routes?.[purpose]
    || (purpose === 'interaction' || purpose === 'naming' ? config.routes?.decision : undefined);
  if (!endpointId) throw new Error(`模型配置没有为 ${purpose} 指定端点`);
  const definition = config.endpoints[endpointId];
  if (!definition) throw new Error(`模型配置不存在端点 ${endpointId}`);
  return resolveDefinition(endpointId, definition);
}

export function modelEndpointStatus(purpose: ModelPurpose, requestedEndpoint?: string): ModelEndpointStatus {
  try {
    const endpoint = resolveModelEndpoint(purpose, requestedEndpoint);
    const configured = endpoint.auth === 'none' || Boolean(endpoint.apiKey);
    return {
      configured,
      endpointId: endpoint.id,
      protocol: endpoint.protocol,
      model: endpoint.model,
      ...(!configured ? { issue: `缺少 ${endpoint.apiKeyEnv ?? 'API Key'}` } : {}),
    };
  } catch (error) {
    return { configured: false, issue: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 只有配置文件显式声明了用途路由，实时模拟才主动调用模型。
 * 旧 Kimi 环境变量继续服务兼容 API，但不会让已有文明在升级后突然开始等待模型。
 */
export function hasExplicitModelRoute(purpose: ModelPurpose): boolean {
  return Boolean(loadConfigFile()?.routes?.[purpose]);
}

/**
 * 旧配置只要显式声明过 decision 路由，就保持升级前的实时模型行为。
 * 新配置由设置页写入明确模式；没有配置文件时始终使用本地演进。
 */
export function readEvolutionMode(): EvolutionMode {
  const config = loadConfigFile();
  if (!config) return 'local';
  return config.evolutionMode ?? (config.routes?.decision ? 'model' : 'local');
}

/** 当前月的玩家纪事是否交给模型压缩；本地模式直接保留规则投影。 */
export function readSummaryMode(): EvolutionMode {
  const config = loadConfigFile();
  if (!config) return legacyKimiEndpoint().apiKey ? 'model' : 'local';
  return config.summaryMode ?? (config.routes?.narrative ? 'model' : 'local');
}

export function loadCivilizationStrategy(id: string): CivilizationStrategyDefinition | null {
  const config = loadConfigFile();
  return config?.strategies?.[id] ?? null;
}

export function resolveCivilizationStrategyEndpoint(id: string): ResolvedModelEndpoint {
  const config = loadConfigFile();
  const strategy = config?.strategies?.[id];
  if (!strategy) throw new Error(`模型配置不存在文明策略 ${id}`);
  return resolveModelEndpoint('strategy', strategy.endpoint);
}

function endpointSetting(id: string, definition: ModelEndpointDefinition): ModelSettingsEndpoint {
  const endpoint = resolveDefinition(id, definition);
  const configured = endpoint.auth === 'none' || Boolean(endpoint.apiKey);
  return {
    id,
    protocol: endpoint.protocol,
    url: endpoint.url,
    model: endpoint.model,
    configured,
    ...(!configured ? { issue: `缺少 ${endpoint.apiKeyEnv ?? 'API Key'}` } : {}),
  };
}

/** 返回给本地设置页的安全视图：只包含环境变量状态，不返回密钥或请求头。 */
export function readModelSettings(): ModelSettingsSnapshot {
  const config = loadConfigFile();
  if (!config) {
    const endpoint = legacyKimiEndpoint();
    const configured = Boolean(endpoint.apiKey);
    return {
      source: 'legacy-kimi',
      editable: false,
      evolutionMode: 'local',
      summaryMode: configured ? 'model' : 'local',
      purposes: MODEL_PURPOSES,
      endpoints: [{
        id: endpoint.id,
        protocol: endpoint.protocol,
        url: endpoint.url,
        model: endpoint.model,
        configured,
        ...(!configured ? { issue: `缺少 ${endpoint.apiKeyEnv ?? 'API Key'}` } : {}),
      }],
      routes: { decision: endpoint.id, interaction: endpoint.id, narrative: endpoint.id, naming: endpoint.id, strategy: endpoint.id },
    };
  }

  const endpointIds = Object.keys(config.endpoints);
  const fallbackEndpoint = endpointIds[0] ?? '';
  const routes = Object.fromEntries(MODEL_PURPOSES.map((purpose) => [
    purpose,
    config.routes?.[purpose]
      ?? (purpose === 'interaction' || purpose === 'naming' ? config.routes?.decision : undefined)
      ?? fallbackEndpoint,
  ])) as Record<ModelPurpose, string>;
  const filePath = modelConfigPath();
  return {
    source: 'config-file',
    editable: true,
    evolutionMode: config.evolutionMode ?? (config.routes?.decision ? 'model' : 'local'),
    summaryMode: config.summaryMode ?? (config.routes?.narrative ? 'model' : 'local'),
    ...(filePath ? { configFile: path.relative(process.cwd(), filePath) || path.basename(filePath) } : {}),
    purposes: MODEL_PURPOSES,
    endpoints: Object.entries(config.endpoints).map(([id, definition]) => endpointSetting(id, definition)),
    routes,
  };
}

/** 更新用途路由与实时模式，保留端点、策略和用户在配置文件中的其他字段。 */
export function updateModelSettings(
  routes: Record<ModelPurpose, string>,
  evolutionMode: EvolutionMode = readEvolutionMode(),
  summaryMode: EvolutionMode = readSummaryMode(),
): ModelSettingsSnapshot {
  const filePath = modelConfigPath();
  if (!filePath) throw new Error('当前使用旧 Kimi 环境配置；请先设置 THREEBODY_MODEL_CONFIG');
  const config = loadConfigFile();
  if (!config) throw new Error('模型配置不存在');
  for (const purpose of MODEL_PURPOSES) {
    const endpointId = routes[purpose]?.trim();
    if (!endpointId || !config.endpoints[endpointId]) {
      throw new Error(`模型用途 ${purpose} 引用了不存在的端点 ${endpointId || '（空）'}`);
    }
  }
  if (!EVOLUTION_MODES.includes(evolutionMode)) throw new Error('演进模式只能是 local 或 model');
  if (!EVOLUTION_MODES.includes(summaryMode)) throw new Error('总结模式只能是 local 或 model');
  if (evolutionMode === 'model') {
    const status = modelEndpointStatus('decision', routes.decision);
    if (!status.configured) throw new Error(status.issue ?? '关键决策模型端点尚未配置');
  }
  if (summaryMode === 'model') {
    const status = modelEndpointStatus('narrative', routes.narrative);
    if (!status.configured) throw new Error(status.issue ?? '叙事总结模型端点尚未配置');
  }

  const raw = object(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown, '模型配置');
  raw.evolutionMode = evolutionMode;
  raw.summaryMode = summaryMode;
  raw.routes = Object.fromEntries(MODEL_PURPOSES.map((purpose) => [purpose, routes[purpose].trim()]));
  fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return readModelSettings();
}
