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
  providers: [{ provide: PIPELINE_SCHEDULER, useClass: BullMqPipelineScheduler }],
  exports: [PIPELINE_SCHEDULER],
})
export class MeetingsCoreModule {}
