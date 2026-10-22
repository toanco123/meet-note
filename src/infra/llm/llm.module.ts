import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { AnthropicSummarizer } from './anthropic.summarizer.js';
import { FakeSummarizer } from './fake.summarizer.js';
import type { Summarizer } from './llm.types.js';

/** Inject bằng `@Inject(SUMMARIZER) private readonly summarizer: Summarizer`. */
export const SUMMARIZER = Symbol('SUMMARIZER');

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
  ],
  exports: [SUMMARIZER],
})
export class LlmModule {}
