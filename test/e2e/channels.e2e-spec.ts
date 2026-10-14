import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/common/pagination/cursor.js';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { auditLogs, channels } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { addChannelMember, addMember } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

interface ChannelBody {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  weeklyReportEnabled: boolean;
  archivedAt: string | null;
  myRole: string | null;
  memberCount: number;
}

describe('Kênh: tạo / xem / sửa / liệt kê (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  // Org chính. alice = Chủ kênh riêng tư; bob = QTV; carol = thành viên; gina = Khách;
  // outsider = thành viên org chưa vào kênh; orgAdmin / owner = quản trị org; stranger = ngoài org.
  let owner: TestUser;
  let orgAdmin: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let gina: TestUser;
  let outsider: TestUser;
  let stranger: TestUser;
  let orgId: string;
  let privateCh: ChannelBody;
  let publicCh: ChannelBody;

  const http = () => request(app.getHttpServer());
  const base = (org = orgId) => `/v1/orgs/${org}/channels`;
  const create = (who: TestUser, body: object, org = orgId) =>
    http().post(base(org)).set(bearer(who.tokens.accessToken)).send(body);
  const get = (who: TestUser, channelId: string, org = orgId) =>
    http()
      .get(`${base(org)}/${channelId}`)
      .set(bearer(who.tokens.accessToken));
  const patch = (who: TestUser, channelId: string, body: object) =>
    http().patch(`${base()}/${channelId}`).set(bearer(who.tokens.accessToken)).send(body);
  const newOrg = async (who: TestUser, name: string): Promise<string> =>
    (await http().post('/v1/orgs').set(bearer(who.tokens.accessToken)).send({ name }).expect(201))
      .body.id;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    [owner, orgAdmin, alice, bob, carol, gina, outsider, stranger] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = await newOrg(owner, 'Kênh');
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [alice, bob, carol, gina, outsider]) await addMember(db, orgId, u.id, 'member');

    privateCh = (await create(alice, { name: 'Ban giám đốc', visibility: 'private' }).expect(201))
      .body;
    await addChannelMember(db, privateCh, orgId, bob.id, 'admin');
    await addChannelMember(db, privateCh, orgId, carol.id, 'member');
    await addChannelMember(db, privateCh, orgId, gina.id, 'guest');
    publicCh = (await create(alice, { name: 'Toàn công ty' }).expect(201)).body;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/orgs/:orgId/channels', () => {
    it('tạo → 201, người tạo là Chủ kênh, mặc định công khai; audit channel.created', async () => {
      const res = await create(alice, { name: '  Kỹ thuật  ', description: '  Backend  ' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Kỹ thuật',
        description: 'Backend',
        visibility: 'public',
        weeklyReportEnabled: true,
        archivedAt: null,
        myRole: 'owner',
        memberCount: 1,
      });
      const [log] = await db.select().from(auditLogs).where(eq(auditLogs.targetId, res.body.id));
      expect(log).toMatchObject({ action: 'channel.created', actorId: alice.id, orgId });
    });

    it('tên trùng không phân biệt hoa thường (kể cả chữ có dấu) → 409 CHANNEL_NAME_TAKEN', async () => {
      await create(carol, { name: 'Phòng Họp Ước' }).expect(201);
      const res = await create(bob, { name: 'PHÒNG HỌP ƯỚC' }).expect(409);
      expect(res.body.error.code).toBe('CHANNEL_NAME_TAKEN');
    });

    it('cùng tên ở tổ chức khác → được', async () => {
      const other = await newOrg(stranger, 'Org khác');
      const res = await create(stranger, { name: 'Ban giám đốc' }, other);
      expect(res.status).toBe(201);
    });

    it('2 request tạo cùng tên SONG SONG → đúng 1 thành công, 1 nhận 409 (unique index quyết định)', async () => {
      const results = await Promise.all(
        [alice, bob, carol].map((who) => create(who, { name: 'Đua tên' })),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409, 409]);
      expect(results.find((r) => r.status === 409)?.body.error.code).toBe('CHANNEL_NAME_TAKEN');
    });

    it.each([
      ['tên rỗng', { name: '   ' }],
      ['tên 81 ký tự', { name: 'a'.repeat(81) }],
      ['visibility lạ', { name: 'x', visibility: 'secret' }],
      ['mô tả 501 ký tự', { name: 'y', description: 'a'.repeat(501) }],
    ])('%s → 400', async (_label, body) => {
      const res = await create(alice, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('người ngoài tổ chức → 404', async () => {
      const res = await create(stranger, { name: 'Lẻn vào' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/orgs/:orgId/channels/:channelId — kênh riêng tư', () => {
    it.each([
      ['Chủ kênh', 200, () => alice, 'owner'],
      ['QTV kênh', 200, () => bob, 'admin'],
      ['Khách', 200, () => gina, 'guest'],
      ['Admin org (không trong kênh) thấy metadata', 200, () => orgAdmin, null],
      ['Owner org (không trong kênh)', 200, () => owner, null],
      ['thành viên org ngoài kênh → 404, không 403', 404, () => outsider, undefined],
      ['người ngoài tổ chức', 404, () => stranger, undefined],
    ] as const)('%s → %i', async (_label, status, who, myRole) => {
      const res = await get(who(), privateCh.id);
      expect(res.status).toBe(status);
      expect(res.body.myRole).toBe(myRole);
    });

    it('404 của kênh riêng tư giống hệt 404 của kênh không tồn tại (không lộ thông tin)', async () => {
      const hidden = await get(outsider, privateCh.id);
      const missing = await get(outsider, randomUUID());
      expect(hidden.body.error).toEqual({
        ...missing.body.error,
        requestId: hidden.body.error.requestId,
      });
    });

    it('kênh công khai: thành viên org chưa join xem được, myRole = null', async () => {
      const res = await get(outsider, publicCh.id).expect(200);
      expect(res.body).toMatchObject({ id: publicCh.id, myRole: null, visibility: 'public' });
    });

    it.each([
      ['channelId không phải uuid', () => 'abc'],
      ['uuid không tồn tại', () => randomUUID()],
    ])('%s → 404', async (_label, id) => {
      const res = await get(alice, id()).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('kênh của org khác gắn vào path org này → 404', async () => {
      const other = await newOrg(alice, 'Org thứ hai');
      const foreign = (await create(alice, { name: 'Kênh org 2' }, other).expect(201)).body;
      const res = await get(alice, foreign.id);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /v1/orgs/:orgId/channels/:channelId', () => {
    it('Chủ kênh sửa → 200; audit chỉ ghi field thực sự đổi', async () => {
      const ch = (await create(alice, { name: 'Sửa tôi', description: 'cũ' }).expect(201)).body;

      const res = await patch(alice, ch.id, {
        name: 'Đã sửa',
        description: 'cũ',
        weeklyReportEnabled: false,
      }).expect(200);

      expect(res.body).toMatchObject({
        name: 'Đã sửa',
        description: 'cũ',
        weeklyReportEnabled: false,
      });
      const [log] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.targetId, ch.id), eq(auditLogs.action, 'channel.updated')));
      expect(log?.metadata).toEqual({
        before: { name: 'Sửa tôi', weeklyReportEnabled: true },
        after: { name: 'Đã sửa', weeklyReportEnabled: false },
      });
    });

    it('mô tả null / chuỗi rỗng → xoá mô tả; body rỗng → 200, không ghi audit', async () => {
      const ch = (await create(alice, { name: 'Mô tả', description: 'có' }).expect(201)).body;

      expect((await patch(alice, ch.id, { description: '  ' }).expect(200)).body.description).toBe(
        null,
      );
      await patch(alice, ch.id, {}).expect(200);
      await patch(alice, ch.id, { description: null }).expect(200);

      const logs = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.targetId, ch.id), eq(auditLogs.action, 'channel.updated')));
      expect(logs).toHaveLength(1);
    });

    it.each([
      ['QTV kênh', 200, () => bob],
      ['thành viên kênh', 403, () => carol],
      ['Khách', 403, () => gina],
      ['Admin org (không trong kênh): thấy nhưng không sửa được', 403, () => orgAdmin],
      ['thành viên org ngoài kênh riêng tư', 404, () => outsider],
    ] as const)('%s → %i', async (_label, status, who) => {
      const res = await patch(who(), privateCh.id, { description: `bởi ${_label}` });
      expect(res.status).toBe(status);
    });

    it('đổi tên trùng kênh khác (khác hoa thường) → 409 CHANNEL_NAME_TAKEN', async () => {
      const res = await patch(alice, privateCh.id, { name: 'TOÀN CÔNG TY' }).expect(409);
      expect(res.body.error.code).toBe('CHANNEL_NAME_TAKEN');
    });

    it('kênh đã lưu trữ: QTV → 409 CHANNEL_ARCHIVED; thành viên vẫn 403 (xét quyền trước)', async () => {
      const ch = (await create(alice, { name: 'Lưu trữ' }).expect(201)).body;
      await addChannelMember(db, ch, orgId, bob.id, 'admin');
      await addChannelMember(db, ch, orgId, carol.id, 'member');
      await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, ch.id));

      const res = await patch(bob, ch.id, { name: 'Không được' }).expect(409);
      expect(res.body.error.code).toBe('CHANNEL_ARCHIVED');
      await patch(carol, ch.id, { name: 'Không được' }).expect(403);
      await get(carol, ch.id).expect(200); // vẫn đọc được
    });
  });

  describe('GET /v1/orgs/:orgId/channels', () => {
    // Org riêng cho phần danh sách để số lượng kênh xác định.
    let listOrg: string;
    let m1: TestUser;
    let m2: TestUser;
    let admin: TestUser;

    const list = async (who: TestUser, query: Record<string, string | number> = {}) => {
      const res = await http()
        .get(base(listOrg))
        .query({ limit: 100, ...query })
        .set(bearer(who.tokens.accessToken))
        .expect(200);
      return (res.body.data as ChannelBody[]).map((c) => c.name);
    };

    beforeAll(async () => {
      [m1, m2, admin] = await Promise.all([
        registerUser(app),
        registerUser(app),
        registerUser(app),
      ]);
      listOrg = await newOrg(admin, 'Danh sách');
      await addMember(db, listOrg, m1.id, 'member');
      await addMember(db, listOrg, m2.id, 'member');
      await create(m1, { name: 'Bảng tin' }, listOrg).expect(201);
      await create(m1, { name: 'Riêng của m1', visibility: 'private' }, listOrg).expect(201);
      await create(m2, { name: 'Riêng của m2', visibility: 'private' }, listOrg).expect(201);
      const old = (await create(m2, { name: 'Cũ' }, listOrg).expect(201)).body;
      await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, old.id));
    });

    it('thành viên thấy kênh công khai + kênh riêng tư của mình; theo tên A→Z; ẩn kênh lưu trữ', async () => {
      expect(await list(m1)).toEqual(['Bảng tin', 'Riêng của m1']);
    });

    it('Admin org thấy mọi kênh (kể cả riêng tư không tham gia)', async () => {
      expect(await list(admin)).toEqual(['Bảng tin', 'Riêng của m1', 'Riêng của m2']);
    });

    it('archived=true → chỉ kênh lưu trữ; visibility lọc; q tìm không dấu', async () => {
      expect(await list(m1, { archived: 'true' })).toEqual(['Cũ']);
      expect(await list(admin, { visibility: 'private' })).toEqual([
        'Riêng của m1',
        'Riêng của m2',
      ]);
      expect(await list(m2, { q: 'BANG TIN' })).toEqual(['Bảng tin']);
      expect(await list(m2, { q: '%' })).toEqual([]); // ký tự LIKE được tìm nguyên văn
    });

    it('myRole đúng theo từng kênh', async () => {
      const res = await http().get(base(listOrg)).set(bearer(m1.tokens.accessToken)).expect(200);
      expect(res.body.data.map((c: ChannelBody) => [c.name, c.myRole])).toEqual([
        ['Bảng tin', 'owner'],
        ['Riêng của m1', 'owner'],
      ]);
    });

    it('phân trang theo tên (không phân biệt hoa thường): không trùng, không sót, đúng thứ tự', async () => {
      const pagOrg = await newOrg(m1, 'Phân trang');
      const names = [
        'echo',
        'Alpha',
        'kilo',
        'Bravo',
        'golf',
        'Delta',
        'hotel',
        'Charlie',
        'foxtrot',
        'India',
        'juliet',
        'Lima',
      ];
      for (const name of names) await create(m1, { name }, pagOrg).expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { data: ChannelBody[]; nextCursor: string | null } } = await http()
          .get(base(pagOrg))
          .query(cursor ? { limit: 5, cursor } : { limit: 5 })
          .set(bearer(m1.tokens.accessToken))
          .expect(200);
        seen.push(...res.body.data.map((c) => c.name));
        cursor = res.body.nextCursor;
      } while (cursor);

      expect(seen).toEqual(
        [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      );
    });

    it.each([
      ['cursor rác', { cursor: 'không-phải-base64' }],
      ['cursor của danh sách khác (2 khoá)', { cursor: encodeCursor(['a', randomUUID()]) }],
      ['khoá cursor là số', { cursor: encodeCursor([42]) }],
    ])('%s → 400 INVALID_CURSOR', async (_label, query) => {
      const res = await http()
        .get(base(listOrg))
        .query(query)
        .set(bearer(m1.tokens.accessToken))
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('archived=yes → 400 (chỉ nhận true/false)', async () => {
      await http()
        .get(base(listOrg))
        .query({ archived: 'yes' })
        .set(bearer(m1.tokens.accessToken))
        .expect(400);
    });
  });
});
