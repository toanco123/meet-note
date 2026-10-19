import type { Readable } from 'node:stream';

/** Kiểu của tầng lưu file. Module domain chỉ biết `ObjectStorage`, không biết SDK S3. */

export interface UploadPartInput {
  key: string;
  uploadId: string;
  /** 1–10 000 (giới hạn của S3). */
  partNumber: number;
  /** Stream thẳng từ request — KHÔNG đọc hết vào RAM. */
  body: Readable;
  /** Bắt buộc với stream: S3 cần biết trước độ dài, không có thì SDK phải buffer cả phần. */
  contentLength: number;
  /** Client ngắt kết nối → huỷ lời gọi S3 đang chạy. */
  signal?: AbortSignal;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectStorage {
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  uploadPart(input: UploadPartInput): Promise<{ etag: string }>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    signal?: AbortSignal,
  ): Promise<void>;
  /** Idempotent: multipart đã bị huỷ / không tồn tại → coi như xong, không lỗi. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** `undefined` = không có object. */
  headObject(key: string): Promise<{ sizeBytes: number } | undefined>;
}
