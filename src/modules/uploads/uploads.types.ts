import type { Readable } from 'node:stream';
import type { UploadPartRow, UploadRow, UploadStatus } from '../../infra/database/schema/index.js';

/** Kiểu viết tay của module upload. */

/** Một upload kèm các phần đã nhận — đủ để trả về client (resume). */
export interface UploadView {
  upload: UploadRow;
  parts: Array<Pick<UploadPartRow, 'partNumber' | 'sizeBytes'>>;
  /** Trạng thái hiển thị: `initiated` mà quá hạn thì báo `expired` ngay, không đợi job dọn dẹp. */
  status: UploadStatus;
}

/** Một phần gửi lên qua `PUT …/parts/:partNumber` — header thô, chưa kiểm tra. */
export interface PartUploadInput {
  /** Chính request: stream thẳng sang S3, không đọc vào RAM. */
  body: Readable;
  contentType: string | undefined;
  contentLength: string | undefined;
  /** Bật khi client ngắt kết nối → huỷ lời gọi S3 đang chạy. */
  signal: AbortSignal;
}

export interface SavedPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

/** Đủ để gọi `AbortMultipartUpload` cho một upload. */
export type StorageAbortTarget = Pick<UploadRow, 'id' | 'objectKey' | 's3UploadId'>;

export interface ExpireBatchOptions {
  /** Số upload tối đa mỗi lô. */
  limit?: number;
  /** Chỉ dọn upload hết hạn quá số phút này (xem `UPLOAD_EXPIRY_GRACE_MINUTES`). */
  graceMinutes?: number;
  lockTimeoutMs?: number;
}

/** Kết quả một lô dọn dẹp. */
export interface CleanupBatchResult {
  /** Upload trong lô: vừa chuyển `expired`, hoặc được thử abort lại trên S3. */
  processed: string[];
  /** Đã abort trên S3 và ghi `storage_aborted_at`. */
  storageAborted: string[];
  /** Gọi S3 lỗi → `storage_aborted_at` còn NULL → lô `retryStorageAbortBatch` sau thử lại. */
  storageFailed: string[];
}
