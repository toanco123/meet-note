import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { channels } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('Meetings: xem chi tiết / danh sách theo quyền (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let author: TestUser;
  let host: TestUser;
  let chMember: TestUser;
  let outsider: TestUser;
  let stranger: TestUser;
  let priv: string;
  let pub: string;

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const getMeeting = (who: TestUser, id: string) =>
    http().get(`/v1/orgs/${orgId}/meetings/${id}`).set(as(who));
  const list = (who: TestUser, query: Record<string, string | number> = {}, org = orgId) =>
    http().get(`/v1/orgs/${org}/meetings`).query(query).set(as(who));
  /** Org riêng cho test danh sách: không lẫn meeting kênh công khai của các test khác. */
  const freshOrg = async () => {
    const someone = await registerUser(app);
    const id = (await http().post('/v1/orgs').set(as(someone)).send({ name: 'Riêng' }).expect(201))
      .body.data.id as string;
    return { someone, org: id };
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    const users: TestUser[] = [];
    for (let i = 0; i < 7; i++) users.push(await registerUser(app));
    [owner, orgAdmin, author, host, chMember, outsider, stranger] = users as [
      TestUser,
      TestUser,
      TestUser,
      TestUser,
      TestUser,
      TestUser,
      TestUser,
    ];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Họp' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [author, host, chMember, outsider]) await addMember(db, orgId, u.id);
    priv = (await insertChannel(db, orgId, host.id, { name: 'Riêng', visibility: 'private' })).id;
    pub = (await insertChannel(db, orgId, host.id, { name: 'Chung', visibility: 'public' })).id;
    await addChannelMember(db, { id: priv }, orgId, chMember.id);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /meetings/:id', () => {
    it('ma trận người gọi → 200 / 404 (không xem được = như không tồn tại)', async () => {
      const inPriv = (await insertMeeting(db, orgId, author.id)).id;
      await shareMeeting(db, orgId, inPriv, priv);
      const orphan = (await insertMeeting(db, orgId, null)).id;

      const cases: Array<[string, TestUser, string, number]> = [
        ['chủ', author, inPriv, 200],
        ['thành viên kênh riêng tư', chMember, inPriv, 200],
        ['thành viên org ngoài kênh riêng tư', outsider, inPriv, 404],
        ['Admin org, kênh riêng tư (D2)', orgAdmin, inPriv, 404],
        ['Admin org, meeting không chủ (Q2)', orgAdmin, orphan, 200],
        ['Owner org, meeting không chủ (Q2)', owner, orphan, 200],
        ['thành viên thường, meeting không chủ', outsider, orphan, 404],
        ['người ngoài org', stranger, inPriv, 404],
        ['id không tồn tại', author, randomUUID(), 404],
      ];
      const results = await Promise.all(
        cases.map(async ([label, who, id]) => [label, (await getMeeting(who, id)).status]),
      );
      expect(results).toEqual(cases.map(([label, , , status]) => [label, status]));
      expect((await getMeeting(author, 'abc')).status).toBe(400);
    });

    it('`channels` chỉ gồm kênh người gọi THẤY được; Admin org thấy metadata kênh riêng tư', async () => {
      const both = (await insertMeeting(db, orgId, author.id)).id;
      await shareMeeting(db, orgId, both, priv);
      await shareMeeting(db, orgId, both, pub);
      const names = async (who: TestUser) =>
        (
          (await getMeeting(who, both).expect(200)).body.data.channels as Array<{ name: string }>
        ).map((c) => c.name);

      expect([await names(chMember), await names(outsider), await names(orgAdmin)]).toEqual([
        ['Chung', 'Riêng'],
        ['Chung'],
        ['Chung', 'Riêng'],
      ]);
    });
  });

  describe('GET /meetings', () => {
    it('25 meeting, nhiều cái TRÙNG recorded_at → đi hết các trang: không lặp, không sót, đúng thứ tự', async () => {
      const { someone, org } = await freshOrg();
      const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 2, minute));
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        // 5 mốc thời gian × 5 meeting cùng mốc → id là tie-breaker thật sự được dùng.
        ids.push((await insertMeeting(db, org, someone.id, { recordedAt: at(i % 5) })).id);
      }

      const seen: Array<{ id: string; recordedAt: string }> = [];
      let cursor: string | null = null;
      do {
        const res: request.Response = await list(
          someone,
          // limit 7: biên trang rơi GIỮA một nhóm cùng `recorded_at` (5 / nhóm) — limit 10 thì rơi
          // đúng chỗ hết nhóm và cursor thiếu tie-breaker `id` vẫn xanh (đã gặp).
          cursor ? { limit: 7, cursor } : { limit: 7 },
          org,
        ).expect(200);
        seen.push(...(res.body.data as Array<{ id: string; recordedAt: string }>));
        cursor = res.body.meta.nextCursor;
      } while (cursor);

      const expected = [...seen].sort((a, b) =>
        a.recordedAt === b.recordedAt
          ? b.id.localeCompare(a.id)
          : b.recordedAt.localeCompare(a.recordedAt),
      );
      expect(seen.map((m) => m.id)).toEqual(expected.map((m) => m.id));
      expect([...seen.map((m) => m.id)].sort()).toEqual([...ids].sort());
    });

    it('lọc status + khoảng thời gian (from gồm, to không gồm)', async () => {
      const { someone, org } = await freshOrg();
      const mk = (iso: string, status: 'queued' | 'failed' = 'queued') =>
        insertMeeting(db, org, someone.id, { recordedAt: new Date(iso), status });
      const [a, , c] = [
        await mk('2026-10-01T00:00:00Z'),
        await mk('2026-10-02T00:00:00Z', 'failed'),
        await mk('2026-10-03T00:00:00Z'),
      ];
      const ids = async (q: Record<string, string>) =>
        ((await list(someone, q, org).expect(200)).body.data as Array<{ id: string }>).map(
          (m) => m.id,
        );

      expect(
        await ids({ status: 'queued', from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }),
      ).toEqual([a.id]);
      expect(await ids({ from: '2026-10-03T00:00:00Z' })).toEqual([c.id]);
      expect((await list(someone, { from: 'hôm qua' }, org)).status).toBe(400);
      expect((await list(someone, { cursor: 'rác' }, org)).status).toBe(400);
    });

    /**
     * Không kiểm quyền kênh khi lọc = lộ nội dung kênh riêng tư: `outsider` thấy meeting M qua kênh
     * công khai, lọc `channelId` = kênh riêng tư chứa M → biết M nằm trong kênh đó.
     */
    it('lọc channelId: chỉ khi đọc được nội dung kênh — ngoài kênh riêng tư 404, Admin org 403', async () => {
      const m = (await insertMeeting(db, orgId, author.id)).id;
      await shareMeeting(db, orgId, m, priv);
      await shareMeeting(db, orgId, m, pub);
      const deleted = (await insertChannel(db, orgId, host.id)).id;
      await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deleted));

      const results = await Promise.all([
        list(chMember, { channelId: priv }),
        list(outsider, { channelId: pub }),
        list(outsider, { channelId: priv }),
        list(orgAdmin, { channelId: priv }),
        list(chMember, { channelId: deleted }),
        list(chMember, { channelId: randomUUID() }),
      ]);

      expect(
        results.map((r) =>
          r.status === 200
            ? (r.body.data as Array<{ id: string }>).some((x) => x.id === m)
            : `${r.status} ${r.body.error.code}`,
        ),
      ).toEqual([true, true, '404 NOT_FOUND', '403 FORBIDDEN', '404 NOT_FOUND', '404 NOT_FOUND']);
    });
  });
});
