import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../src/common/errors/pg-error.js';
import { createPgPool } from '../../../../src/infra/database/database.module.js';
import type { Database } from '../../../../src/infra/database/database.types.js';
import { OrgContext } from '../../../../src/infra/database/org-context.js';
import * as schema from '../../../../src/infra/database/schema/index.js';
import { meetings } from '../../../../src/infra/database/schema/index.js';
import { insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/**
 * RLS ranh giới tổ chức (M11 B7) trên pool THẬT của app (`createPgPool`, user api, `max: 1` để mọi
 * request dùng CHUNG một connection — chỗ ngữ cảnh dễ rò nhất). Dữ liệu dựng bằng chủ schema.
 */
describe('RLS: ranh giới tổ chức qua app.org_id', () => {
  let owner: TestDb;
  let pool: Pool;
  let db: Database;
  const orgs: Array<{ id: string; meetingId: string }> = [];

  beforeAll(async () => {
    owner = createTestDb(1, process.env.TEST_ADMIN_DATABASE_URL);
    for (let i = 0; i < 2; i++) {
      const u = await insertUser(owner.db);
      const org = await insertOrg(owner.db, u.id);
      orgs.push({ id: org.id, meetingId: (await insertMeeting(owner.db, org.id, u.id)).id });
    }
    pool = createPgPool({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
      applicationName: 'rls-test',
      lockTimeoutMs: 1_000,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 5_000,
    });
    db = drizzle({ client: pool, schema, casing: 'snake_case' });
  });

  afterAll(async () => {
    await pool.end();
    await owner.close();
  });

  const [a, b] = [() => orgs[0]!, () => orgs[1]!];
  const visibleIds = async () =>
    (await db.select({ id: meetings.id }).from(meetings)).map((r) => r.id);

  it('không có ngữ cảnh → không thấy dòng nào (an toàn mặc định)', async () => {
    expect(await OrgContext.run(visibleIds)).toEqual([]);
    expect(await visibleIds()).toEqual([]); // hoàn toàn ngoài AsyncLocalStorage
  });

  // Đột biến: policy chỉ `ENABLE` không `FORCE`… không áp được ở đây (user api không phải chủ bảng);
  // đột biến thật: bỏ hẳn policy của meetings → thấy cả hai tổ chức.
  it('trong tổ chức A: chỉ thấy A; "quên org_id" — đọc thẳng theo id meeting của B → không thấy', async () => {
    const [mine, foreign] = await OrgContext.runInOrg(a().id, async () => [
      await visibleIds(),
      await db.select().from(meetings).where(eq(meetings.id, b().meetingId)),
    ]);
    expect([mine, foreign]).toEqual([[a().meetingId], []]);
  });

  it('ghi chéo: trong ngữ cảnh A chèn meeting của B → WITH CHECK chặn (42501)', async () => {
    const error = await OrgContext.runInOrg(a().id, () =>
      db
        .insert(meetings)
        .values({ orgId: b().id, title: 'Chéo', recordedAt: new Date(), sourceObjectKey: 'x' })
        .then(
          () => undefined,
          (e: unknown) => e,
        ),
    );
    expect(findPgError(error)?.code).toBe('42501');
  });

  // Đột biến: không đặt lại `app.org_id` khi không có ngữ cảnh (chỉ đặt khi có orgId) → request sau
  // trên CÙNG connection thấy dữ liệu của tổ chức trước.
  it('ngữ cảnh KHÔNG rò sang request sau trên cùng connection (pool max 1)', async () => {
    const first = await OrgContext.runInOrg(a().id, visibleIds);
    const next = await OrgContext.run(visibleIds);
    const other = await OrgContext.runInOrg(b().id, visibleIds);
    expect([first, next, other]).toEqual([[a().meetingId], [], [b().meetingId]]);
  });

  it('request B XẾP HÀNG chờ connection A đang giữ → khi tới lượt vẫn chỉ thấy B', async () => {
    const holdA = OrgContext.runInOrg(a().id, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(0.2)`);
        return (await tx.select({ id: meetings.id }).from(meetings)).map((r) => r.id);
      }),
    );
    const queuedB = OrgContext.runInOrg(b().id, visibleIds); // pool max 1 → chờ A trả connection
    expect([await holdA, await queuedB]).toEqual([[a().meetingId], [b().meetingId]]);
  });
});
