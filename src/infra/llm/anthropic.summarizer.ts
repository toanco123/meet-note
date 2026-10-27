import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, structuredRequest } from './anthropic-client.js';
import { LlmTransientError } from './llm.errors.js';
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
  describeMeetingDate,
  formatTranscript,
  parseSummaryContent,
  PROMPT_VERSION,
  SUMMARY_SCHEMA,
  SYSTEM_PROMPT,
} from './summary-format.js';

/**
 * Tóm tắt bằng Claude (M6 Q2, B3). Cách gọi (structured output, fallbacks, effort, phân loại lỗi)
 * dùng chung với `AnthropicReportWriter` ở `anthropic-client.ts`. Map-reduce khi transcript vượt `chunkChars` — hiếm: context 1M token, họp 4 giờ ≈ 50–80k token.
 */
export class AnthropicSummarizer implements Summarizer {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicSummarizerOptions) {
    this.client = createAnthropicClient(options);
  }

  async summarize(input: SummaryInput, options: SummarizeOptions = {}): Promise<SummaryResult> {
    const chunks = chunkLines(formatTranscript(input.segments), this.options.chunkChars);
    const when = describeMeetingDate(input.meetingDate);
    const usage = { input: 0, output: 0, model: this.options.model };
    const call = async (prompt: string) => {
      const result = await this.request(prompt, input.meetingDate, options.signal);
      usage.input += result.inputTokens;
      usage.output += result.outputTokens;
      usage.model = result.model;
      return result.content;
    };

    let content: MeetingSummaryContent;
    if (chunks.length <= 1) {
      content = await call(
        `Cuộc họp: "${input.meetingTitle}". ${when}\n\nTranscript:\n${chunks[0] ?? '(trống)'}`,
      );
    } else {
      // MAP: tóm tắt từng phần (tuần tự — vài phần, không cần song song và tránh đụng rate limit).
      const partials: MeetingSummaryContent[] = [];
      for (const [i, chunk] of chunks.entries()) {
        partials.push(
          await call(
            `Cuộc họp: "${input.meetingTitle}". ${when} Đây là PHẦN ${i + 1}/${chunks.length} của transcript — chỉ tóm tắt phần này.\n\nTranscript:\n${chunk}`,
          ),
        );
      }
      // REDUCE: gộp các bản tóm tắt phần thành một (bỏ trùng, giữ thứ tự diễn biến).
      content = await call(
        `Cuộc họp: "${input.meetingTitle}". ${when} Dưới đây là tóm tắt của ${partials.length} phần liên tiếp. Gộp thành MỘT bản tóm tắt cho cả cuộc họp: bỏ trùng lặp, giữ thứ tự diễn biến.\n\n${JSON.stringify(partials)}`,
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

  private async request(prompt: string, meetingDate: string, signal?: AbortSignal) {
    const response = await structuredRequest(this.client, {
      model: this.options.model,
      effort: this.options.effort,
      system: SYSTEM_PROMPT,
      prompt,
      schema: SUMMARY_SCHEMA,
      signal,
    });
    const content = parseSummaryContent(response.text, meetingDate);
    if (!content) throw new LlmTransientError('kết quả không đúng schema');
    return {
      content,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }
}
