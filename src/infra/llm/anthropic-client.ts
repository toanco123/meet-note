import Anthropic from '@anthropic-ai/sdk';
import { LlmPermanentError, LlmTransientError } from './llm.errors.js';
import type { AnthropicClientOptions, StructuredRequest, StructuredResponse } from './llm.types.js';

export function createAnthropicClient(options: AnthropicClientOptions): Anthropic {
  return new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: options.maxRetries,
    timeout: options.timeoutMs,
  });
}

/**
 * Một lượt gọi Claude với JSON có cấu trúc (theo skill `claude-api`):
 * - `output_config.format` (`json_schema`), KHÔNG ép gọi tool: Claude Opus 5.5 trả 400 cho
 *   `tool_choice` `any` / `tool`.
 * - `fallbacks: 'default'` (beta `server-side-fallback-2026-07-01`): bộ lọc an toàn từ chối thì API tự
 *   chạy lại trên model dự phòng trong CÙNG lời gọi; cả chuỗi từ chối → `stop_reason: refusal`.
 * - Effort đặt tường minh (mặc định của Claude Opus 5.5 là `medium`, các model khác `high`).
 */
export async function structuredRequest(
  client: Anthropic,
  request: StructuredRequest,
): Promise<StructuredResponse> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model: request.model,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: request.effort,
          format: { type: 'json_schema', schema: request.schema },
        },
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      },
      { signal: request.signal },
    );
  } catch (error) {
    throw classifyAnthropicError(error);
  }
  // Từ chối / bị cắt: nội dung có thể không theo schema → kiểm stop_reason TRƯỚC khi đọc content.
  if (response.stop_reason === 'refusal') throw new LlmPermanentError('refusal');
  if (response.stop_reason === 'max_tokens') throw new LlmPermanentError('max_tokens');
  const u = response.usage;
  return {
    text: response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
    model: response.model,
    inputTokens:
      u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
}

/**
 * Lỗi SDK → tạm / vĩnh viễn bằng CLASS có kiểu (không so chuỗi thông điệp). SDK đã tự retry 408 /
 * 409 / 429 / 5xx / lỗi mạng `maxRetries` lần trước khi ném tới đây. Huỷ do worker tắt
 * (`APIUserAbortError`) ném nguyên — không phải lỗi của LLM.
 */
export function classifyAnthropicError(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (
    error instanceof Anthropic.APIConnectionError || // gồm APIConnectionTimeoutError
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.ConflictError
  ) {
    return new LlmTransientError(error.constructor.name, { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    // BadRequest / Authentication / PermissionDenied / NotFound / UnprocessableEntity…
    const status = error.status ?? 0;
    return status >= 400 && status < 500
      ? new LlmPermanentError(`${error.constructor.name} (${status})`, { cause: error })
      : new LlmTransientError(`${error.constructor.name} (${status})`, { cause: error });
  }
  return error;
}
