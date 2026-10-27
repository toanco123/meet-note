import { Injectable } from '@nestjs/common';
import { ChannelsPurgeService } from '../modules/channels/services/channels-purge.service.js';
import { IdempotencyRepository } from '../modules/idempotency/idempotency.repository.js';
import { ReportSweepService } from '../modules/reports/services/report-sweep.service.js';
import { MeetingSweepService } from '../modules/meetings/services/meeting-sweep.service.js';
import { UploadsCleanupService } from '../modules/uploads/services/uploads-cleanup.service.js';

/**
 * Trần số lô cho MỘT lần chạy: dữ liệu tới nhanh hơn tốc độ dọn thì lần chạy vẫn kết thúc (phần còn
 * lại để lịch sau), không giữ một slot của queue `default` mãi.
 */
const MAX_BATCHES = 50;
const IDEMPOTENCY_BATCH = 1_000;

/**
 * Việc định kỳ của worker (M6 B8). Logic dọn đã có từ M4 / M5 (service + test đồng thời); ở đây chỉ
 * lặp lô và trả số liệu cho log / test. Chạy trong worker vì cần thấy MỌI tổ chức: dưới user api
 * (RLS, không ngữ cảnh tổ chức) các query này trả 0 dòng mà không báo lỗi.
 */
@Injectable()
export class MaintenanceJobRunner {
  constructor(
    private readonly sweeper: MeetingSweepService,
    private readonly reportSweeper: ReportSweepService,
    private readonly uploads: UploadsCleanupService,
    private readonly idempotency: IdempotencyRepository,
    private readonly channels: ChannelsPurgeService,
  ) {}

  async sweepStuckMeetings(): Promise<{ requeued: number; skipped: number }> {
    const { requeued, skipped } = await this.sweeper.sweep();
    return { requeued: requeued.length, skipped: skipped.length };
  }

  async sweepStuckReports(): Promise<{ requeued: number; skipped: number }> {
    const { requeued, skipped } = await this.reportSweeper.sweep();
    return { requeued: requeued.length, skipped: skipped.length };
  }

  /** Hết hạn upload bỏ dở (lặp tới khi rỗng) + thử abort S3 lại MỘT lô (xem `retryStorageAbortBatch`). */
  async cleanupUploads(): Promise<{ expired: number; storageFailed: number; retried: number }> {
    let expired = 0;
    let storageFailed = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await this.uploads.expireBatch();
      if (batch.processed.length === 0) break;
      expired += batch.processed.length;
      storageFailed += batch.storageFailed.length;
    }
    const retry = await this.uploads.retryStorageAbortBatch();
    return { expired, storageFailed, retried: retry.storageAborted.length };
  }

  async cleanupIdempotencyKeys(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await this.idempotency.deleteExpiredBatch(IDEMPOTENCY_BATCH);
      deleted += n;
      if (n < IDEMPOTENCY_BATCH) break;
    }
    return { deleted };
  }

  async purgeChannels(): Promise<{ purged: number }> {
    let purged = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await this.channels.purgeBatch();
      if (batch.length === 0) break;
      purged += batch.length;
    }
    return { purged };
  }
}
