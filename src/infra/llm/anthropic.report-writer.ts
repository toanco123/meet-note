import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, structuredRequest } from './anthropic-client.js';
import { LlmTransientError } from './llm.errors.js';
import type {
  AnthropicReportWriterOptions,
  ReportInput,
  ReportResult,
  ReportWriter,
  SummarizeOptions,
} from './llm.types.js';
import {
  formatReportPrompt,
  parseReportBody,
  REPORT_PROMPT_VERSION,
  REPORT_SCHEMA,
  REPORT_SYSTEM_PROMPT,
} from './report-format.js';

/**
 * Báo cáo tuần bằng Claude (M9 Q1). MỘT lượt gọi: đầu vào là TÓM TẮT (vài trăm token mỗi meeting),
 * không phải transcript, nên không cần map-reduce — số meeting đã bị chặn ở caller. Cách gọi và
 * phân loại lỗi dùng chung với `AnthropicSummarizer` (`anthropic-client.ts`).
 */
export class AnthropicReportWriter implements ReportWriter {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicReportWriterOptions) {
    this.client = createAnthropicClient(options);
  }

  async write(input: ReportInput, options: SummarizeOptions = {}): Promise<ReportResult> {
    const response = await structuredRequest(this.client, {
      model: this.options.model,
      effort: this.options.effort,
      system: REPORT_SYSTEM_PROMPT,
      prompt: formatReportPrompt(input),
      schema: REPORT_SCHEMA,
      signal: options.signal,
    });
    const content = parseReportBody(response.text);
    if (!content) throw new LlmTransientError('kết quả không đúng schema');
    return {
      content,
      model: response.model,
      promptVersion: REPORT_PROMPT_VERSION,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }
}
