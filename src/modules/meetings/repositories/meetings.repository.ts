import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
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
}
