import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `YYYY-MM-DD`, năm 2000–2099, và phải là ngày có thật (`IsISO8601 strict` chặn 2026-02-30). Hai lớp vì
 * `IsISO8601` một mình nhận cả chuỗi có giờ ("2026-10-30T10:00Z"), mà cột là `date`.
 */
export const DATE_KEY = /^20\d{2}-\d{2}-\d{2}$/;

/** Tạo một việc cần làm thủ công cho cuộc họp. */
export class CreateActionItemDto {
  /**
   * Nội dung việc (1–500 ký tự sau khi bỏ khoảng trắng hai đầu).
   * @example "Gửi báo giá cho khách hàng"
   */
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  task: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'Người được giao: thành viên tổ chức và xem được cuộc họp này (không thì 422). Bỏ trống = chưa giao.',
  })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description: 'Hạn, `YYYY-MM-DD` (năm 2000–2099). Bỏ trống = không hạn.',
    example: '2026-10-30',
  })
  @IsOptional()
  @Matches(DATE_KEY, { message: 'dueDate phải có dạng YYYY-MM-DD (năm 2000–2099).' })
  @IsISO8601({ strict: true })
  dueDate?: string | null;
}
