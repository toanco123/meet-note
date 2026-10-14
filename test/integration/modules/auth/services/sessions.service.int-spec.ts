import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../../support/db.js';
import type { AppException } from '../../../../../src/common/errors/app.exception.js';
import { DRIZZLE } from '../../../../../src/infra/database/database.module.js';
import { refreshTokens, sessions, users } from '../../../../../src/infra/database/schema/index.js';
import { jwtModuleOptions } from '../../../../../src/modules/auth/jwt-options.js';
import { SessionsRepository } from '../../../../../src/modules/auth/sessions.repository.js';
import { SessionsService } from '../../../../../src/modules/auth/services/sessions.service.js';
import {
  hashRefreshToken,
  TokenService,
} from '../../../../../src/modules/auth/services/token.service.js';

const CONFIG: Record<string, number> = {
  JWT_ACCESS_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  REFRESH_REUSE_GRACE_SECONDS: 10,
};

/** Mã lỗi (AppException.code) của một promise bị reject, hoặc 'FULFILLED'. */
async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'FULFILLED';
  } catch (error) {
    return (error as AppException).code ?? String(error);
  }
}

describe('SessionsService (Postgres thật)', () => {
  let t: TestDb;
  let service: SessionsService;
  let tokens: TokenService;

  beforeAll(async () => {
    t = createTestDb(20); // test concurrency cần nhiều connection song song
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register(jwtModuleOptions('int-test-secret'.padEnd(40, 'x')))],
      providers: [
        SessionsService,
        SessionsRepository,
        TokenService,
        { provide: DRIZZLE, useValue: t.db },
        { provide: ConfigService, useValue: { get: (key: string) => CONFIG[key] } },
      ],
    }).compile();
    service = moduleRef.get(SessionsService);
    tokens = moduleRef.get(TokenService);
  });

  afterAll(async () => {
    await t.close();
  });

  async function createUser(): Promise<string> {
    const [user] = await t.db
      .insert(users)
      .values({
        email: `s-${randomBytes(4).toString('hex')}@example.com`,
        passwordHash: 'x',
        displayName: 'Phiên',
      })
      .returning({ id: users.id });
    if (!user) throw new Error('insert user thất bại');
    return user.id;
  }

  const sessionOf = async (id: string) =>
    (await t.db.select().from(sessions).where(eq(sessions.id, id)))[0];

  const tokenRowOf = async (token: string) =>
    (
      await t.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)))
    )[0];

  /** Giả lập "đã xoay từ lâu" mà không phải chờ thật. */
  async function ageRotation(token: string, seconds: number) {
    await t.db
      .update(refreshTokens)
      .set({ rotatedAt: sql`rotated_at - make_interval(secs => ${seconds})` })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
  }

  it('create: mở phiên + 1 refresh token; access token mang đúng sid', async () => {
    const userId = await createUser();
    const issued = await service.create(userId, { userAgent: 'vitest', ip: '127.0.0.1' });

    const verified = await tokens.verifyAccessToken(issued.accessToken.token);
    expect(verified).toEqual({ ok: true, claims: { sub: userId, sid: issued.sessionId } });
    expect((await sessionOf(issued.sessionId))?.revokedAt).toBeNull();
    expect((await tokenRowOf(issued.refreshToken.token))?.sessionId).toBe(issued.sessionId);
  });

  it('rotate: cấp token mới, đánh dấu token cũ, giữ nguyên sid', async () => {
    const first = await service.create(await createUser(), {});
    const second = await service.rotate(first.refreshToken.token);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.refreshToken.token).not.toBe(first.refreshToken.token);

    const oldRow = await tokenRowOf(first.refreshToken.token);
    const newRow = await tokenRowOf(second.refreshToken.token);
    expect(oldRow?.rotatedAt).not.toBeNull();
    expect(oldRow?.replacedById).toBe(newRow?.id);
    expect(newRow?.rotatedAt).toBeNull();
  });

  it('token không tồn tại → AUTH_REFRESH_TOKEN_INVALID', async () => {
    const unknown = randomBytes(32).toString('base64url');
    expect(await outcomeOf(service.rotate(unknown))).toBe('AUTH_REFRESH_TOKEN_INVALID');
  });

  it('token hết hạn → AUTH_REFRESH_TOKEN_INVALID', async () => {
    const issued = await service.create(await createUser(), {});
    await t.db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.sessionId, issued.sessionId));

    expect(await outcomeOf(service.rotate(issued.refreshToken.token))).toBe(
      'AUTH_REFRESH_TOKEN_INVALID',
    );
  });

  it('dùng lại token cũ TRONG grace → ROTATED, phiên vẫn sống, token mới vẫn dùng được', async () => {
    const first = await service.create(await createUser(), {});
    const second = await service.rotate(first.refreshToken.token);

    expect(await outcomeOf(service.rotate(first.refreshToken.token))).toBe(
      'AUTH_REFRESH_TOKEN_ROTATED',
    );
    expect((await sessionOf(first.sessionId))?.revokedAt).toBeNull();
    expect(await outcomeOf(service.rotate(second.refreshToken.token))).toBe('FULFILLED');
  });

  it('dùng lại token cũ QUÁ grace → REUSED, phiên bị thu hồi (và việc thu hồi KHÔNG bị rollback)', async () => {
    const first = await service.create(await createUser(), {});
    const second = await service.rotate(first.refreshToken.token);
    await ageRotation(first.refreshToken.token, 60);

    expect(await outcomeOf(service.rotate(first.refreshToken.token))).toBe(
      'AUTH_REFRESH_TOKEN_REUSED',
    );

    // Nếu lỗi bị ném bên trong transaction, dòng dưới sẽ thấy revokedAt = null.
    const session = await sessionOf(first.sessionId);
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.revokedReason).toBe('reuse_detected');

    // Token "hợp lệ" mới nhất cũng chết theo phiên — kẻ trộm lẫn chủ thật đều phải đăng nhập lại.
    expect(await outcomeOf(service.rotate(second.refreshToken.token))).toBe(
      'AUTH_REFRESH_TOKEN_INVALID',
    );
  });

  it('revoke: chỉ chủ phiên thu hồi được; thu hồi lần hai trả false', async () => {
    const owner = await createUser();
    const other = await createUser();
    const issued = await service.create(owner, {});

    expect(await service.revoke(issued.sessionId, other, 'revoked_by_user')).toBe(false);
    expect(await service.isActive(issued.sessionId, owner)).toBe(true);

    expect(await service.revoke(issued.sessionId, owner, 'logout')).toBe(true);
    expect(await service.revoke(issued.sessionId, owner, 'logout')).toBe(false);
    expect(await service.isActive(issued.sessionId, owner)).toBe(false);
    expect(await outcomeOf(service.rotate(issued.refreshToken.token))).toBe(
      'AUTH_REFRESH_TOKEN_INVALID',
    );
  });

  it('revokeAll: thu hồi mọi phiên đang sống của user, không đụng user khác', async () => {
    const userId = await createUser();
    const bystander = await service.create(await createUser(), {});
    await service.create(userId, {});
    await service.create(userId, {});

    expect(await service.revokeAll(userId)).toBe(2);
    expect(await service.isActive(bystander.sessionId, bystander.userId)).toBe(true);
  });

  /**
   * Test concurrency đầu tiên của dự án. Hai request refresh cùng một token chạy song song
   * (mỗi transaction một connection). Với `FOR UPDATE`: request sau đợi request trước commit,
   * rồi thấy token đã xoay → ROTATED. Bỏ `FOR UPDATE`: cả hai cùng đọc "chưa xoay" → cùng
   * thành công → một phiên có hai nhánh token. Chạy nhiều vòng để race chắc chắn xảy ra.
   */
  it('2 lần rotate song song cùng một token → đúng 1 thành công, chỉ 1 token mới (10 vòng)', async () => {
    const userId = await createUser();

    for (let round = 0; round < 10; round++) {
      const issued = await service.create(userId, {});

      const outcomes = await Promise.all([
        outcomeOf(service.rotate(issued.refreshToken.token)),
        outcomeOf(service.rotate(issued.refreshToken.token)),
      ]);

      expect(outcomes.sort(), `vòng ${round}`).toEqual(['AUTH_REFRESH_TOKEN_ROTATED', 'FULFILLED']);
      const rows = await t.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.sessionId, issued.sessionId));
      expect(rows, `vòng ${round}: token gốc + đúng 1 token mới`).toHaveLength(2);
    }
  });
});
