import { ApiProperty } from '@nestjs/swagger';
import {
  UPLOAD_MIME_TYPES,
  UPLOAD_STATUSES,
  type UploadMimeType,
  type UploadStatus,
} from '../../../infra/database/schema/index.js';
import type { UploadView } from '../uploads.types.js';

export class UploadPartResponseDto {
  /** @example 1 */
  partNumber: number;

  /** @example 8388608 */
  sizeBytes: number;
}

export class UploadResponseDto {
  id: string;

  /** `initiated` → đang nhận phần; `expired` → quá 24 giờ chưa complete. */
  @ApiProperty({ enum: UPLOAD_STATUSES, enumName: 'UploadStatus' })
  status: UploadStatus;

  /** @example "giao-ban-2026-10-19.m4a" */
  filename: string;

  @ApiProperty({ enum: UPLOAD_MIME_TYPES, enumName: 'UploadMimeType' })
  mimeType: UploadMimeType;

  /** @example 52428800 */
  sizeBytes: number;

  /**
   * Mỗi phần (trừ phần cuối) phải đúng bằng số byte này.
   * @example 8388608
   */
  chunkSize: number;

  /** @example 7 */
  totalParts: number;

  /** Phần đã nhận, tăng dần theo `partNumber`. Mất mạng thì gửi tiếp những phần còn thiếu. */
  receivedParts: UploadPartResponseDto[];

  /** @example "Giao ban kỹ thuật tuần 42" */
  title: string;

  /** @example "2026-10-19T02:00:00.000Z" */
  recordedAt: string;

  @ApiProperty({ type: String, nullable: true, description: 'Meeting tạo ra khi complete.' })
  meetingId: string | null;

  /** Quá thời điểm này mà chưa complete thì upload hết hạn. @example "2026-10-20T02:00:00.000Z" */
  expiresAt: string;

  /** @example "2026-10-19T02:00:00.000Z" */
  createdAt: string;

  static from({ upload, parts, status }: UploadView): UploadResponseDto {
    return {
      id: upload.id,
      status,
      filename: upload.filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      chunkSize: upload.chunkSize,
      totalParts: upload.totalParts,
      receivedParts: parts.map((p) => ({ partNumber: p.partNumber, sizeBytes: p.sizeBytes })),
      title: upload.title,
      recordedAt: upload.recordedAt.toISOString(),
      meetingId: upload.meetingId,
      expiresAt: upload.expiresAt.toISOString(),
      createdAt: upload.createdAt.toISOString(),
    };
  }
}
