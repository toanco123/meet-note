import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { notifications } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { addMember } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

/** API thông báo của chính người gọi (M10 B3). */
describe('Thông báo: API (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Chèn thẳng (kiểm soát `created_at` / `org_id` / `read_at`). */
  async function seed(
    userId: string,
    count: number,
    over: Partial<typeof notifications.$inferInsert> = {},
  ): Promise<string[]> {
    const rows = await db
      .insert(notifications)
      .values(
        Array.from({ length: count }, () => ({
          userId,
          type: 'channel.member_added' as const,
          payload: { channelName: 'K' },
          ...over,
        })),
      )
      .returning({ id: notifications.id });
    return rows.map((r) => r.id);
  }
  const ids = (r: request.Response) => (r.body.data as Array<{ id: string }>).map((n) => n.id);
  const count = async (u: TestUser, q = '') =>
    (await http().get(`/v1/notifications/unread-count${q}`).set(as(u)).expect(200)).body.data;

  it('danh sách: 25 thông báo, nhóm TRÙNG created_at, limit 7 → đủ, không lặp, đúng thứ tự; không thấy của người khác / đã xoá', async () => {
    const [me, other] = [await registerUser(app), await registerUser(app)];
    const mine: string[] = [];
    for (let g = 0; g < 5; g++) {
      mine.push(...(await seed(me.id, 5, { createdAt: new Date(Date.UTC(2026, 9, 1, 0, g)) })));
    }
    const [deleted] = await seed(me.id, 1, { deletedAt: new Date() });
    await seed(other.id, 3);

    const seen: Array<{ id: string; createdAt: string }> = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await http()
        .get('/v1/notifications')
        .query(cursor ? { limit: 7, cursor } : { limit: 7 })
        .set(as(me))
        .expect(200);
      seen.push(...(res.body.data as Array<{ id: string; createdAt: string }>));
      cursor = res.body.meta.nextCursor;
    } while (cursor);

    const sorted = [...seen].sort((a, b) =>
      a.createdAt === b.createdAt
        ? b.id.localeCompare(a.id)
        : b.createdAt.localeCompare(a.createdAt),
    );
    expect(seen.map((n) => n.id)).toEqual(sorted.map((n) => n.id));
    expect([seen.map((n) => n.id).sort(), seen.some((n) => n.id === deleted)]).toEqual([
      [...mine].sort(),
      false,
    ]);
  });

  it('lọc orgId + unreadOnly; đếm chưa đọc theo tổ chức; từ 100 trở lên → "99+"', async () => {
    const me = await registerUser(app);
    const orgId = (await http().post('/v1/orgs').set(as(me)).send({ name: 'N' }).expect(201)).body
      .data.id as string;
    const [inOrg] = await seed(me.id, 1, { orgId });
    await seed(me.id, 1, { orgId, readAt: new Date() });
    await seed(me.id, 2);

    const filtered = await http()
      .get('/v1/notifications')
      .query({ orgId, unreadOnly: 'true' })
      .set(as(me))
      .expect(200);
    const before = [await count(me), await count(me, `?orgId=${orgId}`)];
    await seed(me.id, 150);

    expect([ids(filtered), before, await count(me)]).toEqual([
      [inOrg],
      [
        { count: 3, display: '3' },
        { count: 1, display: '1' },
      ],
      { count: 100, display: '99+' },
    ]);
  });

  it('đọc: 204 → readAt có; đọc lại 204 không đổi mốc; của người khác / không tồn tại → 404; id sai → 400', async () => {
    const [me, other] = [await registerUser(app), await registerUser(app)];
    const [mine] = (await seed(me.id, 1)) as [string];
    const [theirs] = (await seed(other.id, 1)) as [string];
    const readAt = async () =>
      (await db.select().from(notifications).where(eq(notifications.id, mine)))[0]?.readAt;

    await http().post(`/v1/notifications/${mine}/read`).set(as(me)).expect(204);
    const first = await readAt();
    await http().post(`/v1/notifications/${mine}/read`).set(as(me)).expect(204);

    const results = await Promise.all([
      http().post(`/v1/notifications/${theirs}/read`).set(as(me)),
      http().post(`/v1/notifications/${randomUUID()}/read`).set(as(me)),
      http().post('/v1/notifications/abc/read').set(as(me)),
    ]);
    expect([first instanceof Date, (await readAt())?.getTime() === first?.getTime()]).toEqual([
      true,
      true,
    ]);
    expect(results.map((r) => r.status)).toEqual([404, 404, 400]);
  });

  it('đọc hết trong MỘT tổ chức → chỉ thông báo tổ chức đó; không có orgId → tất cả', async () => {
    const me = await registerUser(app);
    const orgId = (await http().post('/v1/orgs').set(as(me)).send({ name: 'R' }).expect(201)).body
      .data.id as string;
    await seed(me.id, 2, { orgId });
    await seed(me.id, 3);

    await http().post('/v1/notifications/read-all').query({ orgId }).set(as(me)).expect(204);
    const afterOrg = await count(me);
    await http().post('/v1/notifications/read-all').set(as(me)).expect(204);

    expect([afterOrg.count, (await count(me)).count]).toEqual([3, 0]);
  });

  it('xoá: 204 → biến mất khỏi danh sách + đếm; xoá lại 204; của người khác → 404', async () => {
    const [me, other] = [await registerUser(app), await registerUser(app)];
    const [mine] = (await seed(me.id, 1)) as [string];
    const [theirs] = (await seed(other.id, 1)) as [string];

    await http().delete(`/v1/notifications/${mine}`).set(as(me)).expect(204);
    await http().delete(`/v1/notifications/${mine}`).set(as(me)).expect(204);
    const list = await http().get('/v1/notifications').set(as(me)).expect(200);

    expect([
      ids(list),
      (await count(me)).count,
      (await http().delete(`/v1/notifications/${theirs}`).set(as(me))).status,
    ]).toEqual([[], 0, 404]);
  });

  it('rời tổ chức → thông báo của tổ chức đó không còn (Q3), thông báo khác giữ nguyên', async () => {
    const [owner, me] = [await registerUser(app), await registerUser(app)];
    const orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'L' }).expect(201))
      .body.data.id as string;
    await addMember(db, orgId, me.id);
    await seed(me.id, 2, { orgId });
    const [keep] = await seed(me.id, 1);

    await http().post(`/v1/orgs/${orgId}/leave`).set(as(me)).expect(204);

    expect(ids(await http().get('/v1/notifications').set(as(me)).expect(200))).toEqual([keep]);
  });
});
