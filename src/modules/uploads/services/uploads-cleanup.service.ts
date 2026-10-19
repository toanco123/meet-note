import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import { OBJECT_STORAGE } from '../../../infra/storage/storage.module.js';
import type { ObjectStorage } from '../../../infra/storage/storage.types.js';
import { UploadsRepository } from '../uploads.repository.js';
import type {
  CleanupBatchResult,
  ExpireBatchOptions,
  StorageAbortTarget,
} from '../uploads.types.js';

/**
 * Ân hạn sau `expires_at` trước khi dọn. S3: abort multipart lúc còn phần ĐANG gửi thì phần đó "có
 * thể thành công hoặc không" (tài liệu AWS khuyên abort lại) → phần mồ côi sau khi đã abort. Một PUT
 * phần chỉ BẮT ĐẦU được trước `expires_at` (sau đó → 410), và Node cắt request quá `requestTimeout`
 * (mặc định 5 phút) → sau 10 phút chắc chắn không còn phần nào đang gửi.
 */
export const UPLOAD_EXPIRY_GRACE_MINUTES = 10;

/**
 * Dọn upload bỏ dở (M5 B7). Chỉ LOGIC + test; LÊN LỊCH (BullMQ repeatable job trong worker) ở M6,
 * như purge kênh của M4. Nhiều worker gọi song song được.
 *
 * Hai pha, vì không giữ transaction trong lúc gọi mạng:
 * 1. Transaction ngắn: đánh dấu `expired` (DB là nguồn sự thật: từ đây upload không nhận gì nữa).
 * 2. NGOÀI transaction: `AbortMultipartUpload` từng upload, thành công thì ghi `storage_aborted_at`.
 * Chết / S3 lỗi giữa hai pha → `storage_aborted_at` còn NULL → `retryStorageAbortBatch` gom lại.
 */
@Injectable()
export class UploadsCleanupService {
  private readonly logger = new Logger(UploadsCleanupService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly repo: UploadsRepository,
  ) {}

  /** Gọi lặp tới khi `processed` rỗng: dòng đã xử lý rời trạng thái `initiated` nên vòng lặp dừng. */
  async expireBatch(options: ExpireBatchOptions = {}): Promise<CleanupBatchResult> {
    const {
      limit = 100,
      graceMinutes = UPLOAD_EXPIRY_GRACE_MINUTES,
      lockTimeoutMs = 5000,
    } = options;
    const expired = await this.db.transaction(async (tx) => {
      // `SET LOCAL lock_timeout = $1` không bind được tham số → `set_config(…, true)` (bài học M4).
      await tx.execute(sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
      return this.repo.expireBatch({ limit, graceMinutes }, tx);
    });
    return this.abortAll(expired);
  }

  /**
   * Thử abort lại MỘT lô mỗi lần chạy job. KHÔNG lặp "tới khi rỗng": S3 lỗi kéo dài thì các dòng lỗi
   * vẫn nằm đó → vòng lặp quay mãi, dồn lời gọi vào một S3 đang sập.
   */
  async retryStorageAbortBatch({
    limit = 100,
  }: { limit?: number } = {}): Promise<CleanupBatchResult> {
    return this.abortAll(await this.repo.listStorageAbortPending(limit));
  }

  /**
   * Abort trên S3 rồi ghi `storage_aborted_at`. KHÔNG ném: `false` = để lần dọn sau thử lại. Dùng
   * chung cho huỷ thủ công (`UploadsService.cancel`) và job. Abort lần hai là no-op (idempotent).
   */
  async abortInStorage(target: StorageAbortTarget): Promise<boolean> {
    try {
      await this.storage.abortMultipartUpload(target.objectKey, target.s3UploadId);
      await this.repo.markStorageAborted(target.id);
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, uploadId: target.id },
        'Abort multipart lỗi — lần dọn sau thử lại',
      );
      return false;
    }
  }

  /** Tuần tự: lô nhỏ, và không dồn hàng trăm lời gọi cùng lúc vào S3. */
  private async abortAll(targets: StorageAbortTarget[]): Promise<CleanupBatchResult> {
    const result: CleanupBatchResult = {
      processed: targets.map((target) => target.id),
      storageAborted: [],
      storageFailed: [],
    };
    for (const target of targets) {
      const aborted = await this.abortInStorage(target);
      (aborted ? result.storageAborted : result.storageFailed).push(target.id);
    }
    return result;
  }
}
