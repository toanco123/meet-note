import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsString, Length, Matches, Max, Min } from 'class-validator';
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_MIME_TYPES,
  type UploadMimeType,
} from '../../../infra/database/schema/index.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class InitUploadDto {
  /**
   * Tên file gốc — chỉ để hiển thị, KHÔNG dùng làm object key trên S3.
   * @example "giao-ban-2026-10-19.m4a"
   */
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  filename: string;

  /** Định dạng client khai. Định dạng thật do ffprobe kiểm khi xử lý (M6). */
  @IsIn(UPLOAD_MIME_TYPES)
  @ApiProperty({ enum: UPLOAD_MIME_TYPES, enumName: 'UploadMimeType', example: 'audio/mp4' })
  mimeType: UploadMimeType;

  /**
   * Kích thước cả file (byte), 1 B – 2 GiB.
   * @example 52428800
   */
  @IsInt()
  @Min(1)
  @Max(UPLOAD_MAX_BYTES)
  sizeBytes: number;

  /**
   * sha256 của cả file (hex, không phân biệt hoa thường). Worker kiểm tra lại khi xử lý (M6).
   * @example "9f2c4a…64 ký tự hex"
   */
  @Transform(lower)
  @Matches(/^[0-9a-f]{64}$/, { message: 'sha256 phải là 64 ký tự hex' })
  sha256: string;

  /**
   * Tiêu đề cuộc họp.
   * @example "Giao ban kỹ thuật tuần 42"
   */
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  title: string;

  /**
   * Thời điểm họp (ISO 8601) — dùng để xếp vào báo cáo tuần.
   * @example "2026-10-19T02:00:00.000Z"
   */
  @IsISO8601({ strict: true })
  recordedAt: string;
}
