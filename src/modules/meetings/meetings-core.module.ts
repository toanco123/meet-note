import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueName } from '../../infra/queue/queue.module.js';
import { BullMqPipelineScheduler } from './bullmq-pipeline.scheduler.js';
import { PIPELINE_SCHEDULER } from './pipeline.tokens.js';

/** Phần dùng chung api + worker của meeting (M6): xếp job pipeline vào queue. Không controller. */
@Module({
  imports: [
    BullModule.registerQueue({ name: QueueName.Default }, { name: QueueName.Transcription }),
  ],
  // Class cũng export: quét kẹt (worker) cần phần riêng của BullMQ (trạng thái job), không có
  // trong interface `PipelineScheduler`.
  providers: [
    BullMqPipelineScheduler,
    { provide: PIPELINE_SCHEDULER, useExisting: BullMqPipelineScheduler },
  ],
  exports: [PIPELINE_SCHEDULER, BullMqPipelineScheduler],
})
export class MeetingsCoreModule {}
