import { ApiProperty } from '@nestjs/swagger';
import {
  NOTIFICATION_TYPES,
  type NotificationRow,
  type NotificationType,
} from '../../../infra/database/schema/index.js';

export class NotificationResponseDto {
  id: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES, enumName: 'NotificationType' })
  type: NotificationType;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Tổ chức liên quan; `null` = không thuộc tổ chức nào.',
  })
  orgId: string | null;

  /** Id + tên lúc tạo, khác nhau theo `type` (xem 05-api Notifications). */
  @ApiProperty({ type: 'object', additionalProperties: true })
  payload: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true, description: '`null` = chưa đọc.' })
  readAt: string | null;

  /** @example "2026-10-21T02:00:00.000Z" */
  createdAt: string;

  static from(row: NotificationRow): NotificationResponseDto {
    return {
      id: row.id,
      type: row.type,
      orgId: row.orgId,
      payload: row.payload,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
