import { Injectable, Logger } from '@nestjs/common';
import type { MeetingStatus } from '../../../infra/database/schema/index.js';
import { BullMqPipelineScheduler } from '../bullmq-pipeline.scheduler.js';
import type { PipelineStep, SweepResult } from '../meetings.types.js';
import { MeetingPipelineRepository } from '../repositories/meeting-pipeline.repository.js';

/**
 * Lâu hơn mọi khe hở bình thường giữa "commit trạng thái" và "job nhận việc" (vài ms tới vài giây
 * khi queue rỗng). Meeting đang chạy thật thì có lease → không bị quét dù lâu tới đâu.
 */
export const STUCK_AFTER_MS = 10 * 60_000;

/** Trạng thái → bước nhận việc từ trạng thái đó (khớp `from` của `claim` trong pipeline). */
const STEP_OF: Partial<Record<MeetingStatus, PipelineStep>> = {
  queued: 'preprocess',
  preprocessing: 'preprocess',
  transcribing: 'transcribe',
  summarizing: 'summarize',
};

/**
 * Quét meeting kẹt (M6 B8) — chạy trong worker (user `BYPASSRLS`: xuyên mọi tổ chức).
 *
 * Kẹt xảy ra khi chuỗi job đứt: api commit meeting `queued` rồi Redis lỗi lúc enqueue; worker chết
 * cứng (SIGKILL) giữa bước → BullMQ chạy lại job (stalled) nhưng lease chưa hết → job "bỏ qua" rồi
 * `completed`, khi lease hết thì không còn job nào. Quét chỉ BẢO ĐẢM TIẾN TRIỂN; đúng đắn vẫn nằm ở
 * `claim` (lease + `attempt`) — job thừa nếu có cũng chỉ nhận 0 dòng rồi bỏ qua.
 */
@Injectable()
export class MeetingSweepService {
  private readonly logger = new Logger(MeetingSweepService.name);

  constructor(
    private readonly repo: MeetingPipelineRepository,
    private readonly scheduler: BullMqPipelineScheduler,
  ) {}

  async sweep({
    idleMs = STUCK_AFTER_MS,
    batchSize = 100,
    maxRows = 1_000,
  }: { idleMs?: number; batchSize?: number; maxRows?: number } = {}): Promise<SweepResult> {
    const result: SweepResult = { requeued: [], skipped: [] };
    let after: { updatedAt: string; id: string } | undefined;
    for (let seen = 0; seen < maxRows;) {
      const batch = await this.repo.findStuck(idleMs, batchSize, after);
      for (const meeting of batch) {
        const step = STEP_OF[meeting.status];
        if (!step) continue;
        if (await this.scheduler.hasLiveJob(step, meeting.id, meeting.attempt)) {
          result.skipped.push(meeting.id);
          continue;
        }
        const job = { meetingId: meeting.id, attempt: meeting.attempt, requestId: null };
        await this.scheduler.requeue(step, job, meeting.version);
        result.requeued.push(meeting.id);
        this.logger.warn(
          { meetingId: meeting.id, status: meeting.status, attempt: meeting.attempt },
          `Meeting kẹt → enqueue lại bước ${step}`,
        );
      }
      seen += batch.length;
      const last = batch.at(-1);
      if (!last || batch.length < batchSize) break;
      after = { updatedAt: last.updatedAt, id: last.id };
    }
    return result;
  }
}
