import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { channels, meetingShares } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

/** Ma trận share / gỡ share qua HTTP thật (04 §2, M6b Q2 – Q4). */
describe('Meetings: chia sẻ vào kênh / gỡ (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  const u: Record<
    'owner' | 'orgAdmin' | 'host' | 'author' | 'cm' | 'ca' | 'guest' | 'outsider',
    TestUser
  > = {} as never;
  const ch: Record<'pub' | 'priv' | 'arch' | 'gone', string> = {} as never;

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const share = (who: TestUser, meetingId: string, channelId: unknown) =>
    http().post(`/v1/orgs/${orgId}/meetings/${meetingId}/shares`).set(as(who)).send({ channelId });
  const unshare = (who: TestUser, meetingId: string, channelId: string) =>
    http().delete(`/v1/orgs/${orgId}/meetings/${meetingId}/shares/${channelId}`).set(as(who));
  const outcome = (r: request.Response) =>
    r.status < 300 ? r.status : `${r.status} ${r.body.error.code}`;
  const mine = async (who: TestUser) => (await insertMeeting(db, orgId, who.id)).id;
  const shared = async (meetingId: string) =>
    (
      await db
        .select({ c: meetingShares.channelId })
        .from(meetingShares)
        .where(eq(meetingShares.meetingId, meetingId))
    )
      .map((r) => r.c)
      .sort();

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    for (const k of [
      'owner',
      'orgAdmin',
      'host',
      'author',
      'cm',
      'ca',
      'guest',
      'outsider',
    ] as const) {
      u[k] = await registerUser(app);
    }
    orgId = (await http().post('/v1/orgs').set(as(u.owner)).send({ name: 'Share' }).expect(201))
      .body.data.id;
    await addMember(db, orgId, u.orgAdmin.id, 'admin');
    for (const k of ['host', 'author', 'cm', 'ca', 'guest', 'outsider'] as const) {
      await addMember(db, orgId, u[k].id);
    }
    ch.pub = (await insertChannel(db, orgId, u.host.id, { visibility: 'public' })).id;
    ch.priv = (await insertChannel(db, orgId, u.host.id, { visibility: 'private' })).id;
    ch.arch = (await insertChannel(db, orgId, u.host.id, { visibility: 'public' })).id;
    ch.gone = (await insertChannel(db, orgId, u.host.id, { visibility: 'public' })).id;
    for (const c of [ch.priv, ch.arch, ch.gone]) {
      await addChannelMember(db, { id: c }, orgId, u.author.id, 'member');
    }
    await addChannelMember(db, { id: ch.priv }, orgId, u.cm.id, 'member');
    await addChannelMember(db, { id: ch.priv }, orgId, u.ca.id, 'admin');
    await addChannelMember(db, { id: ch.priv }, orgId, u.guest.id, 'guest');
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, ch.arch));
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, ch.gone));
  });

  afterAll(async () => {
    await app.close();
  });

  it('share lần đầu 201, lại lần nữa 200 với CÙNG sharedAt (idempotent, Q3)', async () => {
    const m = await mine(u.author);
    const first = await share(u.author, m, ch.priv).expect(201);
    const again = await share(u.author, m, ch.priv).expect(200);
    expect([again.body.data, await shared(m)]).toEqual([first.body.data, [ch.priv]]);
  });

  it('ma trận share (meeting CỦA người gọi trừ khi ghi khác)', async () => {
    const cases: Array<[string, TestUser, () => Promise<string>, unknown, string | number]> = [
      ['thành viên kênh riêng tư', u.author, () => mine(u.author), ch.priv, 201],
      [
        'thành viên org vào kênh công khai CHƯA join',
        u.outsider,
        () => mine(u.outsider),
        ch.pub,
        '403 FORBIDDEN',
      ],
      ['khách trong kênh', u.guest, () => mine(u.guest), ch.priv, '403 FORBIDDEN'],
      [
        'Admin org, kênh riêng tư không ở trong',
        u.orgAdmin,
        () => mine(u.orgAdmin),
        ch.priv,
        '403 FORBIDDEN',
      ],
      [
        'ngoài kênh riêng tư (không thấy kênh)',
        u.outsider,
        () => mine(u.outsider),
        ch.priv,
        '404 NOT_FOUND',
      ],
      ['kênh lưu trữ', u.author, () => mine(u.author), ch.arch, '409 CHANNEL_ARCHIVED'],
      ['kênh đã xoá', u.author, () => mine(u.author), ch.gone, '404 NOT_FOUND'],
      ['kênh không tồn tại', u.author, () => mine(u.author), randomUUID(), '404 NOT_FOUND'],
      ['meeting của NGƯỜI KHÁC', u.author, () => mine(u.cm), ch.priv, '404 NOT_FOUND'],
      ['channelId không phải uuid', u.author, () => mine(u.author), 'abc', '400 VALIDATION_FAILED'],
    ];
    const results: Array<[string, string | number]> = [];
    for (const [label, who, meeting, channelId] of cases) {
      results.push([label, outcome(await share(who, await meeting(), channelId))]);
    }
    expect(results).toEqual(cases.map(([label, , , , expected]) => [label, expected]));
  });

  it('ma trận gỡ share (Q2, Q4); gọi lại → 204', async () => {
    const run = async (who: TestUser, meetingId: string, channelId: string) =>
      outcome(await unshare(who, meetingId, channelId));
    // M: của author, nằm ở kênh riêng tư + kênh công khai (author KHÔNG ở trong kênh công khai).
    const fresh = async () => {
      const id = await mine(u.author);
      await shareMeeting(db, orgId, id, ch.priv, u.author.id);
      await shareMeeting(db, orgId, id, ch.pub, u.author.id);
      return id;
    };
    const [m1, m2, m3, m4] = [await fresh(), await fresh(), await fresh(), await fresh()];
    const orphan = (await insertMeeting(db, orgId, null)).id;
    await shareMeeting(db, orgId, orphan, ch.priv);
    const privOnly = await mine(u.author);
    await shareMeeting(db, orgId, privOnly, ch.priv);
    const inArch = await mine(u.author);
    await shareMeeting(db, orgId, inArch, ch.arch);

    const results = [
      ['thành viên kênh, meeting người khác', await run(u.cm, m1, ch.priv)],
      ['QTV kênh', await run(u.ca, m1, ch.priv)],
      ['QTV kênh, gọi lại', await run(u.ca, m1, ch.priv)],
      ['chủ meeting, kênh mình KHÔNG ở trong (Q4)', await run(u.author, m2, ch.pub)],
      ['người ngoài kênh công khai (thấy meeting)', await run(u.outsider, m3, ch.pub)],
      ['người ngoài, meeting KHÔNG thấy được → 404', await run(u.outsider, privOnly, ch.pub)],
      ['Admin org, meeting có chủ', await run(u.orgAdmin, m4, ch.pub)],
      ['Admin org, meeting KHÔNG chủ ở kênh riêng tư (Q2)', await run(u.orgAdmin, orphan, ch.priv)],
      ['Chủ kênh, kênh lưu trữ', await run(u.host, inArch, ch.arch)],
    ];

    expect(results).toEqual([
      ['thành viên kênh, meeting người khác', '403 FORBIDDEN'],
      ['QTV kênh', 204],
      ['QTV kênh, gọi lại', 204],
      ['chủ meeting, kênh mình KHÔNG ở trong (Q4)', 204],
      ['người ngoài kênh công khai (thấy meeting)', '403 FORBIDDEN'],
      ['người ngoài, meeting KHÔNG thấy được → 404', '404 NOT_FOUND'],
      ['Admin org, meeting có chủ', '403 FORBIDDEN'],
      ['Admin org, meeting KHÔNG chủ ở kênh riêng tư (Q2)', 204],
      ['Chủ kênh, kênh lưu trữ', '409 CHANNEL_ARCHIVED'],
    ]);
    const left = await db
      .select({ m: meetingShares.meetingId, c: meetingShares.channelId })
      .from(meetingShares)
      .where(and(inArray(meetingShares.meetingId, [m1, m2, orphan, inArch])));
    expect(
      left
        .map(
          (r) =>
            `${r.m === m1 ? 'm1' : r.m === m2 ? 'm2' : r.m === orphan ? 'orphan' : 'inArch'}:${r.c === ch.pub ? 'pub' : r.c === ch.priv ? 'priv' : 'arch'}`,
        )
        .sort(),
    ).toEqual(['inArch:arch', 'm1:pub', 'm2:priv']);
  });

  it('share xong, người trong kênh thấy meeting; gỡ xong thì mất ngay', async () => {
    const m = await mine(u.author);
    const get = () => http().get(`/v1/orgs/${orgId}/meetings/${m}`).set(as(u.cm));
    const before = (await get()).status;
    await share(u.author, m, ch.priv).expect(201);
    const during = (await get()).status;
    await unshare(u.author, m, ch.priv).expect(204);
    expect([before, during, (await get()).status]).toEqual([404, 200, 404]);
  });
});
