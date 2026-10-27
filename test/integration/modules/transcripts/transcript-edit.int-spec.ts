import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../src/common/errors/pg-error.js';
import { transcriptSegments } from '../../../../src/infra/database/schema/index.js';
import { TranscriptsRepository } from '../../../../src/modules/transcripts/transcripts.repository.js';
import { insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/** Sửa một đoạn bằng khoá lạc quan `version` (M13 B1), trên Postgres thật. */
describe('TranscriptsRepository.editSegment (Postgres thật)', () => {
  let t: TestDb;
  let repo: TranscriptsRepository;
  let orgId: string;
  let ownerId: string;

  beforeAll(async () => {
    t = createTestDb();
    repo = new TranscriptsRepository(t.db);
    ownerId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, ownerId)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  async function meetingWith(...texts: string[]): Promise<string> {
    const m = await insertMeeting(t.db, orgId, ownerId);
    await t.db.insert(transcriptSegments).values(
      texts.map((text, seq) => ({
        meetingId: m.id,
        orgId,
        seq,
        startMs: seq * 1_000,
        endMs: seq * 1_000 + 900,
        text,
      })),
    );
    return m.id;
  }
  const row = async (meetingId: string, seq: number) =>
    (
      await t.db
        .select()
        .from(transcriptSegments)
        .where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.seq, seq)))
    )[0]!;

  it('đúng version → text mới, version + 1, edited_at / edited_by được đặt; đoạn khác không đụng', async () => {
    const id = await meetingWith('kế hoạch quý ba', 'đoạn hai');
    const before = await row(id, 0);
    expect([before.version, before.editedAt, before.editedBy]).toEqual([1, null, null]);

    const out = await repo.editSegment(id, 0, 1, 'kế toán quý ba', ownerId);
    expect(out.kind).toBe('updated');
    if (out.kind !== 'updated') return;
    expect(out.segment).toMatchObject({
      seq: 0,
      startMs: 0,
      endMs: 900,
      text: 'kế toán quý ba',
      version: 2,
    });
    const after = await row(id, 0);
    expect([after.text, after.version, after.editedBy]).toEqual(['kế toán quý ba', 2, ownerId]);
    expect(after.editedAt).toBeInstanceOf(Date);
    expect(await row(id, 1)).toMatchObject({ text: 'đoạn hai', version: 1, editedAt: null });
  });

  it('sai version → version_mismatch kèm version hiện tại, dữ liệu NGUYÊN', async () => {
    const id = await meetingWith('gốc');
    await repo.editSegment(id, 0, 1, 'bản hai', ownerId); // → version 2
    const stale = await repo.editSegment(id, 0, 1, 'ghi đè mù', ownerId);
    expect(stale).toEqual({ kind: 'version_mismatch', currentVersion: 2 });
    const future = await repo.editSegment(id, 0, 99, 'version tương lai', ownerId);
    expect(future).toEqual({ kind: 'version_mismatch', currentVersion: 2 });
    expect(await row(id, 0)).toMatchObject({ text: 'bản hai', version: 2 });
  });

  it('đoạn không tồn tại (seq lạ / meeting lạ) → not_found, không phải version_mismatch', async () => {
    const id = await meetingWith('một đoạn');
    expect(await repo.editSegment(id, 5, 1, 'x', ownerId)).toEqual({ kind: 'not_found' });
    expect(
      await repo.editSegment('01a16185-7123-7052-b52a-dfddd7dfb0db', 0, 1, 'x', ownerId),
    ).toEqual({ kind: 'not_found' });
  });

  it('chuỗi phụ thuộc: sửa liên tiếp bằng version vừa nhận → 2, 3, 4', async () => {
    const id = await meetingWith('a');
    let version = 1;
    for (const text of ['b', 'c', 'd']) {
      const out = await repo.editSegment(id, 0, version, text, ownerId);
      expect(out.kind).toBe('updated');
      if (out.kind === 'updated') version = out.segment.version;
    }
    expect(version).toBe(4);
  });

  // ĐỘT BIẾN: bỏ `eq(version, expected)` khỏi WHERE → cả hai thắng, "thắng sau" ghi đè "thắng trước".
  it('CONCURRENCY: 10 lần sửa song song cùng version → ĐÚNG MỘT thành công, chín lần lệch', async () => {
    const id = await meetingWith('gốc');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.editSegment(id, 0, 1, `người ${i}`, ownerId)),
    );
    const winners = results.filter((r) => r.kind === 'updated');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'version_mismatch')).toHaveLength(9);
    const final = await row(id, 0);
    expect(final.version).toBe(2); // đúng một lần tăng
    expect(winners[0]).toMatchObject({ segment: { text: final.text } }); // bản lưu = bản của người thắng
  });

  it('cột `search` (generated) theo text: từ mới tìm ra, từ cũ không còn', async () => {
    const id = await meetingWith('chốt kế hoạch ra mắt');
    const matches = async (q: string) =>
      (
        await t.db.execute<{ n: number }>(
          // eslint-disable-next-line -- câu thô để kiểm đúng cột generated
          `select count(*)::int as n from transcript_segments where meeting_id = '${id}' and search @@ websearch_to_tsquery('meetnote_vi'::regconfig, '${q}')` as never,
        )
      ).rows[0]!.n;
    expect([await matches('ke hoach'), await matches('ke toan')]).toEqual([1, 0]);
    await repo.editSegment(id, 0, 1, 'chốt kế toán ra mắt', ownerId);
    expect([await matches('ke hoach'), await matches('ke toan')]).toEqual([0, 1]);
  });

  it('CHECK: text rỗng → 23514 transcript_segments_text_ck; version 0 → transcript_segments_version_ck', async () => {
    const id = await meetingWith('ổn');
    const fail = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return findPgError(e);
      }
      throw new Error('kỳ vọng bị từ chối');
    };
    const empty = await fail(repo.editSegment(id, 0, 1, '', ownerId));
    expect([empty?.code, empty?.constraint]).toEqual(['23514', 'transcript_segments_text_ck']);
    const zero = await fail(
      t.db
        .update(transcriptSegments)
        .set({ version: 0 })
        .where(eq(transcriptSegments.meetingId, id)),
    );
    expect([zero?.code, zero?.constraint]).toEqual(['23514', 'transcript_segments_version_ck']);
    expect((await row(id, 0)).text).toBe('ổn'); // câu lỗi không để lại dấu vết
  });

  it('người sửa bị xoá → edited_by về NULL (SET NULL), đoạn và version còn nguyên', async () => {
    const editor = await insertUser(t.db);
    const id = await meetingWith('x');
    await repo.editSegment(id, 0, 1, 'y', editor.id);
    await t.db.execute(`delete from users where id = '${editor.id}'` as never);
    expect(await row(id, 0)).toMatchObject({ text: 'y', version: 2, editedBy: null });
  });
});
