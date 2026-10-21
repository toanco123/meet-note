import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';

/** Query string luôn là chuỗi, dự án tắt implicit conversion → chỉ nhận đúng "true" / "false". */
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class NotificationOrgFilterDto {
  /** Chỉ thông báo của tổ chức này. */
  @IsOptional()
  @IsUUID()
  orgId?: string;
}

export class ListNotificationsQueryDto extends CursorQueryDto {
  /** Chỉ thông báo của tổ chức này. */
  @IsOptional()
  @IsUUID()
  orgId?: string;

  /**
   * `true`: chỉ thông báo chưa đọc.
   * @default false
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unreadOnly: boolean = false;
}

export class UnreadCountResponseDto {
  /** Số chưa đọc, TỐI ĐA 100 (đếm có trần — M10 Q5). @example 7 */
  count: number;

  /** Chuỗi để hiển thị: `"0"` … `"99"`, hoặc `"99+"` khi từ 100 trở lên. @example "7" */
  display: string;
}
