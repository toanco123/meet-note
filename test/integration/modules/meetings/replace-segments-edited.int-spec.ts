import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transcriptSegments } from '../../../../src/infra/database/schema/index.js';
import { MeetingPipelineRepository } from '../../../../src/modules/meetings/repositories/meeting-pipeline.repository.js';
import { TranscriptsRepository } from '../../../../src/modules/transcripts/transcripts.repository.js';
import { insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/**
 * Invariant M13 Q4: `replaceSegments` không bao giờ xoá đoạn đã sửa tay. Viết ở mức repository —
 * không cần ffmpeg / whisper, nên chạy được cả ở máy không có chúng.
 */
describe('MeetingPipelineRepository.replaceSegments × đoạn đã sửa (Postgres thật)', () => {
  let t: TestDb;
  let pipeline: MeetingPipelineRepository;
  let transcripts: TranscriptsRepository;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    t = createTestDb();
    pipeline = new MeetingPipelineRepository(t.db);
    transcripts = new TranscriptsRepository(t.db);
    userId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, userId)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  const input = (...texts: string[]) =>
    texts.map((text, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text }));
  const textsOf = async (meetingId: string) =>
    (
      await t.db
        .select({ seq: transcriptSegments.seq, text: transcriptSegments.text })
        .from(transcriptSegments)
        .where(eq(transcriptSegments.meetingId, meetingId))
    )
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.text);

  it('chưa ai sửa → thay thế bình thường (chạy lại vẫn ra đúng một bộ đoạn)', async () => {
    const m = await insertMeeting(t.db, orgId, userId);
    await pipeline.replaceSegments(t.db, { id: m.id, orgId }, input('a', 'b'));
    await pipeline.replaceSegments(t.db, { id: m.id, orgId }, input('c', 'd', 'e'));
    expect(await textsOf(m.id)).toEqual(['c', 'd', 'e']);
  });

  it('đã có đoạn sửa tay → ném lỗi, KHÔNG xoá, KHÔNG chèn; bản sửa còn nguyên', async () => {
    const m = await insertMeeting(t.db, orgId, userId);
    await pipeline.replaceSegments(t.db, { id: m.id, orgId }, input('gốc 0', 'gốc 1'));
    await transcripts.editSegment(m.id, 1, 1, 'đã sửa tay', userId);

    await expect(
      pipeline.replaceSegments(t.db, { id: m.id, orgId }, input('mới 0', 'mới 1', 'mới 2')),
    ).rejects.toThrow(/đã sửa tay \(seq 1\)/);
    expect(await textsOf(m.id)).toEqual(['gốc 0', 'đã sửa tay']);
  });

  it('chỉ tính meeting NÀY: meeting khác đã sửa không chặn meeting chưa sửa', async () => {
    const edited = await insertMeeting(t.db, orgId, userId);
    await pipeline.replaceSegments(t.db, { id: edited.id, orgId }, input('x'));
    await transcripts.editSegment(edited.id, 0, 1, 'y', userId);
    const clean = await insertMeeting(t.db, orgId, userId);
    await pipeline.replaceSegments(t.db, { id: clean.id, orgId }, input('p'));
    await pipeline.replaceSegments(t.db, { id: clean.id, orgId }, input('q'));
    expect(await textsOf(clean.id)).toEqual(['q']);
  });

  it('sửa trong transaction rollback không để lại dấu vết → replace vẫn được', async () => {
    const m = await insertMeeting(t.db, orgId, userId);
    await pipeline.replaceSegments(t.db, { id: m.id, orgId }, input('một'));
    await expect(
      t.db.transaction(async (tx) => {
        await transcripts.editSegment(m.id, 0, 1, 'tạm', userId, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await pipeline.replaceSegments(t.db, { id: m.id, orgId }, input('hai'));
    expect(await textsOf(m.id)).toEqual(['hai']);
  });
});
