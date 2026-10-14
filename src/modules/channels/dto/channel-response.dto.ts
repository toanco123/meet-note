import { ApiProperty } from '@nestjs/swagger';
import {
  CHANNEL_ROLES,
  CHANNEL_VISIBILITIES,
  type ChannelRoleValue,
  type ChannelVisibility,
} from '../../../infra/database/schema/index.js';
import type { ChannelDetailRow } from '../channels.types.js';

export class ChannelResponseDto {
  id: string;

  /** @example "Phòng Kỹ thuật" */
  name: string;

  @ApiProperty({ type: String, nullable: true, example: 'Giao ban kỹ thuật thứ Hai hằng tuần' })
  description: string | null;

  @ApiProperty({ enum: CHANNEL_VISIBILITIES, enumName: 'ChannelVisibility' })
  visibility: ChannelVisibility;

  /** Kênh có tham gia báo cáo tuần không (M9). */
  weeklyReportEnabled: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Thời điểm lưu trữ. `null` = đang hoạt động.',
  })
  archivedAt: string | null;

  /** @example "2026-10-14T08:00:00.000Z" */
  createdAt: string;

  @ApiProperty({
    enum: CHANNEL_ROLES,
    enumName: 'ChannelRole',
    nullable: true,
    description: 'Vai trò của tôi trong kênh. `null` = chưa là thành viên kênh.',
  })
  myRole: ChannelRoleValue | null;

  /** @example 8 */
  memberCount: number;

  static from(row: ChannelDetailRow): ChannelResponseDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      weeklyReportEnabled: row.weeklyReportEnabled,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      myRole: row.myRole,
      memberCount: row.memberCount,
    };
  }
}
