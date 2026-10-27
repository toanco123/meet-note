import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { auditLogs, transcriptSegments } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

/** `PATCH …/transcript/segments/:seq` qua HTTP (M13 B3): If-Match / ETag, 412, 428, quyền, race. */
describe('PATCH /orgs/:orgId/meetings/:meetingId/transcript/segments/:seq (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  let author: TestUser;
  let peer: TestUser;
  let admin: TestUser;
  let stranger: TestUser;
  let channelId: string;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const url = (id: string, seq: number | string = 0) =>
    `/v1/orgs/${orgId}/meetings/${id}/transcript/segments/${seq}`;

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, author, peer, admin, stranger] = (await Promise.all(
      Array.from({ length: 5 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Sửa HTTP' }).expect(201))
      .body.data.id as string;
    await addMember(db, orgId, author.id);
    await addMember(db, orgId, peer.id);
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, stranger.id);
    channelId = (await insertChannel(db, orgId, owner.id, { visibility: 'public' })).id;
    await addChannelMember(db, { id: channelId }, orgId, peer.id);
  });

  afterAll(async () => {
    await app.close();
  });

  async function meeting(
    ownerId: string | null,
    opts: { status?: 'completed' | 'summarizing'; shared?: boolean } = {},
  ): Promise<string> {
    const m = await insertMeeting(db, orgId, ownerId, { status: opts.status ?? 'completed' });
    await db.insert(transcriptSegments).values(
      ['kế hoạch quý ba', 'ngân sách'].map((text, seq) => ({
        meetingId: m.id,
        orgId,
        seq,
        startMs: seq * 1000,
        endMs: seq * 1000 + 900,
        text,
      })),
    );
    if (opts.shared !== false && ownerId) await shareMeeting(db, orgId, m.id, channelId, ownerId);
    return m.id;
  }
  const patch = (
    u: TestUser,
    id: string,
    seq: number | string,
    ifMatch: string | null,
    body: unknown,
  ) => {
    const req = http().patch(url(id, seq)).set(as(u));
    if (ifMatch !== null) req.set('If-Match', ifMatch);
    return req.send(body as object);
  };
  const segments = async (id: string) =>
    (await http().get(`/v1/orgs/${orgId}/meetings/${id}/transcript`).set(as(author)).expect(200))
      .body.data as Array<{ seq: number; text: string; version: number; editedAt: string | null }>;

  it('200: đoạn mới + ETag "2"; GET transcript thấy version / editedAt; đoạn khác nguyên', async () => {
    const id = await meeting(author.id);
    const before = await segments(id);
    expect(before.map((s) => [s.version, s.editedAt])).toEqual([
      [1, null],
      [1, null],
    ]);

    const res = await patch(author, id, 0, '"1"', { text: '  kế toán quý ba  ' }).expect(200);
    expect(res.body.data).toMatchObject({
      seq: 0,
      startMs: 0,
      endMs: 900,
      text: 'kế toán quý ba', // đã trim
      version: 2,
    });
    expect(typeof res.body.data.editedAt).toBe('string');
    expect(res.headers.etag).toBe('"2"');
    expect(res.headers['cache-control']).toBe('private, no-store');

    const after = await segments(id);
    expect(after[0]).toMatchObject({ text: 'kế toán quý ba', version: 2 });
    expect(after[1]).toMatchObject({ text: 'ngân sách', version: 1, editedAt: null });
  });

  it('dùng ETag của lần trước cho lần sau; gửi lại version cũ → 412 và dữ liệu nguyên', async () => {
    const id = await meeting(author.id);
    const first = await patch(author, id, 0, '"1"', { text: 'bản hai' }).expect(200);
    await patch(author, id, 0, first.headers.etag as string, { text: 'bản ba' }).expect(200);
    const stale = await patch(author, id, 0, '"1"', { text: 'ghi đè mù' }).expect(412);
    expect(stale.body.error.code).toBe('TRANSCRIPT_VERSION_MISMATCH');
    expect((await segments(id))[0]).toMatchObject({ text: 'bản ba', version: 3 });
  });

  it('If-Match: thiếu → 428; sai dạng (weak, *, danh sách, 0, chữ) → 400; chấp nhận 3 trần', async () => {
    const id = await meeting(author.id);
    const missing = await patch(author, id, 0, null, { text: 'x' }).expect(428);
    expect(missing.body.error.code).toBe('TRANSCRIPT_IF_MATCH_REQUIRED');
    for (const bad of ['W/"1"', '*', '"1", "2"', '"0"', 'abc'])
      await patch(author, id, 0, bad, { text: 'x' }).expect(400);
    await patch(author, id, 0, '1', { text: 'dạng trần' }).expect(200);
  });

  it('validate: body thiếu / rỗng / toàn khoảng trắng / quá 5000 / sai kiểu → 400; đúng 5000 → 200', async () => {
    const id = await meeting(author.id);
    const bodies = [{}, { text: '' }, { text: '   ' }, { text: 'a'.repeat(5001) }, { text: 5 }];
    const badBodies = await Promise.all(
      bodies.map(async (body) => (await patch(author, id, 0, '"1"', body)).status),
    );
    const badSeqs = await Promise.all(
      ['-1', 'abc', '1.5', '2147483648'].map(
        async (seq) => (await patch(author, id, seq, '"1"', { text: 'x' })).status,
      ),
    );
    const badId = (await patch(author, 'khong-phai-uuid', 0, '"1"', { text: 'x' })).status;
    expect([...badBodies, ...badSeqs, badId].every((st) => st === 400)).toBe(true);
    const maxLength = await patch(author, id, 0, '"1"', { text: 'a'.repeat(5000) });
    expect(maxLength.status).toBe(200);
  });

  it('bảng quyền: chủ 200; member xem được 403; OrgAdm + meeting có chủ 403; không xem được 404; chưa xong 409; đoạn lạ 404; chưa đăng nhập 401', async () => {
    const shared = await meeting(author.id);
    const privateOne = await meeting(author.id, { shared: false });
    const running = await meeting(author.id, { status: 'summarizing' });
    const status = async (req: request.Test) => (await req).status;
    expect([
      await status(patch(peer, shared, 0, '"1"', { text: 'x' })),
      await status(patch(admin, shared, 0, '"1"', { text: 'x' })),
      await status(patch(stranger, privateOne, 0, '"1"', { text: 'x' })),
      await status(patch(author, running, 0, '"1"', { text: 'x' })),
      await status(patch(author, shared, 9, '"1"', { text: 'x' })),
      await status(http().patch(url(shared)).set('If-Match', '"1"').send({ text: 'x' })),
      await status(patch(author, shared, 0, '"1"', { text: 'x' })),
    ]).toEqual([403, 403, 404, 409, 404, 401, 200]);
  });

  it('meeting không chủ: Admin org sửa được + audit; member thường 404 (không xem được)', async () => {
    const id = await meeting(null, { shared: false });
    await patch(admin, id, 1, '"1"', { text: 'admin sửa' }).expect(200);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetId, id), eq(auditLogs.action, 'transcript.segment.edited')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ seq: 1, fromVersion: 1, toVersion: 2 });
    await patch(peer, id, 1, '"2"', { text: 'x' }).expect(404);
  });

  // ĐÂY là kịch bản của mốc: hai người cùng mở đoạn ở version 1, cùng bấm lưu.
  it('RACE qua HTTP: 6 request cùng If-Match "1" → đúng MỘT 200, năm 412, bản lưu là của người thắng', async () => {
    const id = await meeting(null, { shared: false });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => patch(admin, id, 0, '"1"', { text: `bản ${i}` })),
    );
    const wins = results.filter((r) => r.status === 200);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      200, 412, 412, 412, 412, 412,
    ]);
    const [saved] = await db
      .select({ text: transcriptSegments.text, version: transcriptSegments.version })
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.meetingId, id), eq(transcriptSegments.seq, 0)));
    expect(saved).toEqual({ text: wins[0]!.body.data.text, version: 2 });
  });
});
