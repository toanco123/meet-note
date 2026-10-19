import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Errors } from '../../common/errors/errors.js';
import type { MeetingRow } from '../../infra/database/schema/index.js';
import { JobName, meetingJobId } from '../../infra/queue/jobs.js';
import { QueueName } from '../../infra/queue/queue.module.js';
import type { MeetingJobData } from '../../infra/queue/queue.types.js';
import { MeetingsRepository } from './meetings.repository.js';

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    private readonly repo: MeetingsRepository,
    @InjectQueue(QueueName.Default) private readonly queue: Queue<MeetingJobData>,
  ) {}

  async getOwned(orgId: string, userId: string, meetingId: string): Promise<MeetingRow> {
    const meeting = await this.repo.findOwned(orgId, userId, meetingId);
    if (!meeting) throw Errors.meeting.notFound();
    return meeting;
  }

  /**
   * Gọi SAU KHI transaction tạo meeting đã COMMIT. Enqueue trong transaction mà transaction rollback
   * → job "ma" trỏ tới meeting không tồn tại; enqueue trước commit → worker đọc DB khi dòng chưa có.
   *
   * Enqueue lỗi (Redis sập) → KHÔNG ném: meeting đã được tạo, client nhận kết quả. Meeting nằm ở
   * `queued` không có job; gọi lại complete sẽ enqueue lại (jobId trùng → BullMQ bỏ qua nếu đã có),
   * và từ M6 job quét meeting `queued` quá 5 phút làm việc này ("outbox nghèo", 06-flows §1.1).
   */
  async enqueuePreprocess(meeting: MeetingRow, requestId: string | null): Promise<void> {
    if (meeting.status !== 'queued') return;
    try {
      await this.queue.add(
        JobName.MeetingPreprocess,
        { meetingId: meeting.id, requestId },
        {
          jobId: meetingJobId(JobName.MeetingPreprocess, meeting.id, meeting.attempt),
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
        },
      );
    } catch (error) {
      this.logger.error({ err: error, meetingId: meeting.id }, 'Enqueue meeting.preprocess lỗi');
    }
  }
}
