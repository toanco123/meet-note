import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { meetings, meetingShares, transcriptSegments } from '../../infra/database/schema/index.js';
import { meetingVisibleTo } from '../meetings/meeting-visibility.js';
import type { SearchMeetingRow, SearchMeetingsParams } from './transcripts.types.js';

const matchesQuery = (query: string) =>
  sql`${transcriptSegments.search} @@ websearch_to_tsquery('meetnote_vi'::regconfig, ${query})`;

/** Truy vấn full-text trên `transcript_segments` (M8). Quyền xem: `meetingVisibleTo` (04 §3). */
@Injectable()
export class TranscriptsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Meeting (xem được) có đoạn khớp `query`, mới họp trước, keyset `(recorded_at DESC, id DESC)`.
   *
   * Hình dạng "MEETING TRƯỚC" (đã đo, plan M8 Q1; `pnpm bench:transcript-search`): đi meeting mới → cũ,
   * giữ meeting xem được mà `EXISTS` đoạn khớp, dừng ở `LIMIT`. Điều kiện xem nằm TRONG câu, trước
   * `LIMIT` — lọc quyền sau khi cắt trang thì trang có thể trống dù còn kết quả xem được. Hình dạng
   * "đoạn trước" (GIN gom mọi đoạn khớp rồi nối meeting) chậm hơn 30× với từ khoá phổ biến (90 ms so
   * với 3 ms, 600k đoạn) vì phải gom HẾT đoạn khớp dù chỉ cần 20 meeting; còn `EXISTS` thì planner
   * tự đổi sang semi-join qua GIN khi từ khoá hiếm. Ca xấu nhất: từ khoá vừa + người xem thấy ít
   * meeting → quét gần hết meeting của org (≈ 25 ms / 10k meeting, tỉ lệ thuận) — chặn bởi
   * `statement_timeout` (M11).
   *
   * Số đoạn khớp (`hitCount`) đếm bằng câu thứ hai CHỈ trên các meeting của trang.
   */
  async searchMeetings(p: SearchMeetingsParams): Promise<SearchMeetingRow[]> {
    const page = await this.db
      .select({
        id: meetings.id,
        title: meetings.title,
        recordedAt: meetings.recordedAt,
        recordedAtKey: timestampKey(meetings.recordedAt),
      })
      .from(meetings)
      .where(
        and(
          eq(meetings.orgId, p.orgId),
          meetingVisibleTo(p.viewer),
          sql`exists (select 1 from ${transcriptSegments} where ${transcriptSegments.meetingId} = ${meetings.id} and ${matchesQuery(p.query)})`,
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
    if (page.length === 0) return [];
    const counts = await this.db
      .select({ meetingId: transcriptSegments.meetingId, hitCount: count() })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.orgId, p.orgId),
          inArray(
            transcriptSegments.meetingId,
            page.map((m) => m.id),
          ),
          matchesQuery(p.query),
        ),
      )
      .groupBy(transcriptSegments.meetingId);
    const hits = new Map(counts.map((c) => [c.meetingId, c.hitCount]));
    return page.map((m) => ({ ...m, hitCount: hits.get(m.id) ?? 0 }));
  }
}
