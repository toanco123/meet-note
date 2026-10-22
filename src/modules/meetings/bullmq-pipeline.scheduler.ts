import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { JobName, meetingJobId } from '../../infra/queue/jobs.js';
import { QueueName } from '../../infra/queue/queue.module.js';
import type { MeetingJobData } from '../../infra/queue/queue.types.js';
import type { PipelineJob, PipelineScheduler, PipelineStep } from './meetings.types.js';

/**
 * Mỗi bước: tên job, queue theo ĐẶC TÍNH TẢI (transcribe → `transcription`, concurrency 1), retry
 * theo 06 §1.2. Một chỗ duy nhất — upload complete (api) và các bước pipeline (worker) cùng dùng.
 */
const STEPS: Record<
  PipelineStep,
  { name: string; queue: 'default' | 'transcription'; options: JobsOptions }
> = {
  preprocess: {
    name: JobName.MeetingPreprocess,
    queue: 'default',
    options: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  },
  transcribe: {
    name: JobName.MeetingTranscribe,
    queue: 'transcription',
    options: { attempts: 2, backoff: { type: 'exponential', delay: 60_000 } },
  },
  summarize: {
    name: JobName.MeetingSummarize,
    queue: 'default',
    options: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
  },
};

/** `PipelineScheduler` trên BullMQ (M6 B5). Gọi SAU commit — xem `MeetingPipelineService`. */
@Injectable()
export class BullMqPipelineScheduler implements PipelineScheduler {
  constructor(
    @InjectQueue(QueueName.Default) private readonly defaultQueue: Queue<MeetingJobData>,
    @InjectQueue(QueueName.Transcription)
    private readonly transcriptionQueue: Queue<MeetingJobData>,
  ) {}

  async enqueue(step: PipelineStep, job: PipelineJob): Promise<void> {
    const spec = STEPS[step];
    const queue = spec.queue === 'transcription' ? this.transcriptionQueue : this.defaultQueue;
    // jobId theo (bước, meeting, attempt): enqueue lại cùng bước → BullMQ bỏ qua nếu đã có; chạy lại
    // (attempt mới) → job mới.
    await queue.add(spec.name, job, {
      ...spec.options,
      jobId: meetingJobId(spec.name as JobName, job.meetingId, job.attempt),
    });
  }
}
