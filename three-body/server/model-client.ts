import type { ModelProtocol, ResolvedModelEndpoint } from './model-config';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelTextRequest {
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number;
  jsonObject?: boolean;
  timeoutMs?: number;
}

export interface ModelTextResponse {
  text: string;
  model: string;
  endpointId: string;
  protocol: ModelProtocol;
  usage: { inputTokens: number; outputTokens: number };
}

export type ModelRequestFailureCode = 'missing-key' | 'timeout' | 'provider-error' | 'invalid-response';

export class ModelRequestError extends Error {
  constructor(readonly code: ModelRequestFailureCode, message: string, readonly retriable = true) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const raw = block as Record<string, unknown>;
    return typeof raw.text === 'string' ? raw.text : '';
  }).join('').trim();
}

function requestHeaders(endpoint: ResolvedModelEndpoint): Headers {
  if (endpoint.auth !== 'none' && !endpoint.apiKey) {
    throw new ModelRequestError('missing-key', `模型端点 ${endpoint.id} 缺少 ${endpoint.apiKeyEnv ?? 'API Key'}`);
  }
  const headers = new Headers({ 'content-type': 'application/json', ...endpoint.headers });
  if (endpoint.auth === 'bearer') headers.set('authorization', `Bearer ${endpoint.apiKey}`);
  if (endpoint.auth === 'x-api-key') headers.set('x-api-key', endpoint.apiKey);
  if (endpoint.protocol === 'anthropic-messages' && !headers.has('anthropic-version')) {
    headers.set('anthropic-version', '2023-06-01');
  }
  return headers;
}

function isOfficialDeepSeekApiUrl(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com');
}

function openAiChatThinking(endpoint: ResolvedModelEndpoint): Record<string, unknown> {
  if (!isOfficialDeepSeekApiUrl(endpoint.url) || endpoint.thinking === undefined) return {};
  if (endpoint.thinking === false) return { thinking: { type: 'disabled' } };
  if (endpoint.thinking === true) return { thinking: { type: 'enabled' } };
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: endpoint.thinking,
  };
}

function requestBody(endpoint: ResolvedModelEndpoint, request: ModelTextRequest): Record<string, unknown> {
  const common = {
    model: endpoint.model,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
  if (endpoint.protocol === 'openai-chat') {
    return {
      ...common,
      max_tokens: request.maxOutputTokens,
      messages: request.messages,
      ...openAiChatThinking(endpoint),
      ...(request.jsonObject && endpoint.structuredOutput === 'native-json'
        ? { response_format: { type: 'json_object' } }
        : {}),
    };
  }
  if (endpoint.protocol === 'openai-responses') {
    return {
      ...common,
      max_output_tokens: request.maxOutputTokens,
      input: request.messages,
      ...(request.jsonObject && endpoint.structuredOutput === 'native-json'
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: 'eland_json_object',
                strict: false,
                schema: { type: 'object', additionalProperties: true },
              },
            },
          }
        : {}),
    };
  }
  if (endpoint.protocol === 'ollama-chat') {
    return {
      model: endpoint.model,
      messages: request.messages,
      stream: false,
      think: endpoint.thinking ?? false,
      ...(request.jsonObject && endpoint.structuredOutput === 'native-json' ? { format: 'json' } : {}),
      options: {
        num_predict: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
    };
  }
  const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  return {
    ...common,
    max_tokens: request.maxOutputTokens,
    ...(system ? { system } : {}),
    messages: request.messages.filter((message) => message.role !== 'system'),
  };
}

function parseOpenAiChat(body: Record<string, unknown>, endpoint: ResolvedModelEndpoint): ModelTextResponse {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
  const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {};
  const text = textFromContent(message.content);
  if (!text) {
    const reasoningLength = typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0;
    throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 没有返回最终文本（finish_reason=${String(choice.finish_reason ?? 'unknown')}，reasoning_length=${reasoningLength}）`);
  }
  const usage = body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : {};
  return {
    text,
    model: typeof body.model === 'string' ? body.model : endpoint.model,
    endpointId: endpoint.id,
    protocol: endpoint.protocol,
    usage: { inputTokens: positiveInteger(usage.prompt_tokens), outputTokens: positiveInteger(usage.completion_tokens) },
  };
}

function parseOpenAiResponse(body: Record<string, unknown>, endpoint: ResolvedModelEndpoint): ModelTextResponse {
  let text = typeof body.output_text === 'string' ? body.output_text.trim() : '';
  if (!text && Array.isArray(body.output)) {
    text = body.output.map((item) => {
      if (!item || typeof item !== 'object') return '';
      const content = (item as Record<string, unknown>).content;
      return textFromContent(content);
    }).join('').trim();
  }
  if (!text) throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 没有返回 Responses 文本`);
  const usage = body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : {};
  return {
    text,
    model: typeof body.model === 'string' ? body.model : endpoint.model,
    endpointId: endpoint.id,
    protocol: endpoint.protocol,
    usage: { inputTokens: positiveInteger(usage.input_tokens), outputTokens: positiveInteger(usage.output_tokens) },
  };
}

function parseAnthropicMessage(body: Record<string, unknown>, endpoint: ResolvedModelEndpoint): ModelTextResponse {
  const text = textFromContent(body.content);
  if (!text) throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 没有返回 Anthropic Messages 文本`);
  const usage = body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : {};
  return {
    text,
    model: typeof body.model === 'string' ? body.model : endpoint.model,
    endpointId: endpoint.id,
    protocol: endpoint.protocol,
    usage: { inputTokens: positiveInteger(usage.input_tokens), outputTokens: positiveInteger(usage.output_tokens) },
  };
}

function parseOllamaChat(body: Record<string, unknown>, endpoint: ResolvedModelEndpoint): ModelTextResponse {
  const message = body.message && typeof body.message === 'object' ? body.message as Record<string, unknown> : {};
  const text = textFromContent(message.content);
  if (!text) throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 没有返回 Ollama Chat 文本`);
  return {
    text,
    model: typeof body.model === 'string' ? body.model : endpoint.model,
    endpointId: endpoint.id,
    protocol: endpoint.protocol,
    usage: {
      inputTokens: positiveInteger(body.prompt_eval_count),
      outputTokens: positiveInteger(body.eval_count),
    },
  };
}

export async function requestModelText(endpoint: ResolvedModelEndpoint, request: ModelTextRequest): Promise<ModelTextResponse> {
  const timeoutMs = Math.max(1_000, Math.min(300_000, request.timeoutMs ?? endpoint.timeoutMs));
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: requestHeaders(endpoint),
      body: JSON.stringify(requestBody(endpoint, request)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = `${error instanceof Error ? error.name : ''} ${message}`.toLowerCase();
    const timeout = normalized.includes('timeout') || normalized.includes('aborted');
    throw new ModelRequestError(timeout ? 'timeout' : 'provider-error', `模型端点 ${endpoint.id} 请求失败：${message}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new ModelRequestError('provider-error', `模型端点 ${endpoint.id} 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  let body: Record<string, unknown>;
  try {
    const value = await response.json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('响应不是 JSON 对象');
    body = value as Record<string, unknown>;
  } catch (error) {
    throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 返回了非法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (endpoint.protocol === 'openai-chat') return parseOpenAiChat(body, endpoint);
  if (endpoint.protocol === 'openai-responses') return parseOpenAiResponse(body, endpoint);
  if (endpoint.protocol === 'ollama-chat') return parseOllamaChat(body, endpoint);
  return parseAnthropicMessage(body, endpoint);
}
