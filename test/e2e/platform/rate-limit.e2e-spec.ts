import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { createTestApp } from '../../support/app.js';
import { insertUser } from '../../support/db-factories.js';
import { bearer, DEFAULT_PASSWORD, uniqueEmail } from '../../support/factories.js';
import { fixtureDb } from '../../support/db.js';

// Chạy TRƯỚC mọi import của file (trước khi ConfigModule đọc env): bật rate limit (setup-e2e tắt)
// và tin 1 tầng proxy để test giả được nhiều IP bằng `X-Forwarded-For`.
vi.hoisted(() => {
  process.env.RATE_LIMIT_ENABLED = 'true';
  process.env.TRUST_PROXY_HOPS = '1';
});

/** Rate limit qua HTTP thật, đếm trong Redis thật (M11 B3). Mỗi ca dùng dải IP / email riêng. */
describe('Rate limit (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (target: INestApplication<App>, ip: string, email: string) =>
    request(target.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'sai-mat-khau-dai-du' });
  const statuses = async (calls: Array<() => Promise<request.Response>>) => {
    const out: number[] = [];
    for (const call of calls) out.push((await call()).status);
    return out;
  };
  const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

  it('đăng nhập sai 5 lần cùng (IP, email) → lần 6 bị 429 + Retry-After + body chuẩn; IP khác vẫn thử được', async () => {
    const { email } = await insertUser(db);
    const fromA = await statuses(times(5, () => () => login(app, '10.1.0.1', email)));
    const blocked = await login(app, '10.1.0.1', email);
    const fromB = await login(app, '10.1.0.2', email);

    expect([fromA, blocked.status, fromB.status]).toEqual([[401, 401, 401, 401, 401], 429, 401]);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
  });

  it('dò MỘT email từ nhiều IP: 20 lần / giờ (4 IP × 5) → IP thứ 5 bị 429 ngay lần đầu', async () => {
    const { email } = await insertUser(db);
    const spread = await statuses(
      times(20, (i) => () => login(app, `10.2.0.${Math.floor(i / 5) + 1}`, email)),
    );
    const fifthIp = await login(app, '10.2.0.5', email);

    expect([new Set(spread), fifthIp.status]).toEqual([new Set([401]), 429]);
  });

  it('dò NHIỀU email từ một IP: 30 lần / phút → lần 31 bị 429', async () => {
    const tries = await statuses(times(30, () => () => login(app, '10.3.0.1', uniqueEmail())));
    const next = await login(app, '10.3.0.1', uniqueEmail());
    expect([new Set(tries), next.status]).toEqual([new Set([401]), 429]);
  });

  it('đã đăng nhập → khoá theo NGƯỜI DÙNG: hai người sau cùng một IP không giành giới hạn của nhau', async () => {
    const register = async (ip: string) =>
      (
        await request(app.getHttpServer())
          .post('/v1/auth/register')
          .set('X-Forwarded-For', ip)
          .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD, displayName: 'R' })
          .expect(201)
      ).body.data.accessToken as string;
    const [owner, a, b] = [
      await register('10.4.0.1'),
      await register('10.4.0.2'),
      await register('10.4.0.3'),
    ];
    const orgId = (
      await request(app.getHttpServer())
        .post('/v1/orgs')
        .set(bearer(owner))
        .send({ name: 'RL' })
        .expect(201)
    ).body.data.id as string;
    const token = (
      await request(app.getHttpServer())
        .post(`/v1/orgs/${orgId}/invites`)
        .set(bearer(owner))
        .send({})
        .expect(201)
    ).body.data.token as string;
    const accept = (user: string) => () =>
      request(app.getHttpServer())
        .post(`/v1/invites/${token}/accept`)
        .set('X-Forwarded-For', '10.4.9.9') // CÙNG một IP (vd cùng văn phòng sau NAT)
        .set(bearer(user));

    const byA = await statuses(times(20, () => accept(a)));
    const aBlocked = (await accept(a)()).status;
    const bFirst = (await accept(b)()).status;

    expect([byA[0], new Set(byA.slice(1)), aBlocked, bFirst]).toEqual([
      200,
      new Set([409]), // đã là thành viên — vẫn bị đếm
      429,
      200,
    ]);
  });

  // Đột biến: bỏ `@Throttle(RateLimit.transcriptSearch / transcriptExport)` → rơi về giới hạn mặc định
  // 300 / phút, lần 61 / 31 vẫn 200 / 404 (đỏ).
  it('search transcript 60 / phút, xuất file 30 / phút (hai route đắt nhất) — theo người dùng', async () => {
    const reg = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .set('X-Forwarded-For', '10.7.0.1')
      .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD, displayName: 'T' })
      .expect(201);
    const token = reg.body.data.accessToken as string;
    const orgId = (
      await request(app.getHttpServer())
        .post('/v1/orgs')
        .set(bearer(token))
        .send({ name: 'RL transcript' })
        .expect(201)
    ).body.data.id as string;
    const search = () =>
      request(app.getHttpServer())
        .get(`/v1/orgs/${orgId}/search/transcripts`)
        .query({ q: 'ke hoach' })
        .set(bearer(token));
    const exportFile = () =>
      request(app.getHttpServer())
        .get(`/v1/orgs/${orgId}/meetings/00000000-0000-7000-8000-000000000000/transcript/export`)
        .query({ format: 'srt' })
        .set(bearer(token));

    const searches = await statuses(times(60, () => search));
    const searchBlocked = await search();
    const exports = await statuses(times(30, () => exportFile));
    const exportBlocked = await exportFile();

    expect([
      new Set(searches),
      searchBlocked.status,
      new Set(exports),
      exportBlocked.status,
      searchBlocked.body.error?.code,
    ]).toEqual([new Set([200]), 429, new Set([404]), 429, 'RATE_LIMITED']);
  });

  // Đột biến: storage trong bộ nhớ (mặc định của thư viện) → instance thứ hai có bộ đếm riêng.
  it('hai instance api dùng chung Redis → chung bộ đếm', async () => {
    const second = await createTestApp();
    try {
      const { email } = await insertUser(db);
      const split = await statuses([
        ...times(3, () => () => login(app, '10.5.0.1', email)),
        ...times(2, () => () => login(second, '10.5.0.1', email)),
      ]);
      const sixth = await login(second, '10.5.0.1', email);
      expect([split, sixth.status]).toEqual([[401, 401, 401, 401, 401], 429]);
    } finally {
      await second.close();
    }
  });

  it('health không bị đếm; route thường có header giới hạn', async () => {
    const health = await request(app.getHttpServer()).get('/health/live');
    const normal = await login(app, '10.6.0.1', uniqueEmail());
    expect([health.headers['x-ratelimit-limit'], normal.headers['x-ratelimit-limit']]).toEqual([
      undefined,
      '30',
    ]);
  });
});
