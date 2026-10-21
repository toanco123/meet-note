import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Errors } from '../../../common/errors/errors.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import type { MeetingRow, UploadRow, UploadStatus } from '../../../infra/database/schema/index.js';
import { MultipartUploadNotFoundError } from '../../../infra/storage/storage.errors.js';
import { OBJECT_STORAGE } from '../../../infra/storage/storage.module.js';
import type { ObjectStorage } from '../../../infra/storage/storage.types.js';
import { MeetingsRepository } from '../../meetings/repositories/meetings.repository.js';
import { MeetingsService } from '../../meetings/services/meetings.service.js';
import type { InitUploadDto } from '../dto/init-upload.dto.js';
import { UploadsRepository } from '../uploads.repository.js';
import { UploadsCleanupService } from './uploads-cleanup.service.js';
import type { PartUploadInput, SavedPart, UploadView } from '../uploads.types.js';

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
    private readonly meetingsRepo: MeetingsRepository,
    private readonly meetings: MeetingsService,
    private readonly cleanup: UploadsCleanupService,
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
   * Nhận MỘT phần. Mọi kiểm tra chạy TRƯỚC khi đọc byte nào của body — từ chối sớm thì không
   * tốn băng thông nhận dữ liệu sẽ bị bỏ. Sau đó stream thẳng `req` → S3 `UploadPart` kèm
   * `ContentLength`: không có Buffer cả phần trong RAM, backpressure đi tới tận TCP của client.
   */
  async uploadPart(
    orgId: string,
    userId: string,
    uploadId: string,
    partNumber: number,
    input: PartUploadInput,
  ): Promise<Omit<SavedPart, 'etag'>> {
    if (!isOctetStream(input.contentType)) throw Errors.upload.unsupportedMediaType();
    const length = parseContentLength(input.contentLength);
    if (length === undefined) throw Errors.upload.lengthRequired();

    const upload = await this.repo.findOwned(orgId, userId, uploadId);
    if (!upload) throw Errors.upload.notFound();
    assertAcceptingParts(upload);
    if (partNumber < 1 || partNumber > upload.totalParts) {
      throw Errors.upload.partOutOfRange(upload.totalParts);
    }
    const expected = expectedPartSize(upload, partNumber);
    if (length > expected) throw Errors.upload.partTooLarge(expected);
    if (length !== expected) throw Errors.upload.partSizeMismatch(expected, length);

    let etag: string;
    try {
      ({ etag } = await this.storage.uploadPart({
        key: upload.objectKey,
        uploadId: upload.s3UploadId,
        partNumber,
        body: input.body,
        contentLength: length,
        signal: input.signal,
      }));
    } catch (error) {
      if (input.signal.aborted) throw Errors.upload.partAborted();
      // Multipart bị huỷ / complete trong lúc phần đang lên.
      if (error instanceof MultipartUploadNotFoundError) throw Errors.upload.notActive();
      throw error;
    }

    const saved = await this.repo.upsertPart({
      uploadId: upload.id,
      partNumber,
      sizeBytes: length,
      etag,
    });
    if (!saved) throw Errors.upload.notActive();
    return { partNumber, sizeBytes: length };
  }

  /**
   * Ghép file trên S3 → tạo meeting `queued` → COMMIT → enqueue `meeting.preprocess`.
   *
   * - Khoá `FOR UPDATE` dòng upload suốt transaction, kể cả lúc gọi S3 (M5 Q2, timeout 30 s): hai
   *   complete song song xếp hàng → đúng MỘT meeting. Khoá chỉ chặn chính upload này.
   * - Gọi lại khi đã `completed` → trả meeting cũ (`created: false`, 200), không tạo thêm.
   * - Enqueue SAU commit (xem `MeetingsService.enqueuePreprocess`).
   */
  async complete(
    orgId: string,
    userId: string,
    uploadId: string,
    requestId: string | null,
  ): Promise<{ meeting: MeetingRow; created: boolean }> {
    const outcome = await this.db.transaction(async (tx) => {
      const upload = await this.repo.lockOwned(orgId, userId, uploadId, tx);
      if (!upload) throw Errors.upload.notFound();
      if (upload.status === 'completed' && upload.meetingId) {
        return { meetingId: upload.meetingId, created: false };
      }
      assertAcceptingParts(upload);

      const parts = await this.repo.listPartsForComplete(upload.id, tx);
      const received = new Set(parts.map((p) => p.partNumber));
      const missing = Array.from({ length: upload.totalParts }, (_, i) => i + 1).filter(
        (n) => !received.has(n),
      );
      if (missing.length > 0) throw Errors.upload.incomplete(missing);

      await this.completeInStorage(upload, parts);
      const meeting = await this.meetingsRepo.insert(
        {
          orgId: upload.orgId,
          ownerId: upload.userId,
          title: upload.title,
          recordedAt: upload.recordedAt,
          sourceObjectKey: upload.objectKey,
        },
        tx,
      );
      await this.repo.markCompleted(upload.id, meeting.id, tx);
      return { meetingId: meeting.id, created: true };
    });

    const meeting = await this.meetingsRepo.findById(outcome.meetingId);
    if (!meeting) throw Errors.meeting.notFound();
    // Cả lần đầu lẫn lần gọi lại: meeting còn `queued` thì enqueue (jobId trùng → BullMQ bỏ qua).
    // Lần đầu enqueue lỗi (Redis sập) thì client gọi lại complete là tự sửa được.
    await this.meetings.enqueuePreprocess(meeting, requestId);
    // Chỉ lần TẠO thật: complete gọi lại (200) không phát lại — event là "trạng thái vừa đổi".
    if (outcome.created) this.meetings.publishStatus(meeting);
    return { meeting, created: outcome.created };
  }

  /**
   * `NoSuchUpload` lúc complete = multipart KHÔNG còn. Một khả năng hợp lệ: lần complete trước đã
   * ghép xong trên S3 nhưng ghi DB lỗi → transaction rollback → DB vẫn `initiated`. Không gỡ thì
   * upload KẸT MÃI (mọi lần complete sau đều nhận NoSuchUpload). Gỡ: object đã có và đúng kích
   * thước → coi như S3 xong, đi tiếp phần ghi DB. Không có object → multipart đã bị huỷ → 409.
   */
  private async completeInStorage(
    upload: UploadRow,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    try {
      await this.storage.completeMultipartUpload(
        upload.objectKey,
        upload.s3UploadId,
        parts,
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      if (!(error instanceof MultipartUploadNotFoundError)) throw error;
      const object = await this.storage.headObject(upload.objectKey);
      if (object?.sizeBytes !== upload.sizeBytes) throw Errors.upload.notActive();
    }
  }

  /**
   * Huỷ: khoá dòng → đánh dấu `aborted` → COMMIT → gọi S3 abort NGOÀI transaction (không giữ khoá
   * + connection trong lúc gọi mạng). S3 lỗi → `storage_aborted_at` còn NULL →
   * `UploadsCleanupService.retryStorageAbortBatch` thử lại. Gọi lại khi đã huỷ / đã hết hạn → 204 (idempotent). Đã complete → 409.
   */
  async cancel(orgId: string, userId: string, uploadId: string): Promise<void> {
    const pending = await this.db.transaction(async (tx) => {
      const upload = await this.repo.lockOwned(orgId, userId, uploadId, tx);
      if (!upload) throw Errors.upload.notFound();
      if (upload.status === 'completed') throw Errors.upload.notActive();
      if (upload.status === 'initiated') await this.repo.markAborted(upload.id, tx);
      return upload.storageAbortedAt ? undefined : upload;
    });
    if (pending) await this.cleanup.abortInStorage(pending);
  }
}

function displayStatus(upload: UploadRow): UploadStatus {
  return upload.status === 'initiated' && upload.expiresAt.getTime() <= Date.now()
    ? 'expired'
    : upload.status;
}

/** Upload còn nhận phần không: hết hạn → 410; đã huỷ / complete → 409. */
function assertAcceptingParts(upload: UploadRow): void {
  if (displayStatus(upload) === 'expired') throw Errors.upload.expired();
  if (upload.status !== 'initiated') throw Errors.upload.notActive();
}

/** Mọi phần đúng `chunkSize`, trừ phần cuối là phần còn lại. */
function expectedPartSize(upload: UploadRow, partNumber: number): number {
  return partNumber < upload.totalParts
    ? upload.chunkSize
    : upload.sizeBytes - upload.chunkSize * (upload.totalParts - 1);
}

function isOctetStream(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/octet-stream';
}

/** Chỉ nhận số nguyên thập phân; thiếu (vd `Transfer-Encoding: chunked`) → `undefined`. */
function parseContentLength(raw: string | undefined): number | undefined {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}
