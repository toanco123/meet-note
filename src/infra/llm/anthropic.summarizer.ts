import Anthropic from '@anthropic-ai/sdk';
import { LlmPermanentError, LlmTransientError } from './llm.errors.js';
import type {
  AnthropicSummarizerOptions,
  MeetingSummaryContent,
  SummarizeOptions,
  Summarizer,
  SummaryInput,
  SummaryResult,
} from './llm.types.js';
import {
  chunkLines,
  formatTranscript,
  parseSummaryContent,
  PROMPT_VERSION,
  SUMMARY_SCHEMA,
  SYSTEM_PROMPT,
} from './summary-format.js';

/**
 * Tóm tắt bằng Claude (M6 Q2, B3) — `@anthropic-ai/sdk`, theo skill `claude-api`:
 * - JSON có cấu trúc qua `output_config.format` (`json_schema`). KHÔNG ép gọi tool: Claude Opus 5.5
 *   trả 400 cho `tool_choice` `any` / `tool`.
 * - `fallbacks: 'default'` (beta `server-side-fallback-2026-07-01`): bộ lọc an toàn từ chối thì API
 *   tự chạy lại trên model dự phòng trong CÙNG lời gọi; cả chuỗi từ chối → `stop_reason: refusal`.
 * - Effort đặt tường minh (mặc định của Claude Opus 5.5 là `medium`, các model khác `high`).
 * - Map-reduce khi transcript vượt `chunkChars` — hiếm: context 1M token, họp 4 giờ ≈ 50–80k token.
 */
export class AnthropicSummarizer implements Summarizer {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicSummarizerOptions) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: options.maxRetries,
      timeout: options.timeoutMs,
    });
  }

  async summarize(input: SummaryInput, options: SummarizeOptions = {}): Promise<SummaryResult> {
    const chunks = chunkLines(formatTranscript(input.segments), this.options.chunkChars);
    const usage = { input: 0, output: 0, model: this.options.model };
    const call = async (prompt: string) => {
      const result = await this.request(prompt, options.signal);
      usage.input += result.inputTokens;
      usage.output += result.outputTokens;
      usage.model = result.model;
      return result.content;
    };

    let content: MeetingSummaryContent;
    if (chunks.length <= 1) {
      content = await call(
        `Cuộc họp: "${input.meetingTitle}".\n\nTranscript:\n${chunks[0] ?? '(trống)'}`,
      );
    } else {
      // MAP: tóm tắt từng phần (tuần tự — vài phần, không cần song song và tránh đụng rate limit).
      const partials: MeetingSummaryContent[] = [];
      for (const [i, chunk] of chunks.entries()) {
        partials.push(
          await call(
            `Cuộc họp: "${input.meetingTitle}". Đây là PHẦN ${i + 1}/${chunks.length} của transcript — chỉ tóm tắt phần này.\n\nTranscript:\n${chunk}`,
          ),
        );
      }
      // REDUCE: gộp các bản tóm tắt phần thành một (bỏ trùng, giữ thứ tự diễn biến).
      content = await call(
        `Cuộc họp: "${input.meetingTitle}". Dưới đây là tóm tắt của ${partials.length} phần liên tiếp. Gộp thành MỘT bản tóm tắt cho cả cuộc họp: bỏ trùng lặp, giữ thứ tự diễn biến.\n\n${JSON.stringify(partials)}`,
      );
    }
    return {
      content,
      model: usage.model,
      promptVersion: PROMPT_VERSION,
      inputTokens: usage.input,
      outputTokens: usage.output,
    };
  }

  private async request(prompt: string, signal?: AbortSignal) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.options.model,
          max_tokens: 16_000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: {
            effort: this.options.effort,
            format: { type: 'json_schema', schema: SUMMARY_SCHEMA },
          },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal },
      );
    } catch (error) {
      throw classify(error);
    }
    // Từ chối / bị cắt: nội dung có thể không theo schema → kiểm stop_reason TRƯỚC khi đọc content.
    if (response.stop_reason === 'refusal') throw new LlmPermanentError('refusal');
    if (response.stop_reason === 'max_tokens') throw new LlmPermanentError('max_tokens');
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    const content = parseSummaryContent(text);
    if (!content) throw new LlmTransientError('kết quả không đúng schema');
    const u = response.usage;
    return {
      content,
      model: response.model,
      inputTokens:
        u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    };
  }
}

/**
 * Lỗi SDK → tạm / vĩnh viễn bằng CLASS có kiểu (không so chuỗi thông điệp). SDK đã tự retry 408 /
 * 409 / 429 / 5xx / lỗi mạng `maxRetries` lần trước khi ném tới đây. Huỷ do worker tắt
 * (`APIUserAbortError`) ném nguyên — không phải lỗi của LLM.
 */
function classify(error: unknown): unknown {
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
