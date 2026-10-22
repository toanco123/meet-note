import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, UnrecoverableError } from 'bullmq';
import { JobName } from '../infra/queue/jobs.js';
import { QueueName } from '../infra/queue/queue.module.js';
import type { MeetingJobData } from '../infra/queue/queue.types.js';
import { PipelineJobRunner } from './pipeline-job-runner.js';

/**
 * Queue `transcription`: whisper chiếm hết CPU / GPU → concurrency 1 (M6). Tách queue để worker
 * chuyên transcribe chạy riêng (`WORKER_QUEUES=transcription`) mà không chặn job ngắn của `default`.
 */
@Processor(QueueName.Transcription, { concurrency: 1 })
export class TranscriptionQueueProcessor extends WorkerHost {
  constructor(private readonly runner: PipelineJobRunner) {
    super();
  }

  async process(job: Job<MeetingJobData>, token?: string): Promise<unknown> {
    if (job.name !== JobName.MeetingTranscribe) {
      throw new UnrecoverableError(`Job không xác định: ${job.name}`);
    }
    return this.runner.run('transcribe', job, token);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<MeetingJobData> | undefined, error: Error): Promise<void> {
    return this.runner.onFailed('transcribe', job, error);
  }
}
