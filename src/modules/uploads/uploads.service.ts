import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Errors } from '../../common/errors/errors.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import type { UploadRow, UploadStatus } from '../../infra/database/schema/index.js';
import { OBJECT_STORAGE } from '../../infra/storage/storage.module.js';
import type { ObjectStorage } from '../../infra/storage/storage.types.js';
import type { InitUploadDto } from './dto/init-upload.dto.js';
import { UploadsRepository } from './uploads.repository.js';
import type { UploadView } from './uploads.types.js';

/** 8 MiB (D4): ≥ 5 MiB mà S3 đòi, 2 GiB / 8 MiB = 256 phần — xa trần 10 000. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_HOURS = 24;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly repo: UploadsRepository,
  ) {}

  /**
   * Mở S3 multipart TRƯỚC, ghi DB SAU. INSERT lỗi → **abort multipart ngay** (hành động bù trừ):
   * multipart mà không có dòng nào trong DB trỏ tới thì job dọn dẹp không bao giờ thấy, và S3 giữ
   * các phần mồ côi (tính tiền dung lượng) mãi mãi.
   *
   * Thứ tự ngược lại (INSERT trước, mở S3 sau) cũng được, nhưng cần `s3_upload_id` NULL được và hai
   * lần ghi; lỗi ở giữa thì để lại dòng không dùng được.
   */
  async init(orgId: string, userId: string, dto: InitUploadDto): Promise<UploadView> {
    const id = await this.repo.allocateId();
    const objectKey = `orgs/${orgId}/uploads/${id}/source`;
    const { uploadId: s3UploadId } = await this.storage.createMultipartUpload(
      objectKey,
      dto.mimeType,
    );

    let upload: UploadRow;
    try {
      upload = await this.repo.insert({
        id,
        orgId,
        userId,
        filename: dto.filename,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        sha256: dto.sha256,
        chunkSize: UPLOAD_CHUNK_BYTES,
        totalParts: Math.ceil(dto.sizeBytes / UPLOAD_CHUNK_BYTES),
        title: dto.title,
        recordedAt: new Date(dto.recordedAt),
        objectKey,
        s3UploadId,
        // Đồng hồ của Postgres — cùng đồng hồ với job dọn dẹp so `expires_at < now()`.
        expiresAt: sql`now() + make_interval(hours => ${UPLOAD_TTL_HOURS}::int)`,
      });
    } catch (error) {
      await this.storage
        .abortMultipartUpload(objectKey, s3UploadId)
        .catch((abortError: unknown) => {
          // Bù trừ cũng lỗi → chỉ còn log để dọn tay; ném LỖI GỐC cho client, không ném lỗi abort.
          this.logger.error({ err: abortError, objectKey }, 'Không abort được multipart mồ côi');
        });
      throw error;
    }
    return { upload, parts: [], status: displayStatus(upload) };
  }

  async get(orgId: string, userId: string, uploadId: string): Promise<UploadView> {
    const upload = await this.repo.findOwned(orgId, userId, uploadId);
    if (!upload) throw Errors.upload.notFound();
    return { upload, parts: await this.repo.listParts(upload.id), status: displayStatus(upload) };
  }

  /**
   * Huỷ: khoá dòng → đánh dấu `aborted` → COMMIT → gọi S3 abort NGOÀI transaction (không giữ khoá
   * + connection trong lúc gọi mạng). S3 lỗi → `storage_aborted_at` còn NULL → job dọn dẹp (B7) thử
   * lại. Gọi lại khi đã huỷ / đã hết hạn → 204 (idempotent). Đã complete → 409.
   */
  async cancel(orgId: string, userId: string, uploadId: string): Promise<void> {
    const pending = await this.db.transaction(async (tx) => {
      const upload = await this.repo.lockOwned(orgId, userId, uploadId, tx);
      if (!upload) throw Errors.upload.notFound();
      if (upload.status === 'completed') throw Errors.upload.notActive();
      if (upload.status === 'initiated') await this.repo.markAborted(upload.id, tx);
      return upload.storageAbortedAt ? undefined : upload;
    });
    if (pending) await this.abortInStorage(pending);
  }

  private async abortInStorage(upload: UploadRow): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(upload.objectKey, upload.s3UploadId);
      await this.repo.markStorageAborted(upload.id);
    } catch (error) {
      this.logger.warn(
        { err: error, uploadId: upload.id },
        'Abort multipart lỗi — job dọn dẹp sẽ thử lại',
      );
    }
  }
}

function displayStatus(upload: UploadRow): UploadStatus {
  return upload.status === 'initiated' && upload.expiresAt.getTime() <= Date.now()
    ? 'expired'
    : upload.status;
}
