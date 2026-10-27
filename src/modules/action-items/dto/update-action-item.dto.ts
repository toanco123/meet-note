import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import {
  ACTION_ITEM_STATUSES,
  type ActionItemStatus,
} from '../../../infra/database/schema/index.js';
import { DATE_KEY, trim } from './create-action-item.dto.js';

/**
 * Sửa một phần: chỉ field gửi lên mới đổi; `null` ở `assigneeId` / `dueDate` = bỏ giá trị. Cần ít nhất
 * một field (body rỗng → 400: mỗi lần sửa tăng `version`, sửa không đổi gì chỉ làm client khác bị 412
 * oan).
 *
 * Quyền theo field: `task` / `assigneeId` / `dueDate` và mọi chuyển trạng thái có `dismissed` là của
 * người quản lý cuộc họp; người được giao chỉ đổi được `open` ↔ `done`.
 */
export class UpdateActionItemDto {
  /**
   * Nội dung mới (1–500 ký tự sau khi bỏ khoảng trắng hai đầu).
   * @example "Gửi báo giá và hợp đồng cho khách hàng"
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  task?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'Người được giao mới (thành viên tổ chức xem được cuộc họp, không thì 422). `null` = bỏ giao.',
  })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description:
      'Hạn mới, `YYYY-MM-DD` (năm 2000–2099). `null` = bỏ hạn. Đặt hạn mới thì `dueText` (chữ gốc "thứ sáu") bị xoá.',
    example: '2026-10-30',
  })
  @IsOptional()
  @Matches(DATE_KEY, { message: 'dueDate phải có dạng YYYY-MM-DD (năm 2000–2099).' })
  @IsISO8601({ strict: true })
  dueDate?: string | null;

  @ApiProperty({ enum: ACTION_ITEM_STATUSES, enumName: 'ActionItemStatus', required: false })
  @IsOptional()
  @IsIn(ACTION_ITEM_STATUSES)
  status?: ActionItemStatus;
}
