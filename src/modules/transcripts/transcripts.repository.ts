import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { meetings, meetingShares, transcriptSegments } from '../../infra/database/schema/index.js';
import { meetingVisibleTo } from '../meetings/meeting-visibility.js';
import type {
  SearchHitRow,
  SearchMeetingRow,
  SearchMeetingsParams,
  SubtitleCue,
} from './transcripts.types.js';

const matchesQuery = (query: string) =>
  sql`${transcriptSegments.search} @@ websearch_to_tsquery('meetnote_vi'::regconfig, ${query})`;

/**
 * Dấu đánh dấu từ khoá trong đoạn trích: ký tự điều khiển U+0001 / U+0002, KHÔNG phải HTML. Transcript
 * là chữ người nói (hoặc sửa tay) — có thể chứa `<script>`; nếu `ts_headline` chèn `<b>` thì client dễ
 * gán thẳng vào `innerHTML`. Ký tự điều khiển không bao giờ có trong lời nói và vô hại nếu hiển thị.
 */
export const SNIPPET_START = '\u0001';
export const SNIPPET_STOP = '\u0002';
// ShortWord=0: mặc định (3) cắt từ ngắn ở ĐẦU / CUỐI đoạn trích — tiếng Việt toàn từ ngắn ("quý ba" →
// "quý", "ra mắt" mất "ra"). Lần đầu gặp ở e2e: snippet mất chữ cuối câu.
const HEADLINE_OPTIONS = `StartSel=${SNIPPET_START}, StopSel=${SNIPPET_STOP}, MaxWords=35, MinWords=15, ShortWord=0, MaxFragments=1`;

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

  /**
   * Tối đa `perMeeting` đoạn khớp ĐẦU TIÊN (theo `seq`) của mỗi meeting trong trang, kèm đoạn trích.
   * `ts_headline` đọc lại và phân tích văn bản gốc — chậm hơn truy vấn GIN cả bậc — nên chỉ chạy ở
   * lớp ngoài, trên ≤ `perMeeting` × (số meeting của trang) dòng; không bao giờ trên mọi đoạn khớp.
   */
  async findHits(
    orgId: string,
    meetingIds: string[],
    query: string,
    perMeeting: number,
  ): Promise<SearchHitRow[]> {
    if (meetingIds.length === 0) return [];
    const ranked = this.db
      .select({
        meetingId: transcriptSegments.meetingId,
        seq: transcriptSegments.seq,
        startMs: transcriptSegments.startMs,
        endMs: transcriptSegments.endMs,
        text: transcriptSegments.text,
        rn: sql<number>`row_number() over (partition by ${transcriptSegments.meetingId} order by ${transcriptSegments.seq})`.as(
          'rn',
        ),
      })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.orgId, orgId),
          inArray(transcriptSegments.meetingId, meetingIds),
          matchesQuery(query),
        ),
      )
      .as('ranked');
    return this.db
      .select({
        meetingId: ranked.meetingId,
        seq: ranked.seq,
        startMs: ranked.startMs,
        endMs: ranked.endMs,
        snippet: sql<string>`ts_headline('meetnote_vi'::regconfig, ${ranked.text}, websearch_to_tsquery('meetnote_vi'::regconfig, ${query}), ${HEADLINE_OPTIONS})`,
      })
      .from(ranked)
      .where(sql`${ranked.rn} <= ${perMeeting}`)
      .orderBy(asc(ranked.meetingId), asc(ranked.seq));
  }

  /**
   * Một lô đoạn theo `seq` tăng dần (`seq > afterSeq`) cho xuất file. Mỗi lô là MỘT câu truy vấn độc
   * lập — connection được trả về pool ngay sau lô; không giữ transaction / cursor suốt lúc client tải
   * chậm (`idle_in_transaction_session_timeout` 30 s của M11 sẽ cắt, và pool cạn).
   */
  segmentBatch(
    meetingId: string,
    afterSeq: number,
    limit: number,
  ): Promise<Array<SubtitleCue & { seq: number }>> {
    return this.db
      .select({
        seq: transcriptSegments.seq,
        startMs: transcriptSegments.startMs,
        endMs: transcriptSegments.endMs,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.meetingId, meetingId), gt(transcriptSegments.seq, afterSeq)))
      .orderBy(asc(transcriptSegments.seq))
      .limit(limit);
  }
}
