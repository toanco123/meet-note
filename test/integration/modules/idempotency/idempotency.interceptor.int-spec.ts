import type { ExecutionContext } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { defer, lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppException } from '../../../../src/common/errors/app.exception.js';
import { Errors } from '../../../../src/common/errors/errors.js';
import { idempotencyKeys } from '../../../../src/infra/database/schema/index.js';
import { IdempotencyInterceptor } from '../../../../src/modules/idempotency/idempotency.interceptor.js';
import { IdempotencyRepository } from '../../../../src/modules/idempotency/idempotency.repository.js';
import { insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { outcomeOf } from '../../../support/locks.js';

const BODY = { filename: 'a.m4a', sizeBytes: 1024, title: 'Họp' };

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  status: (code: number) => FakeResponse;
  setHeader: (name: string, value: string) => void;
}

interface Call {
  userId: string;
  key?: string;
  body?: unknown;
  path?: string;
  /** Status Nest đặt TRƯỚC khi interceptor chạy (POST → 201). */
  initialStatus?: number;
  handler: () => Promise<unknown>;
}

/**
 * Interceptor thật + repository thật (Postgres), request / response / handler GIẢ để ép đúng thứ tự
 * xen kẽ cần test: handler "treo" bằng promise mở tay, đếm số lần handler thật sự chạy.
 */
describe('IdempotencyInterceptor (Postgres thật)', () => {
  let t: TestDb;
  let repo: IdempotencyRepository;
  let interceptor: IdempotencyInterceptor;
  let userId: string;
  let keySeq = 0;
  const newKey = () => `key-${++keySeq}-${Date.now()}`;

  beforeAll(async () => {
    t = createTestDb(25);
    repo = new IdempotencyRepository(t.db);
    interceptor = new IdempotencyInterceptor(repo);
    userId = (await insertUser(t.db)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  async function call(c: Call) {
    const res: FakeResponse = {
      statusCode: c.initialStatus ?? 201,
      headers: {},
      status: (code) => {
        res.statusCode = code;
        return res;
      },
      setHeader: (name, value) => {
        res.headers[name] = value;
      },
    };
    const req = {
      method: 'POST',
      originalUrl: c.path ?? '/v1/orgs/o1/uploads',
      headers: c.key === undefined ? {} : { 'idempotency-key': c.key },
      body: c.body ?? BODY,
      user: { id: c.userId, sessionId: 's1' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    // `defer`: handler chỉ chạy khi interceptor gọi `next.handle()` VÀ subscribe — như Nest thật.
    const observable = await interceptor.intercept(context, { handle: () => defer(c.handler) });
    const data = await lastValueFrom(observable, { defaultValue: undefined });
    return {
      data,
      status: res.statusCode,
      replayed: res.headers['Idempotent-Replayed'] === 'true',
    };
  }

  const rowOf = async (key: string, user = userId) =>
    (
      await t.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, user), eq(idempotencyKeys.key, key)))
    )[0];

  function counted(result: (run: number) => unknown) {
    let runs = 0;
    const handler = async () => result(++runs);
    return { handler, runs: () => runs };
  }

  it('lần đầu chạy handler + lưu status/body; gọi lại (field khác thứ tự) → KHÔNG chạy lại, trả đúng status + body cũ', async () => {
    const key = newKey();
    const h = counted((n) => ({ id: `upload-${n}`, createdAt: new Date('2026-10-19T02:00:00Z') }));

    const first = await call({ userId, key, initialStatus: 202, handler: h.handler });
    const again = await call({
      userId,
      key,
      body: { title: 'Họp', sizeBytes: 1024, filename: 'a.m4a' },
      handler: h.handler,
    });

    expect(first).toEqual({
      data: { id: 'upload-1', createdAt: new Date('2026-10-19T02:00:00Z') },
      status: 202,
      replayed: false,
    });
    // Bản trả lại đi qua jsonb → Date thành chuỗi ISO, đúng như JSON client nhận lần đầu.
    expect(again).toEqual({
      data: { id: 'upload-1', createdAt: '2026-10-19T02:00:00.000Z' },
      status: 202,
      replayed: true,
    });
    expect(h.runs()).toBe(1);
  });

  it('request đầu ĐANG chạy → request cùng key nhận 409 IDEMPOTENCY_IN_PROGRESS; xong rồi → trả lại', async () => {
    const key = newKey();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<unknown>();
    const first = call({
      userId,
      key,
      handler: () => {
        started.resolve();
        return finish.promise;
      },
    });
    await started.promise;

    const whileRunning = await outcomeOf(
      call({ userId, key, handler: async () => 'không được chạy' }),
    );
    finish.resolve({ id: 'u1' });
    await first;
    const after = await call({ userId, key, handler: async () => 'không được chạy' });

    expect([whileRunning, after.data, after.replayed]).toEqual([
      'IDEMPOTENCY_IN_PROGRESS',
      { id: 'u1' },
      true,
    ]);
  });

  // Đột biến: giữ chỗ kiểu "SELECT xem có chưa → chưa thì INSERT … ON CONFLICT DO UPDATE" → nhiều
  // request cùng thấy "chưa có" → handler chạy nhiều lần.
  it('20 request SONG SONG cùng key → handler chạy đúng 1 lần; còn lại 409 hoặc nhận lại response', async () => {
    const key = newKey();
    const h = counted(async (n) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: `upload-${n}` };
    });
    // Làm nóng pool: mở sẵn 20 connection. Không làm thì 19 request phải đợi mở connection mới
    // (SCRAM auth vài chục ms) trong lúc request đầu đã giữ chỗ xong → khe race không bao giờ mở,
    // đột biến "SELECT rồi mới INSERT" vẫn xanh (đã gặp, xem plan M5 bài học).
    await Promise.all(Array.from({ length: 20 }, () => t.pool.query('select pg_sleep(0.05)')));

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () => {
        try {
          return `OK ${JSON.stringify((await call({ userId, key, handler: h.handler })).data)}`;
        } catch (error) {
          return error instanceof AppException ? error.code : String(error);
        }
      }),
    );

    const allowed = new Set(['OK {"id":"upload-1"}', 'IDEMPOTENCY_IN_PROGRESS']);
    expect([h.runs(), outcomes.filter((o) => !allowed.has(o))]).toEqual([1, []]);
    expect(outcomes).toContain('OK {"id":"upload-1"}');
  });

  it('cùng key, nội dung khác (body / path) → 422 IDEMPOTENCY_KEY_REUSED, handler không chạy', async () => {
    const key = newKey();
    await call({ userId, key, handler: async () => ({ id: 'u1' }) });
    const h = counted(() => 'không được chạy');

    const outcomes = await Promise.all([
      outcomeOf(call({ userId, key, body: { ...BODY, sizeBytes: 2048 }, handler: h.handler })),
      outcomeOf(call({ userId, key, path: '/v1/orgs/o2/uploads', handler: h.handler })),
    ]);

    expect([outcomes, h.runs()]).toEqual([['IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_KEY_REUSED'], 0]);
  });

  // Đột biến: bỏ `release` trong catchError → lần gửi lại nhận 409 mãi (tới khi hết lease).
  it('handler lỗi → lỗi gốc lọt ra, chỗ giữ bị xoá → gửi lại cùng key chạy lại handler (lỗi không được ghi nhớ)', async () => {
    const key = newKey();
    const failed = await outcomeOf(
      call({
        userId,
        key,
        handler: async () => {
          throw Errors.common.validationFailed([{ field: 'title', message: 'rỗng' }]);
        },
      }),
    );
    const rowAfterFail = await rowOf(key);
    const retry = await call({ userId, key, handler: async () => ({ id: 'u-retry' }) });

    expect([failed, rowAfterFail, retry.data, retry.replayed]).toEqual([
      'VALIDATION_FAILED',
      undefined,
      { id: 'u-retry' },
      false,
    ]);
  });

  it('key theo TỪNG user: user khác dùng cùng key → độc lập', async () => {
    const key = newKey();
    const other = (await insertUser(t.db)).id;

    const a = await call({ userId, key, handler: async () => ({ id: 'của A' }) });
    const b = await call({ userId: other, key, handler: async () => ({ id: 'của B' }) });

    expect([a.data, b.data, b.replayed]).toEqual([{ id: 'của A' }, { id: 'của B' }, false]);
  });

  /**
   * Request đầu "chết" giữa chừng (crash / deploy) để lại `processing`. Không có lease → key kẹt 409
   * suốt 24 giờ. Có lease → quá hạn lease, request cùng nội dung được giữ chỗ lại.
   * Đột biến: bỏ fencing (`created_at = claimedAt`) khi lưu → request cũ SỐNG DẬY ghi đè chỗ của
   * request mới → lần trả lại sau đó lệch với response request mới đã nhận.
   */
  it('processing quá lease → request sau giữ chỗ lại; request cũ sống dậy KHÔNG ghi đè được (fencing)', async () => {
    const key = newKey();
    const oldStarted = Promise.withResolvers<void>();
    const oldFinish = Promise.withResolvers<unknown>();
    const zombie = call({
      userId,
      key,
      handler: () => {
        oldStarted.resolve();
        return oldFinish.promise;
      },
    });
    await oldStarted.promise;
    await t.db
      .update(idempotencyKeys)
      .set({ createdAt: sql`now() - interval '2 minutes'` })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));

    const newStarted = Promise.withResolvers<void>();
    const newFinish = Promise.withResolvers<unknown>();
    const fresh = call({
      userId,
      key,
      handler: () => {
        newStarted.resolve();
        return newFinish.promise;
      },
    });
    // Không giữ chỗ lại được (vd 409) → `fresh` reject → test đỏ NGAY với đúng mã lỗi, không treo.
    await Promise.race([newStarted.promise, fresh]);
    oldFinish.resolve({ id: 'của request cũ' });
    const zombieResult = await zombie;
    newFinish.resolve({ id: 'của request mới' });
    const freshResult = await fresh;
    const replay = await call({ userId, key, handler: async () => 'không được chạy' });

    expect([zombieResult.data, freshResult.data, replay.data, replay.replayed]).toEqual([
      { id: 'của request cũ' }, // client của request cũ (nếu còn) vẫn nhận kết quả của nó
      { id: 'của request mới' },
      { id: 'của request mới' },
      true,
    ]);
  });

  it('processing quá lease nhưng nội dung KHÁC → vẫn 422, không cho chiếm', async () => {
    const key = newKey();
    const started = Promise.withResolvers<void>();
    const never = Promise.withResolvers<unknown>();
    void call({
      userId,
      key,
      handler: () => {
        started.resolve();
        return never.promise;
      },
    }).catch(() => undefined);
    await started.promise;
    await t.db
      .update(idempotencyKeys)
      .set({ createdAt: sql`now() - interval '2 minutes'` })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));

    const other = await outcomeOf(
      call({ userId, key, body: { ...BODY, title: 'Khác' }, handler: async () => 'x' }),
    );
    expect(other).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('key đã hết hạn (expires_at qua) → dùng lại như key mới, kể cả nội dung khác', async () => {
    const key = newKey();
    await t.db.insert(idempotencyKeys).values({
      userId,
      key,
      method: 'POST',
      path: '/cũ',
      requestHash: 'hash-cũ',
      status: 'completed',
      responseStatus: 201,
      responseBody: { id: 'cũ' },
      expiresAt: sql`now() - interval '1 second'`,
    });

    const result = await call({ userId, key, handler: async () => ({ id: 'mới' }) });

    expect([result.data, result.replayed, (await rowOf(key))?.responseBody]).toEqual([
      { id: 'mới' },
      false,
      { id: 'mới' },
    ]);
  });

  it('lưu response lỗi (DB chập chờn) → client VẪN nhận kết quả; dòng còn processing chờ hết lease', async () => {
    const key = newKey();
    vi.spyOn(repo, 'complete').mockRejectedValueOnce(new Error('DB chập chờn'));

    const result = await call({ userId, key, handler: async () => ({ id: 'u1' }) });

    expect([result.data, (await rowOf(key))?.status]).toEqual([{ id: 'u1' }, 'processing']);
  });

  it('không có header → chạy bình thường, không ghi gì; header sai dạng → 400 trước khi đụng DB', async () => {
    const h = counted(() => ({ id: 'u' }));
    const before = await t.db.$count(idempotencyKeys);

    await call({ userId, handler: h.handler });
    const invalid = await outcomeOf(call({ userId, key: 'có khoảng trắng', handler: h.handler }));

    expect([h.runs(), invalid, await t.db.$count(idempotencyKeys)]).toEqual([
      1,
      'VALIDATION_FAILED',
      before,
    ]);
  });
});
