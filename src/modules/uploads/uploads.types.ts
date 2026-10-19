import type { UploadPartRow, UploadRow, UploadStatus } from '../../infra/database/schema/index.js';

/** Kiểu viết tay của module upload. */

/** Một upload kèm các phần đã nhận — đủ để trả về client (resume). */
export interface UploadView {
  upload: UploadRow;
  parts: Array<Pick<UploadPartRow, 'partNumber' | 'sizeBytes'>>;
  /** Trạng thái hiển thị: `initiated` mà quá hạn thì báo `expired` ngay, không đợi job dọn dẹp. */
  status: UploadStatus;
}
