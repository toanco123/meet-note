import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { LlmModule } from '../../infra/llm/llm.module.js';
import { MediaModule } from '../../infra/media/media.module.js';
import { SpeechModule } from '../../infra/speech/speech.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { MeetingsCoreModule } from './meetings-core.module.js';
import type { PipelineOptions } from './meetings.types.js';
import { MeetingPipelineRepository } from './repositories/meeting-pipeline.repository.js';
import { PIPELINE_OPTIONS } from './pipeline.tokens.js';
import { MeetingPipelineService } from './services/meeting-pipeline.service.js';

const MINUTE = 60_000;

/**
 * Pipeline xử lý meeting — CHỈ tiến trình worker import (ffmpeg, whisper, LLM). Api không kéo theo:
 * nó chỉ cần `MeetingsCoreModule` để enqueue.
 */
@Module({
  imports: [MeetingsCoreModule, NotificationsCoreModule, MediaModule, SpeechModule, LlmModule],
  providers: [
    MeetingPipelineRepository,
    MeetingPipelineService,
    {
      provide: PIPELINE_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): PipelineOptions => ({
        maxDurationMs: 4 * 60 * MINUTE, // 01-overview: bản ghi ≤ 4 giờ
        mediaTimeoutMs: 30 * MINUTE,
        transcribeTimeoutFactor: config.get('WHISPER_TIMEOUT_FACTOR', { infer: true }),
        transcribeBaseTimeoutMs: 2 * MINUTE,
        language: config.get('WHISPER_LANGUAGE', { infer: true }),
        // Tải + probe + chuyển đổi + đẩy lên: mỗi việc media ≤ 30 phút.
        preprocessLeaseMs: 45 * MINUTE,
        // SDK: timeout 10 phút × (maxRetries 2 + 1).
        summarizeLeaseMs: 35 * MINUTE,
        leaseMarginMs: 5 * MINUTE,
      }),
    },
  ],
  exports: [MeetingPipelineService],
})
export class MeetingsPipelineModule {}
