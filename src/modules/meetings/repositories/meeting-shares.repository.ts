import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import {
  type ChannelRoleValue,
  channelMembers,
  channels,
  meetings,
  meetingShares,
} from '../../../infra/database/schema/index.js';

/**
 * Khoá cho share / gỡ share theo thứ tự chung (03 §7): kênh (bậc 2) → dòng thành viên của người
 * gọi (bậc 3) → meeting (bậc 4). Đều `FOR SHARE`: nhiều người share song song vào cùng kênh không
 * chặn nhau, nhưng chặn được thao tác đổi trạng thái vốn khoá `FOR UPDATE` / xoá dòng — lưu trữ kênh,
 * đổi vai trò / gỡ khỏi kênh (khoá dòng kênh), gỡ khỏi org (cascade xoá dòng thành viên), xoá meeting.
 */
@Injectable()
export class MeetingSharesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async lockChannel(orgId: string, channelId: string, executor: DbExecutor) {
    const [row] = await executor
      .select({ id: channels.id, visibility: channels.visibility, archivedAt: channels.archivedAt })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.deletedAt)))
      .for('share');
    return row;
  }

  async lockChannelRole(
    channelId: string,
    userId: string,
    executor: DbExecutor,
  ): Promise<ChannelRoleValue | null> {
    const [row] = await executor
      .select({ role: channelMembers.role })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
      .for('share');
    return row?.role ?? null;
  }

  /** Meeting chưa xoá. Chờ xong việc xoá đang chạy rồi đọc LẠI (`deleted_at` mới) — read committed. */
  async lockMeeting(orgId: string, meetingId: string, executor: DbExecutor) {
    const [row] = await executor
      .select({ id: meetings.id, ownerId: meetings.ownerId })
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.orgId, orgId), isNull(meetings.deletedAt)))
      .for('share');
    return row;
  }

  /** `undefined` = đã share từ trước (ON CONFLICT DO NOTHING) — idempotent (M6b Q3). */
  async insert(
    values: { meetingId: string; channelId: string; orgId: string; sharedBy: string },
    executor: DbExecutor,
  ): Promise<{ sharedAt: Date } | undefined> {
    const [row] = await executor
      .insert(meetingShares)
      .values(values)
      .onConflictDoNothing({ target: [meetingShares.meetingId, meetingShares.channelId] })
      .returning({ sharedAt: meetingShares.sharedAt });
    return row;
  }

  async find(meetingId: string, channelId: string, executor: DbExecutor = this.db) {
    const [row] = await executor
      .select({ sharedAt: meetingShares.sharedAt })
      .from(meetingShares)
      .where(and(eq(meetingShares.meetingId, meetingId), eq(meetingShares.channelId, channelId)));
    return row;
  }

  async remove(meetingId: string, channelId: string, executor: DbExecutor): Promise<void> {
    await executor
      .delete(meetingShares)
      .where(and(eq(meetingShares.meetingId, meetingId), eq(meetingShares.channelId, channelId)));
  }
}
