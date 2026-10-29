import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import {
  actionItems,
  auditLogs,
  channelMembers,
} from '../../../src/infra/database/schema/index.js';
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

type Body = Record<string, unknown>;

/**
 * API ghi việc cần làm (M12 B5): bảng quyền, `If-Match`, người được giao, ngữ nghĩa `done` / `dismissed`,
 * audit. Race nằm ở `action-items-concurrency.e2e-spec.ts`.
 */
describe('Action items — API ghi (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser; // Owner org (chủ meeting không chủ khi cần)
  let orgAdmin: TestUser; // Admin org, KHÔNG phải chủ meeting nào
  let author: TestUser; // chủ meeting
  let assignee: TestUser; // member, được giao việc
  let peer: TestUser; // member xem được meeting công khai, không phải chủ, không được giao
  let stranger: TestUser; // member org, KHÔNG xem được meeting riêng
  let outsider: TestUser; // không thuộc org
  let meetingPublic: string; // author, share vào kênh công khai: ai trong org cũng xem được
  let meetingPrivate: string; // author, không share: chỉ author xem được
  let meetingOwnerless: string; // không chủ, không share: Owner / Admin org xem + quản lý được
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const itemsUrl = (meetingId: string) => `/v1/orgs/${orgId}/meetings/${meetingId}/action-items`;
  const itemUrl = (id: string) => `/v1/orgs/${orgId}/action-items/${id}`;

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, orgAdmin, author, assignee, peer, stranger, outsider] = (await Promise.all(
      Array.from({ length: 7 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Ghi' }).expect(201)).body
      .data.id as string;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [author, assignee, peer, stranger]) await addMember(db, orgId, u.id);
    const pub = await insertChannel(db, orgId, owner.id, { visibility: 'public' });
    meetingPublic = (await insertMeeting(db, orgId, author.id, { status: 'completed' })).id;
    await shareMeeting(db, orgId, meetingPublic, pub.id, author.id);
    meetingPrivate = (await insertMeeting(db, orgId, author.id, { status: 'completed' })).id;
    meetingOwnerless = (await insertMeeting(db, orgId, null, { status: 'completed' })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Chèn thẳng một việc tay (version 1) — mỗi ca một việc riêng vì mỗi lần ghi đổi version / trạng thái. */
  async function newItem(meetingId: string, over: Partial<typeof actionItems.$inferInsert> = {}) {
    const [row] = await db
      .insert(actionItems)
      .values({ orgId, meetingId, origin: 'manual', task: 'Việc mẫu', ...over })
      .returning();
    return row!;
  }
  const patch = (u: TestUser, id: string, body: Body, version: number | string = 1) =>
    http()
      .patch(itemUrl(id))
      .set(as(u))
      .set('If-Match', typeof version === 'number' ? `"${version}"` : version)
      .send(body);
  const rowOf = async (id: string) =>
    (await db.select().from(actionItems).where(eq(actionItems.id, id)))[0]!;
  const auditsOf = (action: 'action_item.created' | 'action_item.updated', targetId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.targetId, targetId)));

  describe('POST /meetings/:meetingId/action-items', () => {
    // [người gọi, meeting, status mong đợi]
    it.each([
      ['author (chủ)', () => author, () => meetingPublic, 201],
      ['author (chủ), meeting riêng', () => author, () => meetingPrivate, 201],
      [
        'Admin org, meeting CÓ chủ (xem được nhưng không quản lý)',
        () => orgAdmin,
        () => meetingPublic,
        403,
      ],
      ['Admin org, meeting không chủ', () => orgAdmin, () => meetingOwnerless, 201],
      ['Owner org, meeting không chủ', () => owner, () => meetingOwnerless, 201],
      ['member xem được, không phải chủ', () => peer, () => meetingPublic, 403],
      ['người được giao việc khác của meeting', () => assignee, () => meetingPublic, 403],
      ['member không xem được meeting riêng → 404', () => stranger, () => meetingPrivate, 404],
      [
        'member, meeting không chủ nhưng không phải OrgAdm → 404',
        () => peer,
        () => meetingOwnerless,
        404,
      ],
      ['người ngoài tổ chức → 404', () => outsider, () => meetingPublic, 404],
    ] as const)('%s → %i', async (_name, actor, meeting, status) => {
      await http()
        .post(itemsUrl(meeting()))
        .set(as(actor()))
        .send({ task: 'Gửi báo giá' })
        .expect(status);
    });

    it('tạo việc tay: origin manual, open, version 1, ETag "1", người được giao + hạn', async () => {
      const res = await http()
        .post(itemsUrl(meetingPublic))
        .set(as(author))
        .send({ task: '  Gửi báo giá  ', assigneeId: assignee.id, dueDate: '2026-11-05' })
        .expect(201);
      expect(res.headers.etag).toBe('"1"');
      expect(res.body.data).toMatchObject({
        meetingId: meetingPublic,
        origin: 'manual',
        task: 'Gửi báo giá', // đã trim
        status: 'open',
        version: 1,
        ownerName: null,
        dueText: null,
        dueDate: '2026-11-05',
        assignee: { id: assignee.id },
        completedAt: null,
      });
      const row = await rowOf(res.body.data.id as string);
      expect(row).toMatchObject({ origin: 'manual', sourceIndex: null, createdBy: author.id });
    });

    it('chỉ cần task: không giao, không hạn', async () => {
      const res = await http()
        .post(itemsUrl(meetingPublic))
        .set(as(author))
        .send({ task: 'Việc trơn' })
        .expect(201);
      expect(res.body.data).toMatchObject({ assignee: null, dueDate: null });
    });

    it.each([
      ['task thiếu', {}],
      ['task rỗng', { task: '' }],
      ['task toàn khoảng trắng', { task: '   ' }],
      ['task 501 ký tự', { task: 'a'.repeat(501) }],
      ['task không phải chuỗi', { task: 42 }],
      ['dueDate sai dạng', { task: 'x', dueDate: '30/10/2026' }],
      ['dueDate không có thật', { task: 'x', dueDate: '2026-02-30' }],
      ['dueDate có giờ', { task: 'x', dueDate: '2026-10-30T10:00:00Z' }],
      ['dueDate trước năm 2000', { task: 'x', dueDate: '1999-12-31' }],
      ['assigneeId không phải uuid', { task: 'x', assigneeId: 'bình' }],
    ])('đầu vào sai: %s → 400', async (_name, body) => {
      await http().post(itemsUrl(meetingPublic)).set(as(author)).send(body).expect(400);
    });

    it('task đúng 500 ký tự được', async () => {
      await http()
        .post(itemsUrl(meetingPublic))
        .set(as(author))
        .send({ task: 'a'.repeat(500) })
        .expect(201);
    });

    it('người được giao phải là thành viên org VÀ xem được meeting (422)', async () => {
      const code = async (assigneeId: string, meeting = meetingPrivate) =>
        (await http().post(itemsUrl(meeting)).set(as(author)).send({ task: 'x', assigneeId })).body;
      // stranger là member org nhưng không xem được meeting riêng của author
      expect((await code(stranger.id)).error.code).toBe('ACTION_ITEM_ASSIGNEE_INVALID');
      // người ngoài org
      expect((await code(outsider.id)).error.code).toBe('ACTION_ITEM_ASSIGNEE_INVALID');
      // uuid không tồn tại
      expect((await code('00000000-0000-4000-8000-000000000000')).error.code).toBe(
        'ACTION_ITEM_ASSIGNEE_INVALID',
      );
      // người ngoài org nhưng meeting xem được theo `meetingVisibleTo` (kênh công khai; biểu thức đó không
      // tự kiểm membership): chặn bởi bước kiểm thành viên VÀ, nếu bước đó hỏng, bởi composite FK
      expect((await code(outsider.id, meetingPublic)).error.code).toBe(
        'ACTION_ITEM_ASSIGNEE_INVALID',
      );
      // chính chủ meeting thì được; người xem được meeting công khai thì được
      expect((await code(author.id)).data).toBeDefined();
      expect((await code(stranger.id, meetingPublic)).data).toBeDefined();
    });

    it('OrgAdm xem được meeting không chủ nên GIAO được cho OrgAdm; member thì 422', async () => {
      const give = (assigneeId: string) =>
        http().post(itemsUrl(meetingOwnerless)).set(as(owner)).send({ task: 'x', assigneeId });
      await give(orgAdmin.id).expect(201);
      expect((await give(peer.id).expect(422)).body.error.code).toBe(
        'ACTION_ITEM_ASSIGNEE_INVALID',
      );
    });

    it('audit: chủ meeting tạo thì KHÔNG ghi; OrgAdm tạo trên meeting không chủ thì ghi, không có nội dung', async () => {
      const mine = await http()
        .post(itemsUrl(meetingPublic))
        .set(as(author))
        .send({ task: 'bí mật của chủ' })
        .expect(201);
      expect(await auditsOf('action_item.created', mine.body.data.id)).toHaveLength(0);

      const adm = await http()
        .post(itemsUrl(meetingOwnerless))
        .set(as(orgAdmin))
        .send({ task: 'nội dung nhạy cảm XYZ' })
        .expect(201);
      const audits = await auditsOf('action_item.created', adm.body.data.id as string);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: orgAdmin.id, targetType: 'action_item' });
      expect(JSON.stringify(audits[0]!.metadata)).not.toContain('XYZ');
    });

    it('meeting của org khác / không tồn tại → 404', async () => {
      await http()
        .post(itemsUrl('00000000-0000-4000-8000-000000000000'))
        .set(as(author))
        .send({ task: 'x' })
        .expect(404);
    });
  });

  describe('PATCH /action-items/:itemId — If-Match', () => {
    it('đúng version → 200, version tăng, ETag mới', async () => {
      const item = await newItem(meetingPublic);
      const res = await patch(author, item.id, { task: 'Đã sửa' }, 1).expect(200);
      expect(res.headers.etag).toBe('"2"');
      expect(res.body.data).toMatchObject({ task: 'Đã sửa', version: 2 });
      // dùng ETag trả về cho lần sau
      const again = await patch(author, item.id, { task: 'Sửa nữa' }, res.headers.etag!).expect(
        200,
      );
      expect(again.body.data.version).toBe(3);
    });

    it('thiếu If-Match → 428 ACTION_ITEM_IF_MATCH_REQUIRED, không ghi gì', async () => {
      const item = await newItem(meetingPublic);
      const res = await http()
        .patch(itemUrl(item.id))
        .set(as(author))
        .send({ task: 'x' })
        .expect(428);
      expect(res.body.error.code).toBe('ACTION_ITEM_IF_MATCH_REQUIRED');
      expect((await rowOf(item.id)).task).toBe('Việc mẫu');
    });

    it.each(['*', 'W/"1"', '"1", "2"', '"abc"', '"0"', ''])('If-Match %j → 400', async (header) => {
      const item = await newItem(meetingPublic);
      await patch(author, item.id, { task: 'x' }, header).expect(400);
      expect(await rowOf(item.id)).toMatchObject({ task: 'Việc mẫu', version: 1 });
    });

    it('version lệch → 412 ACTION_ITEM_VERSION_MISMATCH, không ghi gì', async () => {
      const item = await newItem(meetingPublic);
      await patch(author, item.id, { task: 'lần 1' }, 1).expect(200);
      const stale = await patch(author, item.id, { task: 'lần 2 từ bản cũ' }, 1).expect(412);
      expect(stale.body.error.code).toBe('ACTION_ITEM_VERSION_MISMATCH');
      expect(await rowOf(item.id)).toMatchObject({ task: 'lần 1', version: 2 });
    });

    it('body rỗng → 400 (không tăng version vô ích)', async () => {
      const item = await newItem(meetingPublic);
      await patch(author, item.id, {}).expect(400);
      expect((await rowOf(item.id)).version).toBe(1);
    });

    it.each([
      ['task rỗng', { task: '' }],
      ['task 501 ký tự', { task: 'a'.repeat(501) }],
      ['status lạ', { status: 'finished' }],
      ['dueDate không có thật', { dueDate: '2026-02-30' }],
      ['assigneeId không phải uuid', { assigneeId: 'x' }],
    ])('đầu vào sai: %s → 400', async (_name, body) => {
      const item = await newItem(meetingPublic);
      await patch(author, item.id, body).expect(400);
      expect(await rowOf(item.id)).toMatchObject({ task: 'Việc mẫu', version: 1 });
    });
  });

  describe('PATCH — bảng quyền', () => {
    type Who = 'author' | 'orgAdmin' | 'assignee' | 'peer' | 'stranger' | 'outsider';
    const who = (w: Who) => ({ author, orgAdmin, assignee, peer, stranger, outsider })[w];
    // Việc trên meetingPublic (author là chủ), giao cho `assignee`.
    // Mỗi dòng: [người gọi, body, status].
    const table: [Who, Body, number][] = [
      // chủ meeting: được mọi thứ
      ['author', { task: 'sửa' }, 200],
      ['author', { assigneeId: null }, 200],
      ['author', { dueDate: '2026-11-05' }, 200],
      ['author', { status: 'done' }, 200],
      ['author', { status: 'dismissed' }, 200],
      // người được giao: chỉ open ↔ done
      ['assignee', { status: 'done' }, 200],
      ['assignee', { status: 'open' }, 200],
      ['assignee', { status: 'dismissed' }, 403],
      ['assignee', { task: 'sửa' }, 403],
      ['assignee', { assigneeId: null }, 403],
      ['assignee', { assigneeId: 'self' }, 403], // tự nhận / giao lại cũng là sửa nội dung
      ['assignee', { dueDate: '2026-11-05' }, 403],
      ['assignee', { status: 'done', task: 'sửa lén' }, 403], // trộn trạng thái với nội dung
      // OrgAdm: xem được (kênh công khai) nhưng meeting CÓ chủ → không quản lý được
      ['orgAdmin', { task: 'sửa' }, 403],
      ['orgAdmin', { status: 'done' }, 403],
      // member khác xem được: chỉ xem
      ['peer', { status: 'done' }, 403],
      ['peer', { task: 'sửa' }, 403],
      // người ngoài org
      ['outsider', { status: 'done' }, 404],
    ];
    it.each(table)('%s PATCH %j → %i', async (actor, body, status) => {
      const item = await newItem(meetingPublic, { assigneeId: assignee.id });
      const concrete = JSON.parse(
        JSON.stringify(body).replace('"self"', `"${assignee.id}"`),
      ) as Body;
      await patch(who(actor), item.id, concrete).expect(status);
      // chỉ 200 mới ghi: mọi lỗi (403 / 404) để nguyên version
      expect((await rowOf(item.id)).version).toBe(status === 200 ? 2 : 1);
    });

    it('việc của meeting RIÊNG: người không xem được → 404, KHÔNG phải 403 (không lộ việc tồn tại)', async () => {
      const item = await newItem(meetingPrivate, { assigneeId: author.id });
      const hidden = await patch(stranger, item.id, { status: 'done' }).expect(404);
      const missing = await patch(stranger, '00000000-0000-4000-8000-000000000000', {
        status: 'done',
      }).expect(404);
      // cùng một thân lỗi: không phân biệt được "không có" với "không xem được"
      expect(hidden.body.error).toMatchObject({
        code: missing.body.error.code,
        message: missing.body.error.message,
      });
    });

    it('người được giao nhưng KHÔNG còn xem được meeting → 404 (giao việc không cấp quyền xem)', async () => {
      const item = await newItem(meetingPrivate, { assigneeId: stranger.id });
      await patch(stranger, item.id, { status: 'done' }).expect(404);
      expect(await rowOf(item.id)).toMatchObject({ status: 'open', version: 1 });
    });

    it('meeting không chủ: Admin / Owner org sửa được (+ audit), member không xem được → 404', async () => {
      const item = await newItem(meetingOwnerless);
      await patch(peer, item.id, { task: 'x' }).expect(404);
      await patch(orgAdmin, item.id, { task: 'Admin sửa' }, 1).expect(200);
      await patch(owner, item.id, { status: 'dismissed' }, 2).expect(200);
      const audits = await auditsOf('action_item.updated', item.id);
      expect(audits.map((a) => a.actorId).sort((a, b) => a!.localeCompare(b!))).toEqual(
        [orgAdmin.id, owner.id].sort((a, b) => a.localeCompare(b)),
      );
      const first = audits.find((a) => a.actorId === orgAdmin.id)!;
      expect(first.metadata).toEqual({ fields: ['task'], fromVersion: 1, toVersion: 2 });
    });

    it('audit: chủ meeting sửa → KHÔNG ghi; đổi open ↔ done bởi người được giao → KHÔNG ghi', async () => {
      const item = await newItem(meetingPublic, { assigneeId: assignee.id });
      await patch(author, item.id, { task: 'chủ sửa' }, 1).expect(200);
      await patch(assignee, item.id, { status: 'done' }, 2).expect(200);
      expect(await auditsOf('action_item.updated', item.id)).toHaveLength(0);
    });

    it('audit: OrgAdm chỉ đổi mở ↔ xong trên việc mình được giao → KHÔNG ghi (không dùng quyền quản lý)', async () => {
      // OrgAdm không phải chủ nhưng meeting không chủ nên ĐƯỢC quản lý; chỉ đổi trạng thái thì không cần quyền đó.
      const item = await newItem(meetingOwnerless, { assigneeId: orgAdmin.id });
      await patch(orgAdmin, item.id, { status: 'done' }).expect(200);
      expect(await auditsOf('action_item.updated', item.id)).toHaveLength(0);
    });
  });

  describe('PATCH — ngữ nghĩa trạng thái / hạn / người được giao', () => {
    it('done ghi người + lúc hoàn thành; đặt done lần nữa GIỮ NGUYÊN; về open thì xoá', async () => {
      const item = await newItem(meetingPublic, { assigneeId: assignee.id });
      const done = await patch(assignee, item.id, { status: 'done' }, 1).expect(200);
      expect(done.body.data.completedAt).not.toBeNull();
      const row1 = await rowOf(item.id);
      expect(row1.completedBy).toBe(assignee.id);

      // người KHÁC đặt done lần nữa: không cướp công
      await patch(author, item.id, { status: 'done' }, 2).expect(200);
      const row2 = await rowOf(item.id);
      expect(row2.completedBy).toBe(assignee.id);
      expect(row2.completedAt!.getTime()).toBe(row1.completedAt!.getTime());

      const reopened = await patch(assignee, item.id, { status: 'open' }, 3).expect(200);
      expect(reopened.body.data).toMatchObject({ status: 'open', completedAt: null });
      expect(await rowOf(item.id)).toMatchObject({ completedAt: null, completedBy: null });
    });

    it('đặt hạn mới xoá dueText (chữ "thứ sáu" của model không còn khớp); bỏ hạn bằng null', async () => {
      const item = await newItem(meetingPublic, { dueText: 'thứ sáu', dueDate: '2026-10-30' });
      const moved = await patch(author, item.id, { dueDate: '2026-11-06' }, 1).expect(200);
      expect(moved.body.data).toMatchObject({ dueDate: '2026-11-06', dueText: null });
      const cleared = await patch(author, item.id, { dueDate: null }, 2).expect(200);
      expect(cleared.body.data.dueDate).toBeNull();
    });

    it('chỉ sửa task thì KHÔNG đụng dueText (đột biến: xoá dueText mọi lần sửa)', async () => {
      const item = await newItem(meetingPublic, { dueText: 'thứ sáu', dueDate: '2026-10-30' });
      const res = await patch(author, item.id, { task: 'đổi tên' }).expect(200);
      expect(res.body.data).toMatchObject({ dueText: 'thứ sáu', dueDate: '2026-10-30' });
    });

    it('sửa việc AI giữ origin ai (không "biến" thành manual) và không đụng source_index', async () => {
      const item = await newItem(meetingPublic, { origin: 'ai', sourceIndex: 7 });
      const res = await patch(author, item.id, { task: 'người sửa lại' }).expect(200);
      expect(res.body.data.origin).toBe('ai');
      expect(await rowOf(item.id)).toMatchObject({ origin: 'ai', sourceIndex: 7 });
    });

    it('giao: người xem được → 200; không phải thành viên / không xem được → 422; null → bỏ giao', async () => {
      const item = await newItem(meetingPrivate);
      const to = (assigneeId: string | null, version: number) =>
        patch(author, item.id, { assigneeId }, version);
      expect((await to(stranger.id, 1).expect(422)).body.error.code).toBe(
        'ACTION_ITEM_ASSIGNEE_INVALID',
      );
      await to(outsider.id, 1).expect(422);
      expect((await rowOf(item.id)).version).toBe(1); // 422 không ghi gì, không tăng version
      const ok = await to(author.id, 1).expect(200);
      expect(ok.body.data.assignee.id).toBe(author.id);
      const cleared = await to(null, 2).expect(200);
      expect(cleared.body.data.assignee).toBeNull();
    });

    it('gửi lại ĐÚNG người đang được giao (đã mất quyền xem) không làm hỏng việc sửa field khác', async () => {
      const priv = await insertChannel(db, orgId, owner.id, { visibility: 'private' });
      await addChannelMember(db, priv, orgId, assignee.id);
      const meeting = (await insertMeeting(db, orgId, author.id, { status: 'completed' })).id;
      await shareMeeting(db, orgId, meeting, priv.id, author.id);
      const item = await newItem(meeting, { assigneeId: assignee.id });
      // assignee rời kênh riêng → không còn xem được meeting
      await db
        .delete(channelMembers)
        .where(and(eq(channelMembers.channelId, priv.id), eq(channelMembers.userId, assignee.id)));

      await patch(author, item.id, { assigneeId: assignee.id, task: 'vẫn sửa được' }, 1).expect(
        200,
      );
      // nhưng ĐỔI sang một người khác không xem được thì vẫn 422
      const other = await patch(author, item.id, { assigneeId: peer.id }, 2).expect(422);
      expect(other.body.error.code).toBe('ACTION_ITEM_ASSIGNEE_INVALID'); // peer không thuộc kênh riêng
    });
  });

  describe('PATCH — việc đã bỏ (dismissed)', () => {
    it('chủ meeting khôi phục được (dismissed → open) và sửa nội dung việc đã bỏ', async () => {
      const item = await newItem(meetingPublic, { status: 'dismissed', assigneeId: assignee.id });
      await patch(author, item.id, { task: 'sửa khi đã bỏ' }, 1).expect(200);
      const back = await patch(author, item.id, { status: 'open' }, 2).expect(200);
      expect(back.body.data.status).toBe('open');
    });

    it('người được giao KHÔNG cứu được việc đã bỏ (dismissed → open / done → 403)', async () => {
      const item = await newItem(meetingPublic, { status: 'dismissed', assigneeId: assignee.id });
      await patch(assignee, item.id, { status: 'open' }, 1).expect(403);
      await patch(assignee, item.id, { status: 'done' }, 1).expect(403);
      expect((await rowOf(item.id)).status).toBe('dismissed');
    });

    it('dismissed → done trực tiếp (chủ meeting) ghi completed_*; dismissed giữ nguyên dòng, không xoá', async () => {
      const item = await newItem(meetingPublic, { status: 'dismissed' });
      const done = await patch(author, item.id, { status: 'done' }).expect(200);
      expect(done.body.data.completedAt).not.toBeNull();
      const dismissed = await newItem(meetingPublic);
      await patch(author, dismissed.id, { status: 'dismissed' }).expect(200);
      expect(await rowOf(dismissed.id)).toMatchObject({ status: 'dismissed' });
    });
  });
});
