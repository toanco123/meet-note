import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Query phân trang dùng chung. DTO danh sách cụ thể kế thừa class này và thêm filter. */
export class CursorQueryDto {
  /** Giá trị `nextCursor` của trang trước. Bỏ trống để lấy trang đầu. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  /**
   * Số phần tử mỗi trang (1–100).
   * @default 20
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;
}
