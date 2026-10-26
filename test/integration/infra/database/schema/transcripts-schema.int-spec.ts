import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  meetings,
  meetingSummaries,
  notifications,
  transcriptSegments,
} from '../../../../../src/infra/database/schema/index.js';
import { insertMeeting, insertOrg, insertUser } from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

/** Bất biến của `transcript_segments` / `meeting_summaries` / cột mới của meetings (M6 B1). */
describe('Schema transcript + tóm tắt (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb(); // user worker (BYPASSRLS) — dựng dữ liệu như pipeline
  });

  afterAll(async () => {
    await t.close();
  });

  async function meetingInNewOrg() {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const meeting = await insertMeeting(t.db, org.id, owner.id);
    return { orgId: org.id, meetingId: meeting.id };
  }
  const segment = (
    m: { orgId: string; meetingId: string },
    over: Partial<typeof transcriptSegments.$inferInsert> = {},
  ) =>
    t.db.insert(transcriptSegments).values({
      meetingId: m.meetingId,
      orgId: m.orgId,
      seq: 0,
      startMs: 0,
      endMs: 1_000,
      text: 'Xin chào',
      ...over,
    });

  it('trùng (meeting_id, seq) → 23505 đúng constraint; end < start / seq âm → 23514', async () => {
    const m = await meetingInNewOrg();
    await segment(m);
    const [dup, backwards, negative] = [
      await pgErrorOf(segment(m)),
      await pgErrorOf(segment(m, { seq: 1, startMs: 5_000, endMs: 4_000 })),
      await pgErrorOf(segment(m, { seq: -1 })),
    ];
    expect([
      [dup?.code, dup?.constraint],
      [backwards?.code, backwards?.constraint],
      [negative?.code, negative?.constraint],
    ]).toEqual([
      ['23505', 'transcript_segments_meeting_seq_uq'],
      ['23514', 'transcript_segments_time_ck'],
      ['23514', 'transcript_segments_seq_ck'],
    ]);
  });

  it('composite FK: org_id lệch với meeting → 23503 (đoạn / tóm tắt không gắn chéo tổ chức)', async () => {
    const [m, other] = [await meetingInNewOrg(), await meetingInNewOrg()];
    const wrongSegment = await pgErrorOf(segment({ meetingId: m.meetingId, orgId: other.orgId }));
    const wrongSummary = await pgErrorOf(
      t.db.insert(meetingSummaries).values({
        meetingId: m.meetingId,
        orgId: other.orgId,
        content: {},
        model: 'x',
        promptVersion: 'v1',
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
    expect([wrongSegment?.constraint, wrongSummary?.constraint]).toEqual([
      'transcript_segments_meeting_fk',
      'meeting_summaries_meeting_fk',
    ]);
  });

  it('xoá cứng meeting → đoạn + tóm tắt bị xoá theo (cascade)', async () => {
    const m = await meetingInNewOrg();
    await segment(m);
    await t.db.insert(meetingSummaries).values({
      ...m,
      content: { overview: 'x' },
      model: 'fake',
      promptVersion: 'v1',
      inputTokens: 1,
      outputTokens: 1,
    });
    await t.db.delete(meetings).where(eq(meetings.id, m.meetingId));
    const left = await t.db.execute<{ n: number }>(sql`
      select (select count(*) from transcript_segments where meeting_id = ${m.meetingId})
           + (select count(*) from meeting_summaries where meeting_id = ${m.meetingId}) as n`);
    expect(Number(left.rows[0]?.n)).toBe(0);
  });

  it('cột `search` (generated, meetnote_vi): "ke hoach" và "kế hoạch" cùng tìm ra đoạn có dấu', async () => {
    const m = await meetingInNewOrg();
    await segment(m, { text: 'Chúng ta chốt kế hoạch quý ba' });
    await segment(m, { seq: 1, text: 'Ngân sách marketing' });
    const find = async (q: string) =>
      (
        await t.db
          .select({ seq: transcriptSegments.seq })
          .from(transcriptSegments)
          .where(
            sql`${transcriptSegments.meetingId} = ${m.meetingId} and ${transcriptSegments.search} @@ websearch_to_tsquery('meetnote_vi', ${q})`,
          )
      ).map((r) => r.seq);
    expect([await find('ke hoach'), await find('kế hoạch'), await find('ngan sach')]).toEqual([
      [0],
      [0],
      [1],
    ]);
  });

  // Đột biến: bỏ policy của transcript_segments → user api thấy đoạn của tổ chức khác.
  it('RLS: user của api không ngữ cảnh / khác tổ chức không thấy đoạn; đúng tổ chức thì thấy', async () => {
    const [m, other] = [await meetingInNewOrg(), await meetingInNewOrg()];
    await segment(m);
    const api = createTestDb(1, process.env.DATABASE_URL); // max 1 → set_config áp cho câu sau
    try {
      const count = async (orgId: string) => {
        await api.db.execute(sql`select set_config('app.org_id', ${orgId}, false)`);
        const rows = await api.db
          .select({ seq: transcriptSegments.seq })
          .from(transcriptSegments)
          .where(eq(transcriptSegments.meetingId, m.meetingId));
        return rows.length;
      };
      expect([await count(''), await count(other.orgId), await count(m.orgId)]).toEqual([0, 0, 1]);
    } finally {
      await api.close();
    }
  });

  it('failure_code chỉ nhận mã đã định nghĩa; notifications nhận loại meeting.completed / failed', async () => {
    const m = await meetingInNewOrg();
    const bad = await pgErrorOf(
      t.db
        .update(meetings)
        .set({ failureCode: 'BOGUS' as never })
        .where(eq(meetings.id, m.meetingId)),
    );
    await t.db
      .update(meetings)
      .set({ status: 'failed', failureCode: 'MEDIA_NO_AUDIO' })
      .where(eq(meetings.id, m.meetingId));
    const owner = (await t.db.select().from(meetings).where(eq(meetings.id, m.meetingId)))[0]!
      .ownerId!;
    await t.db.insert(notifications).values([
      { userId: owner, type: 'meeting.completed', payload: {} },
      { userId: owner, type: 'meeting.failed', payload: {} },
    ]);
    expect([bad?.code, bad?.constraint]).toEqual(['23514', 'meetings_failure_code_ck']);
  });

  // Đúng HÌNH DẠNG câu quét thật (cũ nhất trước, theo lô): không có ORDER BY thì planner được chọn
  // bất kỳ index partial nào khớp điều kiện (lần đầu: meetings_org_owner_recorded_idx).
  it('truy vấn quét kẹt dùng được index partial `meetings_stuck_idx`', async () => {
    const plan = await t.db.transaction(async (tx) => {
      // Ít dòng thì planner luôn chọn seq scan → tắt để hỏi "index có dùng được không".
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`explain
        select id from ${meetings}
        where ${meetings.status} in ('queued', 'preprocessing', 'transcribing', 'summarizing')
          and ${meetings.deletedAt} is null and ${meetings.updatedAt} < now() - interval '5 minutes'
        order by ${meetings.updatedAt} limit 100`);
    });
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('meetings_stuck_idx');
  });
});
