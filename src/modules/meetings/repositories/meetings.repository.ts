import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
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
  type MeetingSummaryRow,
  meetingSummaries,
  transcriptSegments,
} from '../../../infra/database/schema/index.js';
import { isOrgRoleAtLeast, OrgRole } from '../../organizations/organization.policy.js';
import { visibleMeetingCandidates } from '../meeting-list-candidates.js';
import { meetingVisibleTo } from '../meeting-visibility.js';
import type {
  ChannelMeetingRow,
  MeetingPatch,
  ListChannelMeetingsParams,
  ListVisibleMeetingsParams,
  MeetingChannelRef,
  MeetingListRow,
  MeetingViewer,
  VisibleChannels,
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
   *
   * M11 B5: hai câu — (1) kênh thấy được; (2) meeting có id trong ỨNG VIÊN của các luồng có trần
   * (`visibleMeetingCandidates`). `= ANY(ARRAY(…))` ép tính ứng viên TRƯỚC (InitPlan) rồi tra PK —
   * với `IN (…)` planner từng chọn đi lùi cả index org và bỏ qua ứng viên (bài học 11). Không lọc
   * lại bằng `meetingVisibleTo` ở đây: chi phí lọc từng dòng ăn mất phần thắng; tương đương với
   * điều kiện xem dùng chung được kiểm bằng test đối chiếu (oracle) trên ma trận người xem.
   */
  async listVisible(p: ListVisibleMeetingsParams): Promise<MeetingListRow[]> {
    const n = p.limit + 1;
    const candidates = visibleMeetingCandidates(this.db, p, n, await this.visibleChannels(p));
    if (!candidates) return [];
    return this.db
      .select({ ...getTableColumns(meetings), recordedAtKey: timestampKey(meetings.recordedAt) })
      .from(meetings)
      .where(and(sql`${meetings.id} = any(array(${candidates}))`, eq(meetings.orgId, p.orgId)))
      .orderBy(desc(meetings.recordedAt), desc(meetings.id))
      .limit(n);
  }

  /** Kênh người xem thấy nội dung (chưa xoá; công khai hoặc là thành viên) + tổng số kênh của org. */
  private async visibleChannels(p: ListVisibleMeetingsParams): Promise<VisibleChannels> {
    const isMember = sql`exists (select 1 from ${channelMembers} where ${channelMembers.channelId} = ${channels.id} and ${channelMembers.userId} = ${p.viewer.userId})`;
    const [row] = await this.db
      .select({
        ids: sql<
          string[]
        >`coalesce(array_agg(${channels.id}) filter (where (${channels.visibility} = 'public' or ${isMember})${p.channelId ? sql` and ${channels.id} = ${p.channelId}` : sql``}), '{}')`,
        total: sql<number>`count(*)::int`,
      })
      .from(channels)
      .where(and(eq(channels.orgId, p.orgId), isNull(channels.deletedAt)));
    return { ids: row?.ids ?? [], total: row?.total ?? 0 };
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

  /** Đoạn transcript theo `seq` tăng dần, keyset `seq > after` trên `transcript_segments_meeting_seq_uq`. */
  listSegments(meetingId: string, afterSeq: number | undefined, limit: number) {
    return this.db
      .select({
        seq: transcriptSegments.seq,
        startMs: transcriptSegments.startMs,
        endMs: transcriptSegments.endMs,
        text: transcriptSegments.text,
        version: transcriptSegments.version,
        editedAt: transcriptSegments.editedAt,
      })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.meetingId, meetingId),
          afterSeq === undefined ? undefined : gt(transcriptSegments.seq, afterSeq),
        ),
      )
      .orderBy(asc(transcriptSegments.seq))
      .limit(limit + 1);
  }

  async findSummary(meetingId: string): Promise<MeetingSummaryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(meetingSummaries)
      .where(eq(meetingSummaries.meetingId, meetingId));
    return row;
  }

  /**
   * Chạy lại (M6 B7): lần xử lý MỚI — `attempt + 1` là fencing token mới, job của lần cũ tự bị loại.
   * Caller đã khoá dòng `FOR UPDATE` và kiểm `failed`.
   */
  async resetForRetry(meetingId: string, executor: DbExecutor): Promise<MeetingRow> {
    const [row] = await executor
      .update(meetings)
      .set({
        status: 'queued',
        attempt: sql`${meetings.attempt} + 1`,
        failureCode: null,
        failureMessage: null,
        stageToken: null,
        stageLeaseUntil: null,
      })
      .where(eq(meetings.id, meetingId))
      .returning();
    if (!row) throw new Error('resetForRetry: dòng đã khoá mà không cập nhật được');
    return row;
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

  /**
   * Sửa `recordedAt` → chép sang mọi share của meeting trong CÙNG `executor` (transaction của
   * caller, meeting đã khoá `FOR UPDATE`): danh sách theo kênh không bao giờ thấy thứ tự cũ (M11 B5).
   */
  async update(meetingId: string, patch: MeetingPatch, executor: DbExecutor): Promise<void> {
    await executor.update(meetings).set(patch).where(eq(meetings.id, meetingId));
    if (patch.recordedAt !== undefined) {
      await executor
        .update(meetingShares)
        .set({ recordedAt: patch.recordedAt })
        .where(eq(meetingShares.meetingId, meetingId));
    }
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
