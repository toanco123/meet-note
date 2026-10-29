import { ApiProperty } from '@nestjs/swagger';
import {
  ACTION_ITEM_ORIGINS,
  ACTION_ITEM_STATUSES,
  type ActionItemOrigin,
  type ActionItemStatus,
} from '../../../infra/database/schema/index.js';
import type { ActionItemListRow } from '../action-items.types.js';

export class ActionItemAssigneeDto {
  id: string;

  /** @example "Nguyễn Văn Bình" */
  displayName: string;
}

/** Một việc cần làm của cuộc họp (M12). */
export class ActionItemResponseDto {
  id: string;

  meetingId: string;

  /** @example "Giao ban kỹ thuật tuần 43" */
  meetingTitle: string;

  /** `ai`: model trích từ tóm tắt; `manual`: người tạo tay. Việc `ai` đã sửa vẫn là `ai`. */
  @ApiProperty({ enum: ACTION_ITEM_ORIGINS, enumName: 'ActionItemOrigin' })
  origin: ActionItemOrigin;

  /** @example "Gửi báo giá cho khách hàng" */
  task: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Tên người phụ trách đúng như model nghe được ("anh Bình"), kể cả khi chưa map được thành viên.',
  })
  ownerName: string | null;

  @ApiProperty({
    type: ActionItemAssigneeDto,
    nullable: true,
    description:
      'Thành viên được giao. null = chưa giao, không map được tên, hoặc người đó đã rời tổ chức.',
  })
  assignee: ActionItemAssigneeDto | null;

  @ApiProperty({ type: String, nullable: true, description: 'Hạn như được nói, vd "thứ sáu".' })
  dueText: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Hạn đã quy ra ngày (YYYY-MM-DD, giờ VN).',
    example: '2026-10-30',
  })
  dueDate: string | null;

  @ApiProperty({ enum: ACTION_ITEM_STATUSES, enumName: 'ActionItemStatus' })
  status: ActionItemStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Có khi `status = done`.' })
  completedAt: string | null;

  /** Gửi lại qua `If-Match` khi sửa. @example 1 */
  version: number;

  /** @example "2026-10-27T03:00:00.000Z" */
  createdAt: string;

  static from(row: ActionItemListRow): ActionItemResponseDto {
    const { item } = row;
    return {
      id: item.id,
      meetingId: item.meetingId,
      meetingTitle: row.meetingTitle,
      origin: item.origin,
      task: item.task,
      ownerName: item.ownerName,
      assignee:
        item.assigneeId && row.assigneeName
          ? { id: item.assigneeId, displayName: row.assigneeName }
          : null,
      dueText: item.dueText,
      dueDate: item.dueDate,
      status: item.status,
      completedAt: item.completedAt?.toISOString() ?? null,
      version: item.version,
      createdAt: item.createdAt.toISOString(),
    };
  }
}
