import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { actionItems } from '../../../src/infra/database/schema/index.js';
import { addDays, localDate } from '../../../src/modules/reports/report-week.js';
import { createTestApp } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

interface Item {
  id: string;
  meetingId: string;
  meetingTitle: string;
  task: string;
  status: string;
  dueDate: string | null;
  assignee: { id: string; displayName: string } | null;
  version: number;
}

/** API đọc việc cần làm (M12 B4): quyền xem, mặc định, bộ lọc, lỗi đầu vào, cursor. */
describe('Action items — API đọc (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  let author: TestUser;
  let peer: TestUser; // trong kênh công khai (xem meeting đã share vào đó)
  let stranger: TestUser; // member org, không xem được meeting riêng của author
  let pubChannel: string;
  let privChannel: string;
  let meetingPublic: string; // author, share vào kênh công khai
  let meetingPrivate: string; // author, không share
  let meetingInPrivChannel: string; // author, share vào kênh riêng tư
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const today = localDate(new Date());
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, author, peer, stranger] = (await Promise.all(
      Array.from({ length: 4 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Việc' }).expect(201)).body
      .data.id as string;
    for (const u of [author, peer, stranger]) await addMember(db, orgId, u.id);
    pubChannel = (await insertChannel(db, orgId, owner.id, { visibility: 'public' })).id;
    const priv = await insertChannel(db, orgId, owner.id, { visibility: 'private' });
    privChannel = priv.id;
    await addChannelMember(db, { id: pubChannel }, orgId, peer.id);

    const mk = async (title: string, share?: string) => {
      const m = await insertMeeting(db, orgId, author.id, { title, status: 'completed' });
      if (share) await shareMeeting(db, orgId, m.id, share, author.id);
      return m.id;
    };
    meetingPublic = await mk('Họp công khai', pubChannel);
    meetingPrivate = await mk('Họp riêng của author');
    meetingInPrivChannel = await mk('Họp kênh riêng', privChannel);

    const add = (
      meetingId: string,
      task: string,
      over: Partial<typeof actionItems.$inferInsert> = {},
    ) =>
      db.insert(actionItems).values({
        orgId,
        meetingId,
        origin: 'manual',
        task,
        ...over,
      });
    // meetingPublic: 5 việc đủ trạng thái / hạn
    await add(meetingPublic, 'quá hạn của peer', {
      dueDate: yesterday,
      assigneeId: peer.id,
      ownerName: 'Peer',
    });
    await add(meetingPublic, 'hạn hôm nay của peer', { dueDate: today, assigneeId: peer.id });
    await add(meetingPublic, 'hạn mai chưa giao', { dueDate: tomorrow });
    await add(meetingPublic, 'không hạn của author', { assigneeId: author.id });
    await add(meetingPublic, 'xong rồi', {
      status: 'done',
      completedAt: new Date(),
      dueDate: yesterday,
      assigneeId: peer.id,
    });
    await add(meetingPublic, 'bỏ rồi', { status: 'dismissed', assigneeId: peer.id });
    // meeting riêng của author: peer / stranger KHÔNG được thấy
    await add(meetingPrivate, 'bí mật của author', { dueDate: yesterday, assigneeId: peer.id });
    await add(meetingInPrivChannel, 'trong kênh riêng', { dueDate: today });
    // org khác
    const strangerOrg = await insertUser(db);
    const otherOrg = (await insertOrg(db, strangerOrg.id)).id;
    const foreign = await insertMeeting(db, otherOrg, strangerOrg.id);
    await db
      .insert(actionItems)
      .values({ orgId: otherOrg, meetingId: foreign.id, origin: 'manual', task: 'org khác' });
  });

  afterAll(async () => {
    await app.close();
  });

  const list = (u: TestUser, query: Record<string, unknown> = {}) =>
    http().get(`/v1/orgs/${orgId}/action-items`).query(query).set(as(u));
  const tasks = (body: { data: Item[] }) => body.data.map((i) => i.task);

  describe('GET /meetings/:meetingId/action-items', () => {
    const url = (id: string) => `/v1/orgs/${orgId}/meetings/${id}/action-items`;

    it('người xem được thấy MỌI trạng thái, theo thứ tự tạo, kèm người được giao và tiêu đề meeting', async () => {
      const res = await http().get(url(meetingPublic)).set(as(peer)).expect(200);
      expect(tasks(res.body)).toEqual([
        'quá hạn của peer',
        'hạn hôm nay của peer',
        'hạn mai chưa giao',
        'không hạn của author',
        'xong rồi',
        'bỏ rồi',
      ]);
      const first = res.body.data[0] as Item;
      expect(first).toMatchObject({
        meetingId: meetingPublic,
        meetingTitle: 'Họp công khai',
        status: 'open',
        dueDate: yesterday,
        version: 1,
        assignee: { id: peer.id, displayName: expect.any(String) },
      });
      expect((res.body.data[2] as Item).assignee).toBeNull();
    });

    it('phân trang theo id: limit=2 đi hết 6 việc, không lặp, không sót', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await http()
          .get(url(meetingPublic))
          .query({ limit: 2, ...(cursor && { cursor }) })
          .set(as(peer))
          .expect(200);
        seen.push(...tasks(res.body));
        cursor = res.body.meta.nextCursor as string | undefined;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
    });

    it('không xem được meeting → 404 (không lộ tồn tại); id lạ 404; không phải uuid 400; chưa đăng nhập 401', async () => {
      const code = async (req: request.Test) => (await req).status;
      expect([
        await code(http().get(url(meetingPrivate)).set(as(stranger))),
        await code(http().get(url(meetingPrivate)).set(as(peer))),
        await code(http().get(url('00000000-0000-7000-8000-000000000000')).set(as(peer))),
        await code(http().get(url('khong-phai-uuid')).set(as(peer))),
        await code(http().get(url(meetingPublic))),
      ]).toEqual([404, 404, 404, 400, 401]);
    });

    it('meeting chưa có việc → trang rỗng, không lỗi', async () => {
      const empty = await insertMeeting(db, orgId, author.id, { status: 'summarizing' });
      const res = await http().get(url(empty.id)).set(as(author)).expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /action-items (xuyên meeting)', () => {
    it('mặc định chỉ việc OPEN của meeting xem được, theo hạn (gần trước, không hạn cuối); không lộ meeting riêng / org khác', async () => {
      const res = await list(peer).expect(200);
      expect(tasks(res.body)).toEqual([
        'quá hạn của peer',
        'hạn hôm nay của peer',
        'hạn mai chưa giao',
        'không hạn của author',
      ]);
      // Việc "bí mật của author" giao cho peer nhưng peer không xem được meeting → KHÔNG hiện.
      expect(tasks(res.body)).not.toContain('bí mật của author');
      expect(tasks(res.body)).not.toContain('org khác');
    });

    it('assignee=me: việc giao cho tôi và tôi xem được meeting', async () => {
      const res = await list(peer, { assignee: 'me' }).expect(200);
      expect(tasks(res.body)).toEqual(['quá hạn của peer', 'hạn hôm nay của peer']);
      const mine = await list(author, { assignee: 'me' }).expect(200);
      expect(tasks(mine.body)).toEqual(['không hạn của author']);
    });

    it('status=done / dismissed; status khác open KHÔNG lẫn việc open', async () => {
      expect(tasks((await list(peer, { status: 'done' }).expect(200)).body)).toEqual(['xong rồi']);
      expect(tasks((await list(peer, { status: 'dismissed' }).expect(200)).body)).toEqual([
        'bỏ rồi',
      ]);
    });

    it('overdue=true: chỉ việc open hạn TRƯỚC hôm nay (giờ VN) — hạn hôm nay chưa quá hạn, việc done thì không', async () => {
      const res = await list(peer, { overdue: 'true' }).expect(200);
      expect(tasks(res.body)).toEqual(['quá hạn của peer']);
      // overdue=false = không lọc quá hạn
      expect(tasks((await list(peer, { overdue: 'false' }).expect(200)).body)).toHaveLength(4);
      // Kết hợp với status=done: việc done không bao giờ "quá hạn".
      expect((await list(peer, { overdue: 'true', status: 'done' }).expect(200)).body.data).toEqual(
        [],
      );
    });

    it('chủ meeting thấy cả meeting riêng; member khác thì không', async () => {
      const mine = tasks((await list(author).expect(200)).body);
      expect(mine).toContain('bí mật của author');
      expect(mine).toContain('trong kênh riêng');
      // `stranger` là thành viên org nên thấy meeting ở kênh CÔNG KHAI (điều 3 của quyền xem), nhưng
      // không thấy meeting riêng của author hay meeting ở kênh riêng tư mình không tham gia.
      const seen = tasks((await list(stranger).expect(200)).body);
      expect(seen).toContain('hạn mai chưa giao');
      expect(seen).not.toContain('bí mật của author');
      expect(seen).not.toContain('trong kênh riêng');
    });

    it('channelId: chỉ việc của meeting chia sẻ vào kênh; kênh riêng không đọc được → lỗi', async () => {
      const res = await list(author, { channelId: pubChannel }).expect(200);
      expect(tasks(res.body)).toEqual([
        'quá hạn của peer',
        'hạn hôm nay của peer',
        'hạn mai chưa giao',
        'không hạn của author',
      ]);
      const priv = await list(author, { channelId: privChannel });
      // author không phải thành viên kênh riêng này → không đọc được nội dung kênh
      expect([403, 404]).toContain(priv.status);
    });

    it('phân trang qua ranh giới hạn → không hạn: limit=1 đi hết, đúng thứ tự, không lặp', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await list(peer, { limit: 1, ...(cursor && { cursor }) }).expect(200);
        seen.push(...tasks(res.body));
        cursor = res.body.meta.nextCursor as string | undefined;
        if (!cursor) break;
      }
      expect(seen).toEqual([
        'quá hạn của peer',
        'hạn hôm nay của peer',
        'hạn mai chưa giao',
        'không hạn của author',
      ]);
    });

    // Đột biến: khoá cursor của việc KHÔNG hạn là ngày giả (thay vì chuỗi rỗng) → trang sau lặp việc.
    // Oracle ở repository dựng `after` trực tiếp nên KHÔNG kiểm bước map khoá này của service.
    it('cursor đi qua nhóm việc KHÔNG hạn (nhiều việc không hạn): phân trang khớp danh sách một lượt, không lặp', async () => {
      const m = await insertMeeting(db, orgId, author.id, {
        title: 'Họp nhiều việc không hạn',
        status: 'completed',
      });
      await db.insert(actionItems).values(
        ['k1', 'k2', 'k3', 'k4'].map((task) => ({
          orgId,
          meetingId: m.id,
          origin: 'manual' as const,
          task: `không hạn ${task}`,
        })),
      );
      const whole = tasks((await list(author, { limit: 100 }).expect(200)).body);
      for (const limit of [1, 2, 3]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 30; i++) {
          const res = await list(author, { limit, ...(cursor && { cursor }) }).expect(200);
          seen.push(...tasks(res.body));
          cursor = res.body.meta.nextCursor as string | undefined;
          if (!cursor) break;
        }
        expect(seen, `limit=${limit}`).toEqual(whole);
      }
      expect(new Set(whole).size).toBe(whole.length);
      expect(whole.filter((t) => t.startsWith('không hạn k'))).toHaveLength(4);
    });

    it('đầu vào sai → 400: assignee lạ, status lạ, overdue không phải true/false, limit 0, channelId không phải uuid', async () => {
      const codes: number[] = [];
      for (const query of [
        { assignee: 'you' },
        { status: 'x' },
        { overdue: 'maybe' },
        { limit: 0 },
        { channelId: 'nope' },
      ]) {
        codes.push((await list(peer, query)).status);
      }
      expect(codes).toEqual([400, 400, 400, 400, 400]);
    });

    it('cursor hỏng / cursor của danh sách khác (1 khoá) / khoá sai kiểu → 400 INVALID_CURSOR', async () => {
      const first = await http()
        .get(`/v1/orgs/${orgId}/meetings/${meetingPublic}/action-items`)
        .query({ limit: 1 })
        .set(as(peer))
        .expect(200);
      const oneKeyCursor = first.body.meta.nextCursor as string;
      const bad = (keys: unknown[]) =>
        Buffer.from(JSON.stringify({ v: 1, k: keys })).toString('base64url');
      for (const cursor of [
        'rác',
        oneKeyCursor,
        bad(['không-phải-ngày', 'x']),
        bad(['2026-01-01', 'không-phải-uuid']),
      ]) {
        const res = await list(peer, { cursor }).expect(400);
        expect(res.body.error.code).toBe('INVALID_CURSOR');
      }
    });

    it('chưa đăng nhập 401; không phải thành viên org 404', async () => {
      expect((await http().get(`/v1/orgs/${orgId}/action-items`)).status).toBe(401);
      const outsider = await registerUser(app);
      expect((await list(outsider)).status).toBe(404);
    });
  });
});
