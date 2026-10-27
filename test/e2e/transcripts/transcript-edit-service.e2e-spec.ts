import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../../../src/common/errors/app.exception.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { OrgContext } from '../../../src/infra/database/org-context.js';
import { auditLogs, transcriptSegments } from '../../../src/infra/database/schema/index.js';
import type { OrgMembershipContext } from '../../../src/modules/organizations/organizations.types.js';
import { TranscriptsService } from '../../../src/modules/transcripts/transcripts.service.js';
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

/**
 * `TranscriptsService.editSegment` (M13 B2) gọi thẳng service: thứ tự kiểm tra (404 → 403 → 409 →
 * 404/412), audit chỉ khi không phải chủ và KHÔNG chứa nội dung. Header HTTP kiểm ở B3.
 */
describe('TranscriptsService.editSegment (e2e, service)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser; // Owner org
  let author: TestUser; // member, chủ các meeting
  let peer: TestUser; // member, xem được qua kênh công khai
  let admin: TestUser; // Admin org
  let stranger: TestUser; // member, KHÔNG xem được meeting riêng của author
  let channelId: string;

  const membership = (u: TestUser, role: 'owner' | 'admin' | 'member'): OrgMembershipContext =>
    ({ orgId, role, userId: u.id }) as unknown as OrgMembershipContext;
  const ctx = (u: TestUser) => ({ actorId: u.id, requestId: 'req-test', ip: '127.0.0.1' });

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, author, peer, admin, stranger] = (await Promise.all(
      Array.from({ length: 5 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
    orgId = (
      await request(app.getHttpServer())
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Sửa transcript' })
        .expect(201)
    ).body.data.id as string;
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

  /** Meeting do `ownerId` sở hữu với 2 đoạn; `shared` = đã chia sẻ vào kênh công khai. */
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
  const edit = (
    u: TestUser,
    role: 'owner' | 'admin' | 'member',
    id: string,
    seq: number,
    version: number,
    text: string,
  ) =>
    OrgContext.runInOrg(
      orgId,
      async () =>
        await app
          .get(TranscriptsService)
          .editSegment(membership(u, role), ctx(u), id, seq, version, text),
    );
  const statusOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      if (e instanceof AppException) return e.getStatus();
      throw e;
    }
  };
  const auditsOf = (meetingId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.targetId, meetingId), eq(auditLogs.action, 'transcript.segment.edited')),
      );

  it('chủ sửa đúng version → đoạn mới (version 2); KHÔNG audit khi chủ tự sửa', async () => {
    const id = await meeting(author.id);
    const seg = await edit(author, 'member', id, 0, 1, 'kế toán quý ba');
    expect(seg).toMatchObject({ seq: 0, text: 'kế toán quý ba', version: 2 });
    expect(await auditsOf(id)).toHaveLength(0);
  });

  it('thứ tự lỗi: không xem được 404 → xem được mà không phải chủ 403 → chưa xong 409 → đoạn lạ 404 → lệch 412', async () => {
    const privateOne = await meeting(author.id, { shared: false });
    const shared = await meeting(author.id);
    const running = await meeting(author.id, { status: 'summarizing' });
    const statuses = [
      await statusOf(edit(stranger, 'member', privateOne, 0, 1, 'x')), // không xem được
      await statusOf(edit(peer, 'member', shared, 0, 1, 'x')), // xem được, không phải chủ
      await statusOf(edit(admin, 'admin', shared, 0, 1, 'x')), // OrgAdm không đụng meeting CÓ chủ
      await statusOf(edit(author, 'member', running, 0, 1, 'x')), // chưa xong
      await statusOf(edit(author, 'member', shared, 9, 1, 'x')), // đoạn không có
      await statusOf(edit(author, 'member', shared, 0, 7, 'x')), // version lệch
    ];
    expect(statuses).toEqual([404, 403, 403, 409, 404, 412]);
    // Mọi lần bị từ chối đều không ghi gì.
    const rows = await db
      .select({ text: transcriptSegments.text, version: transcriptSegments.version })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, shared));
    expect(
      rows.map((r) => [r.text, r.version]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['kế hoạch quý ba', 1],
      ['ngân sách', 1],
    ]);
  });

  it('meeting KHÔNG chủ: Admin org sửa được và để lại audit (seq, version), không chứa nội dung', async () => {
    const id = await meeting(null, { shared: false });
    const seg = await edit(admin, 'admin', id, 1, 1, 'bí mật: số điện thoại 0901234567');
    expect(seg.version).toBe(2);
    const audits = await auditsOf(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: admin.id,
      orgId,
      targetType: 'meeting',
      metadata: { seq: 1, fromVersion: 1, toVersion: 2 },
    });
    expect(JSON.stringify(audits[0])).not.toContain('0901234567');
  });

  it('lần sửa bị từ chối giữa chừng (lệch version) không để lại audit', async () => {
    const id = await meeting(null, { shared: false });
    await edit(admin, 'admin', id, 0, 1, 'một');
    expect(await statusOf(edit(admin, 'admin', id, 0, 1, 'hai'))).toBe(412);
    expect(await auditsOf(id)).toHaveLength(1);
  });

  it('hai người sửa song song cùng version: đúng một thành công (service), bản lưu là của người thắng', async () => {
    const id = await meeting(null, { shared: false });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => edit(admin, 'admin', id, 0, 1, `bản ${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const [row] = await db
      .select({ text: transcriptSegments.text, version: transcriptSegments.version })
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.meetingId, id), eq(transcriptSegments.seq, 0)));
    expect(row!.version).toBe(2);
    expect(row!.text).toBe((ok[0] as PromiseFulfilledResult<{ text: string }>).value.text);
    expect(await auditsOf(id)).toHaveLength(1); // chỉ lần thắng được audit
  });
});
