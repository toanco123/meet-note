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
