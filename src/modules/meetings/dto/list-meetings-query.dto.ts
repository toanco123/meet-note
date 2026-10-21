import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import { MEETING_STATUSES, type MeetingStatus } from '../../../infra/database/schema/index.js';

export class ListMeetingsQueryDto extends CursorQueryDto {
  /** Chỉ meeting được chia sẻ vào kênh này. Phải đọc được nội dung kênh (không thì 403 / 404). */
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsIn(MEETING_STATUSES)
  @ApiProperty({ enum: MEETING_STATUSES, enumName: 'MeetingStatus', required: false })
  status?: MeetingStatus;

  /**
   * Thời điểm họp từ (gồm cả mốc này), ISO 8601.
   * @example "2026-10-01T00:00:00+07:00"
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  /**
   * Thời điểm họp tới (KHÔNG gồm mốc này), ISO 8601.
   * @example "2026-11-01T00:00:00+07:00"
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
