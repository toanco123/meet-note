import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { transcriptSegments } from '../../../src/infra/database/schema/index.js';
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

const START = '\u0001';
const STOP = '\u0002';

/** Search transcript qua HTTP (M8 B2): snippet, quyền xem, validate, kênh ẩn. */
describe('GET /orgs/:orgId/search/transcripts (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let author: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let channelId: string;
  let privateChannelId: string;
  let meetingId: string;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const search = (u: TestUser, query: Record<string, string | number>) =>
    http().get(`/v1/orgs/${orgId}/search/transcripts`).query(query).set(as(u));

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    const orgOwner = await registerUser(app);
    [author, viewer, outsider] = (await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ])) as [TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(orgOwner)).send({ name: 'Tìm kiếm' }).expect(201))
      .body.data.id as string;
    for (const u of [author, viewer, outsider]) await addMember(db, orgId, u.id);
    const pub = await insertChannel(db, orgId, orgOwner.id, { visibility: 'public' });
    const priv = await insertChannel(db, orgId, orgOwner.id, { visibility: 'private' });
    channelId = pub.id;
    privateChannelId = priv.id;
    await addChannelMember(db, priv, orgId, author.id, 'member');
    // `viewer` thấy meeting qua kênh công khai; `outsider` không thấy gì (meeting KHÔNG share).
    meetingId = (await insertMeeting(db, orgId, author.id, { title: 'Họp kế hoạch' })).id;
    await shareMeeting(db, orgId, meetingId, channelId);
    const texts = [
      'Mở đầu cuộc họp',
      'Chốt kế hoạch quý ba',
      'Nói về ngân sách',
      'KẾ HOẠCH tuyển dụng hai kỹ sư',
      'Kế hoạch ra mắt sản phẩm',
      'Kế hoạch cuối cùng',
    ];
    await db.insert(transcriptSegments).values(
      texts.map((text, seq) => ({
        meetingId,
        orgId,
        seq,
        startMs: seq * 1_000,
        endMs: seq * 1_000 + 900,
        text,
      })),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  // Truy vấn nhiều từ = đủ mọi từ, không phải cụm → ts_headline đánh dấu TỪNG từ riêng.
  it('tìm không dấu ra có dấu: meeting + 3 đoạn khớp đầu + số đoạn khớp + mốc thời gian + từ khoá được đánh dấu', async () => {
    const res = await search(viewer, { q: 'ke hoach' }).expect(200);
    expect(res.body.data).toEqual([
      {
        meetingId,
        title: 'Họp kế hoạch',
        recordedAt: expect.any(String),
        hitCount: 4,
        hits: [
          {
            seq: 1,
            startMs: 1000,
            endMs: 1900,
            snippet: `Chốt ${START}kế${STOP} ${START}hoạch${STOP} quý ba`,
          },
          {
            seq: 3,
            startMs: 3000,
            endMs: 3900,
            snippet: `${START}KẾ${STOP} ${START}HOẠCH${STOP} tuyển dụng hai kỹ sư`,
          },
          {
            seq: 4,
            startMs: 4000,
            endMs: 4900,
            snippet: `${START}Kế${STOP} ${START}hoạch${STOP} ra mắt sản phẩm`,
          },
        ],
      },
    ]);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  // Đột biến: đổi StartSel / StopSel thành `<b>` / `</b>` → snippet chứa HTML thật (đỏ).
  it('nội dung transcript chứa HTML không sinh thẻ: snippet chỉ có ký tự đánh dấu, phần còn lại giữ nguyên chữ', async () => {
    const m = (await insertMeeting(db, orgId, author.id, { title: 'XSS' })).id;
    await shareMeeting(db, orgId, m, channelId);
    await db.insert(transcriptSegments).values({
      meetingId: m,
      orgId,
      seq: 0,
      startMs: 0,
      endMs: 1,
      text: '<img src=x onerror=alert(1)> thanhtoan <script>alert(2)</script>',
    });
    const res = await search(viewer, { q: 'thanhtoan' }).expect(200);
    const snippet = res.body.data[0].hits[0].snippet as string;
    expect(snippet).toContain(`${START}thanhtoan${STOP}`);
    expect(snippet).not.toMatch(/<\/?b>/);
  });

  it('người không xem được meeting không thấy gì; 400 cho q thiếu / quá ngắn / quá dài; chuỗi lạ không 500', async () => {
    const secret = (await insertMeeting(db, orgId, author.id, { title: 'Bí mật' })).id;
    await db
      .insert(transcriptSegments)
      .values({ meetingId: secret, orgId, seq: 0, startMs: 0, endMs: 1, text: 'tuyetmat noi bo' });
    const hidden = await search(outsider, { q: 'tuyetmat' });
    const own = await search(author, { q: 'tuyetmat' });
    const noQ = await http().get(`/v1/orgs/${orgId}/search/transcripts`).set(as(viewer));
    const short = await search(viewer, { q: 'a' });
    const spaces = await search(viewer, { q: '   ' });
    const long = await search(viewer, { q: 'x'.repeat(201) });
    const weird = await search(viewer, { q: '"((&|!' });
    expect([
      hidden.status,
      hidden.body.data,
      own.body.data.map((r: { meetingId: string }) => r.meetingId),
      noQ.status,
      short.status,
      spaces.status,
      long.status,
      weird.status,
    ]).toEqual([200, [], [secret], 400, 400, 400, 400, 200]);
  });

  it('phân trang: limit 1 theo cursor duyệt hết, không lặp', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await search(
        viewer,
        cursor ? { q: 'ke hoach thanhtoan', limit: 1, cursor } : { q: 'ke hoach', limit: 1 },
      );
      seen.push(...res.body.data.map((r: { meetingId: string }) => r.meetingId));
      cursor = res.body.meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual([meetingId]);
    const bad = await search(viewer, { q: 'ke hoach', cursor: 'rác' });
    expect(bad.status).toBe(400);
  });

  it('lọc channelId: kênh chứa meeting → có; kênh khác → rỗng; kênh riêng tư mình không ở trong → 404; không tồn tại → 404', async () => {
    const inChannel = await search(viewer, { q: 'ke hoach', channelId });
    const wrong = await search(viewer, { q: 'ke hoach', channelId: privateChannelId });
    const missing = await search(viewer, {
      q: 'ke hoach',
      channelId: '00000000-0000-7000-8000-000000000000',
    });
    const asMember = await search(author, { q: 'ke hoach', channelId: privateChannelId });
    expect([
      inChannel.status,
      inChannel.body.data.map((r: { meetingId: string }) => r.meetingId),
      wrong.status,
      missing.status,
      asMember.status,
      asMember.body.data,
    ]).toEqual([200, [meetingId], 404, 404, 200, []]);
  });

  it('chưa đăng nhập → 401', async () => {
    await http().get(`/v1/orgs/${orgId}/search/transcripts`).query({ q: 'ke hoach' }).expect(401);
  });
});
