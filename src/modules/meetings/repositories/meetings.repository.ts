import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import { timestampKey } from '../../../common/pagination/keys.js';
import {
  channelMembers,
  channels,
  type MeetingRow,
  meetings,
  meetingShares,
} from '../../../infra/database/schema/index.js';
import { isOrgRoleAtLeast, OrgRole } from '../../organizations/organization.policy.js';
import { meetingVisibleTo } from '../meeting-visibility.js';
import type {
  ChannelMeetingRow,
  MeetingPatch,
  ListChannelMeetingsParams,
  ListVisibleMeetingsParams,
  MeetingChannelRef,
  MeetingListRow,
  MeetingViewer,
} from '../meetings.types.js';

@Injectable()
export class MeetingsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insert(values: typeof meetings.$inferInsert, executor: DbExecutor): Promise<MeetingRow> {
    const [row] = await executor.insert(meetings).values(values).returning();
    if (!row) throw new Error('INSERT meetings không trả về dòng nào');
    return row;
  }

  async findById(meetingId: string): Promise<MeetingRow | undefined> {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.id, meetingId));
    return row;
  }

  /** Meeting mà `viewer` được xem (04 §3); không xem được = không tồn tại (404). */
  async findVisible(
    orgId: string,
    viewer: MeetingViewer,
    meetingId: string,
  ): Promise<MeetingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.orgId, orgId), meetingVisibleTo(viewer)));
    return row;
  }

  /**
   * Danh sách meeting xem được, mới họp trước: keyset `(recorded_at DESC, id DESC)`. Lấy `limit + 1`
   * dòng để `toPage` biết còn trang sau. `id` là tie-breaker: nhiều meeting cùng `recorded_at`.
   */
  listVisible(p: ListVisibleMeetingsParams): Promise<MeetingListRow[]> {
    return this.db
      .select({ ...getTableColumns(meetings), recordedAtKey: timestampKey(meetings.recordedAt) })
      .from(meetings)
      .where(
        and(
          eq(meetings.orgId, p.orgId),
          meetingVisibleTo(p.viewer),
          p.status ? eq(meetings.status, p.status) : undefined,
          p.from ? gte(meetings.recordedAt, p.from) : undefined,
          p.to ? lt(meetings.recordedAt, p.to) : undefined,
          p.channelId
            ? sql`exists (select 1 from ${meetingShares} where ${meetingShares.meetingId} = ${meetings.id} and ${meetingShares.channelId} = ${p.channelId})`
            : undefined,
          p.after
            ? sql`(${meetings.recordedAt}, ${meetings.id}) < (${p.after.recordedAt}::timestamptz, ${p.after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(meetings.recordedAt), desc(meetings.id))
      .limit(p.limit + 1);
  }

  /**
   * Các kênh (chưa xoá) chứa meeting mà người xem THẤY ĐƯỢC metadata — cùng quy tắc `channel.read`
   * của M4: thành viên, kênh công khai, hoặc OrgAdm (thấy metadata kênh riêng tư, D2).
   */
  listVisibleChannels(meetingId: string, viewer: MeetingViewer): Promise<MeetingChannelRef[]> {
    const isOrgAdmin = isOrgRoleAtLeast(viewer.orgRole, OrgRole.Admin);
    return this.db
      .select({ id: channels.id, name: channels.name })
      .from(meetingShares)
      .innerJoin(channels, eq(channels.id, meetingShares.channelId))
      .leftJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, viewer.userId)),
      )
      .where(
        and(
          eq(meetingShares.meetingId, meetingId),
          isNull(channels.deletedAt),
          isOrgAdmin
            ? undefined
            : or(eq(channels.visibility, 'public'), isNotNull(channelMembers.userId)),
        ),
      )
      .orderBy(asc(channels.name));
  }

  /**
   * Meeting (chưa xoá) share vào MỘT kênh, mới share trước. Không ghép điều kiện xem: guard đã kiểm
   * người gọi đọc được nội dung kênh (`channel.content.read`), và kênh chưa xoá → mọi meeting trong
   * kênh đều xem được theo điều 2 / 3 của 04 §3. Index `meeting_shares_channel_shared_idx`.
   */
  listByChannel(p: ListChannelMeetingsParams): Promise<ChannelMeetingRow[]> {
    return this.db
      .select({
        ...getTableColumns(meetings),
        sharedAt: meetingShares.sharedAt,
        sharedAtKey: timestampKey(meetingShares.sharedAt),
      })
      .from(meetingShares)
      .innerJoin(meetings, eq(meetings.id, meetingShares.meetingId))
      .where(
        and(
          eq(meetingShares.channelId, p.channelId),
          eq(meetingShares.orgId, p.orgId),
          isNull(meetings.deletedAt),
          p.after
            ? sql`(${meetingShares.sharedAt}, ${meetingShares.meetingId}) < (${p.after.sharedAt}::timestamptz, ${p.after.meetingId}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(meetingShares.sharedAt), desc(meetingShares.meetingId))
      .limit(p.limit + 1);
  }

  /** Bậc 4 của thứ tự khoá chung. Meeting đã xoá → `undefined` (đọc lại sau khi chờ khoá). */
  async lockForUpdate(
    orgId: string,
    meetingId: string,
    executor: DbExecutor,
  ): Promise<MeetingRow | undefined> {
    const [row] = await executor
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.orgId, orgId), isNull(meetings.deletedAt)))
      .for('update');
    return row;
  }

  async update(meetingId: string, patch: MeetingPatch, executor: DbExecutor): Promise<void> {
    await executor.update(meetings).set(patch).where(eq(meetings.id, meetingId));
  }

  /** Xoá MỀM (Q6): share giữ nguyên nhưng hết hiệu lực vì điều kiện xem đòi `deleted_at IS NULL`. */
  async softDelete(meetingId: string, executor: DbExecutor): Promise<void> {
    await executor
      .update(meetings)
      .set({ deletedAt: sql`now()` })
      .where(eq(meetings.id, meetingId));
  }

  /** Trong `meetingIds`, những meeting đang share vào kênh này (realtime: kiểm lại khi kênh đổi). */
  async filterSharedInChannel(channelId: string, meetingIds: string[]): Promise<string[]> {
    if (meetingIds.length === 0) return [];
    const rows = await this.db
      .select({ id: meetingShares.meetingId })
      .from(meetingShares)
      .where(
        and(eq(meetingShares.channelId, channelId), inArray(meetingShares.meetingId, meetingIds)),
      );
    return rows.map((r) => r.id);
  }

  /** Trong `meetingIds`, những meeting thuộc tổ chức này (realtime: kiểm lại khi xoá tổ chức). */
  async filterInOrg(orgId: string, meetingIds: string[]): Promise<string[]> {
    if (meetingIds.length === 0) return [];
    const rows = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.orgId, orgId), inArray(meetings.id, meetingIds)));
    return rows.map((r) => r.id);
  }
}
