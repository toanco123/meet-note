import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Sửa một phần: chỉ field gửi lên mới được đổi. Body rỗng → không đổi gì (200). */
export class UpdateMeetingDto {
  /** @example "Giao ban kỹ thuật tuần 43" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  title?: string;

  /**
   * Thời điểm họp (dùng cho báo cáo tuần), ISO 8601.
   * @example "2026-10-20T02:00:00.000Z"
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  recordedAt?: string;
}
