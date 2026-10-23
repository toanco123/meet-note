import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobState, JobsOptions, Queue } from 'bullmq';
import { JobName, meetingJobId, meetingRequeueJobId } from '../../infra/queue/jobs.js';
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

/** Job còn "sống": sẽ chạy hoặc đang chạy. `completed` / `failed` / mất (`unknown`) thì không. */
const LIVE_STATES = new Set<JobState | 'unknown'>([
  'waiting',
  'prioritized',
  'delayed',
  'active',
  'waiting-children',
]);

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
    // jobId theo (bước, meeting, attempt): enqueue lại cùng bước → BullMQ bỏ qua nếu đã có; chạy lại
    // (attempt mới) → job mới.
    await this.queueOf(step).add(spec.name, job, {
      ...spec.options,
      jobId: meetingJobId(spec.name as JobName, job.meetingId, job.attempt),
    });
  }

  /**
   * Quét kẹt (B8) hỏi: job THƯỜNG của bước này còn sống không? Meeting `transcribing` lâu không đổi
   * có thể chỉ đang XẾP HÀNG sau các bản ghi dài (queue `transcription`, concurrency 1) — không phải
   * kẹt. Chỉ nhìn DB thì không phân biệt được hai trường hợp này.
   */
  async hasLiveJob(step: PipelineStep, meetingId: string, attempt: number): Promise<boolean> {
    const id = meetingJobId(STEPS[step].name as JobName, meetingId, attempt);
    return LIVE_STATES.has(await this.queueOf(step).getJobState(id));
  }

  /** Enqueue LẠI bước (quét kẹt) — jobId riêng, xem `meetingRequeueJobId`. */
  async requeue(step: PipelineStep, job: PipelineJob, version: string): Promise<void> {
    const spec = STEPS[step];
    await this.queueOf(step).add(spec.name, job, {
      ...spec.options,
      jobId: meetingRequeueJobId(spec.name as JobName, job.meetingId, job.attempt, version),
    });
  }

  private queueOf(step: PipelineStep): Queue<MeetingJobData> {
    return STEPS[step].queue === 'transcription' ? this.transcriptionQueue : this.defaultQueue;
  }
}
