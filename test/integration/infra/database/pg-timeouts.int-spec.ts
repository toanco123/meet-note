import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool } from '../../../../src/infra/database/database.module.js';
import type { Database } from '../../../../src/infra/database/database.types.js';
import * as schema from '../../../../src/infra/database/schema/index.js';
import { users } from '../../../../src/infra/database/schema/index.js';
import { findPgError } from '../../../../src/common/errors/pg-error.js';

/**
 * Ba timeout phía Postgres (M11 B1) trên pool THẬT của app (`createPgPool`), với giá trị ngắn để
 * test nhanh. Mỗi ca ghi đột biến làm nó đỏ.
 */
describe('Timeout của Postgres trên pool của app', () => {
  let pool: Pool;
  let db: Database;
  /** Connection ngoài pool: giữ khoá như một transaction khác đang chạy. */
  let holder: Pool;

  beforeAll(() => {
    pool = createPgPool({
      connectionString: process.env.DATABASE_URL!,
      max: 4,
      applicationName: 'pg-timeouts-test',
      lockTimeoutMs: 300,
      statementTimeoutMs: 500,
      // Phải lớn hơn lock timeout — xem `createPgPool`.
      idleInTransactionTimeoutMs: 1_000,
    });
    db = drizzle({ client: pool, schema, casing: 'snake_case' });
    holder = createPgPool({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
      applicationName: 'pg-timeouts-holder',
      lockTimeoutMs: 60_000,
      statementTimeoutMs: 60_000,
      idleInTransactionTimeoutMs: 120_000,
    });
  });

  it('cấu hình sai thứ tự (lock ≥ idle) → không cho tạo pool', () => {
    expect(() =>
      createPgPool({
        connectionString: process.env.DATABASE_URL!,
        max: 1,
        applicationName: 'x',
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
        idleInTransactionTimeoutMs: 1_000,
      }),
    ).toThrow('DATABASE_LOCK_TIMEOUT_MS');
  });

  afterAll(async () => {
    await pool.end();
    await holder.end();
  });

  const newUser = async () => {
    const [row] = await db
      .insert(users)
      .values({ email: `t-${randomUUID()}@example.com`, displayName: 'T', passwordHash: 'x' })
      .returning({ id: users.id });
    return row!.id;
  };
  const elapsed = async (run: () => Promise<unknown>) => {
    const started = Date.now();
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    return { ms: Date.now() - started, code: findPgError(error)?.code };
  };

  // Đột biến: bỏ `lock_timeout` → chờ tới khi holder nhả (2 s) rồi THÀNH CÔNG.
  it('chờ khoá quá `lock_timeout` → lỗi 55P03 nhanh, không chờ transaction kia', async () => {
    const id = await newUser();
    const client = await holder.connect();
    await client.query('begin');
    await client.query('select 1 from users where id = $1 for update', [id]);
    const release = sleep(2_000).then(async () => {
      await client.query('rollback');
      client.release();
    });

    const result = await elapsed(() =>
      db.update(users).set({ displayName: 'U' }).where(eq(users.id, id)),
    );
    await release;

    expect(result.code).toBe('55P03');
    expect(result.ms).toBeLessThan(1_500);
  });

  // Đột biến: bỏ `statement_timeout` → `pg_sleep(2)` chạy hết và thành công.
  it('câu lệnh quá `statement_timeout` → lỗi 57014', async () => {
    const result = await elapsed(() => pool.query('select pg_sleep(2)'));
    expect([result.code, result.ms < 1_500]).toEqual(['57014', true]);
  });

  // M3 bài học 5: trong transaction có khoá, lỡ dùng `db` (connection KHÁC) chạm đúng dòng đó →
  // trước đây treo vô hạn (Postgres không thấy deadlock: A chỉ "idle in transaction"). Giờ: lệnh
  // của connection B hết `lock_timeout` → ném → transaction A rollback.
  it('tái hiện M3 bài học 5: dùng `db` trong transaction có khoá → lỗi sau ~lock_timeout, không treo', async () => {
    const id = await newUser();
    const result = await elapsed(() =>
      db.transaction(async (tx) => {
        await tx.select().from(users).where(eq(users.id, id)).for('update');
        await db.delete(users).where(eq(users.id, id)); // BUG cố ý: `db` thay vì `tx`
      }),
    );
    expect([result.code, result.ms < 1_500]).toEqual(['55P03', true]);
  });

  // Đột biến: bỏ listener 'error' gắn cho client lúc tạo → uncaught exception, cả lượt test đỏ.
  it('transaction bỏ dở quá `idle_in_transaction_session_timeout` → session bị cắt, tiến trình KHÔNG chết, pool vẫn chạy', async () => {
    const id = await newUser();
    const client = await pool.connect();
    await client.query('begin');
    await client.query('select 1 from users where id = $1 for update', [id]);
    await sleep(1_500); // Postgres cắt session lúc ~1 s — khi app vẫn đang "mượn" connection

    const error = await client.query('select 1').then(
      () => undefined,
      (e: unknown) => e,
    );
    client.release(error instanceof Error ? error : undefined);

    // Khoá đã được nhả cùng session → connection khác cập nhật ngay được.
    await db.update(users).set({ displayName: 'Sau' }).where(eq(users.id, id));
    expect(error).toBeInstanceOf(Error);
    expect((await pool.query('select 1 as ok')).rows).toEqual([{ ok: 1 }]);
  });
});
