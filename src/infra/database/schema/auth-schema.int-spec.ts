import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../../test/support/db.js';
import { findPgError } from '../../../common/errors/pg-error.js';
import { refreshTokens, sessions } from './sessions.js';
import { users } from './users.js';

/** Bắt lỗi Postgres (Drizzle bọc trong `cause`) để kiểm tra mã SQLSTATE + tên constraint. */
async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

const uniqueEmail = () => `user-${randomBytes(4).toString('hex')}@example.com`;

describe('Schema auth (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });

  afterAll(async () => {
    await t.close();
  });

  async function insertUser(overrides: Partial<typeof users.$inferInsert> = {}) {
    const [row] = await t.db
      .insert(users)
      .values({ email: uniqueEmail(), passwordHash: 'x', displayName: 'Người dùng', ...overrides })
      .returning();
    if (!row) throw new Error('insert user thất bại');
    return row;
  }

  describe('users', () => {
    it('id mặc định là uuidv7', async () => {
      const user = await insertUser();
      expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    });

    it('email trùng khác hoa thường → 23505 với constraint users_email_lower_uq', async () => {
      const email = uniqueEmail();
      await insertUser({ email });

      const error = await pgErrorOf(insertUser({ email: email.toUpperCase() }));

      expect(error).toMatchObject({ code: '23505', constraint: 'users_email_lower_uq' });
    });

    it('search_text được sinh tự động, không dấu, chữ thường', async () => {
      const user = await insertUser({
        displayName: 'Nguyễn Văn Đức',
        email: 'Duc.Nguyen@Example.com',
      });
      expect(user.searchText).toBe('nguyen van duc duc.nguyen@example.com');
    });

    it('search_text cập nhật theo display_name (generated column)', async () => {
      const user = await insertUser({ displayName: 'Trần Thị Bé' });
      const [updated] = await t.db
        .update(users)
        .set({ displayName: 'Lê Thị Hoà' })
        .where(eq(users.id, user.id))
        .returning();
      expect(updated?.searchText).toMatch(/^le thi hoa /);
    });

    it('display_name rỗng bị CHECK chặn', async () => {
      const error = await pgErrorOf(insertUser({ displayName: '' }));
      expect(error).toMatchObject({ code: '23514', constraint: 'users_display_name_length_ck' });
    });
  });

  describe('sessions + refresh_tokens', () => {
    async function insertSession(userId: string) {
      const [session] = await t.db
        .insert(sessions)
        .values({ userId, ip: '203.0.113.7' })
        .returning();
      if (!session) throw new Error('insert session thất bại');
      return session;
    }

    function tokenValues(sessionId: string, hash = randomBytes(32)) {
      return { sessionId, tokenHash: hash, expiresAt: new Date(Date.now() + 86_400_000) };
    }

    it('token_hash lưu và đọc lại đúng dạng Buffer 32 byte', async () => {
      const user = await insertUser();
      const session = await insertSession(user.id);
      const hash = randomBytes(32);

      const [row] = await t.db
        .insert(refreshTokens)
        .values(tokenValues(session.id, hash))
        .returning();

      expect(Buffer.isBuffer(row?.tokenHash)).toBe(true);
      expect(row?.tokenHash.equals(hash)).toBe(true);
    });

    it('token_hash không đủ 32 byte bị CHECK chặn', async () => {
      const user = await insertUser();
      const session = await insertSession(user.id);

      const error = await pgErrorOf(
        t.db.insert(refreshTokens).values(tokenValues(session.id, randomBytes(16))),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'refresh_tokens_hash_length_ck' });
    });

    it('thu hồi phiên mà thiếu lý do bị CHECK chặn', async () => {
      const user = await insertUser();
      const session = await insertSession(user.id);

      const error = await pgErrorOf(
        t.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id)),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'sessions_revoked_consistency_ck' });
    });

    it('ip không hợp lệ bị kiểu inet từ chối', async () => {
      const user = await insertUser();
      const error = await pgErrorOf(
        t.db.insert(sessions).values({ userId: user.id, ip: 'not-an-ip' }),
      );
      expect(error?.code).toBe('22P02'); // invalid_text_representation
    });

    it('xoá user → cascade xoá sessions và refresh_tokens', async () => {
      const user = await insertUser();
      const session = await insertSession(user.id);
      await t.db.insert(refreshTokens).values(tokenValues(session.id));

      await t.db.delete(users).where(eq(users.id, user.id));

      expect(await t.db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(
        0,
      );
      expect(
        await t.db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, session.id)),
      ).toHaveLength(0);
    });
  });
});
