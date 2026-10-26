import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { AnthropicReportWriter } from './anthropic.report-writer.js';
import { AnthropicSummarizer } from './anthropic.summarizer.js';
import { FakeReportWriter } from './fake.report-writer.js';
import { FakeSummarizer } from './fake.summarizer.js';
import type { ReportWriter, Summarizer } from './llm.types.js';

/** Inject bằng `@Inject(SUMMARIZER) private readonly summarizer: Summarizer`. */
export const SUMMARIZER = Symbol('SUMMARIZER');

/** Inject bằng `@Inject(REPORT_WRITER) private readonly writer: ReportWriter` (M9). */
export const REPORT_WRITER = Symbol('REPORT_WRITER');

/**
 * Bộ tóm tắt cho worker (M6 Q2). Mặc định GIẢ: dev / test / CI không cần key và không gửi transcript
 * ra ngoài; `LLM_PROVIDER=anthropic` mới gọi Claude API.
 */
@Module({
  providers: [
    {
      provide: SUMMARIZER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): Summarizer =>
        config.get('LLM_PROVIDER', { infer: true }) === 'anthropic'
          ? new AnthropicSummarizer({
              model: config.get('LLM_MODEL', { infer: true }),
              effort: config.get('LLM_EFFORT', { infer: true }),
              maxRetries: 2,
              timeoutMs: 10 * 60_000,
              chunkChars: 300_000,
            })
          : new FakeSummarizer(),
    },
    {
      // Cùng `LLM_PROVIDER` / model / effort với tóm tắt: một công tắc quyết định có gửi dữ liệu ra
      // ngoài hay không (M9 Q10 — báo cáo gửi TÓM TẮT, không phải transcript).
      provide: REPORT_WRITER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): ReportWriter =>
        config.get('LLM_PROVIDER', { infer: true }) === 'anthropic'
          ? new AnthropicReportWriter({
              model: config.get('LLM_MODEL', { infer: true }),
              effort: config.get('LLM_EFFORT', { infer: true }),
              maxRetries: 2,
              timeoutMs: 10 * 60_000,
            })
          : new FakeReportWriter(),
    },
  ],
  exports: [SUMMARIZER, REPORT_WRITER],
})
export class LlmModule {}
