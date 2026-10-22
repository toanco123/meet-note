import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, sql } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { refreshTokens } from '../../../src/infra/database/schema/index.js';
import {
  hashRefreshToken,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../../../src/modules/auth/services/token.service.js';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser, type TestUser, type TokenPair } from '../../support/factories.js';
import { connectRealtime, portOf } from '../../support/realtime.js';
import { fixtureDb } from '../../support/db.js';

interface Watched {
  socket: Socket;
  /** Lý do server báo trong `session.ended` (nếu có) + lý do ngắt phía client. */
  ended: Promise<{ reason: string | undefined; disconnect: string }>;
}

/**
 * Kết nối sống lâu hơn token / phiên (M7 B2, Q1): token hết hạn → server tự ngắt đúng `exp`; phiên
 * bị thu hồi (logout, logout-all, xoá phiên, phát hiện reuse refresh token) → ngắt NGAY, chỉ đúng
 * phiên đó — đi qua Redis (emitter → adapter), như khi socket nằm ở instance khác.
 */
describe('Realtime: ngắt khi token hết hạn / phiên bị thu hồi (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let port: number;
  const opened: Socket[] = [];
  const http = () => request(app.getHttpServer());

  async function watch(token: string): Promise<Watched> {
    const { socket, outcome } = await connectRealtime(port, token);
    opened.push(socket);
    if (outcome !== 'OK') throw new Error(`Kết nối thất bại: ${outcome}`);
    let reason: string | undefined;
    socket.on('session.ended', (p: { reason: string }) => (reason = p.reason));
    const ended = new Promise<{ reason: string | undefined; disconnect: string }>((resolve) =>
      socket.once('disconnect', (why) => resolve({ reason, disconnect: why })),
    );
    return { socket, ended };
  }
  /** Phiên thứ hai của cùng người (đăng nhập lần nữa). */
  const login = async (u: TestUser) =>
    (await http().post('/v1/auth/login').send({ email: u.email, password: u.password }).expect(200))
      .body.data as TokenPair;
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const SERVER_KICK = { reason: 'session_revoked', disconnect: 'io server disconnect' };

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = portOf(app);
    db = fixtureDb();
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await app.close();
  });

  it('token còn 2 giây → server báo `token_expired` rồi ngắt đúng lúc hết hạn', async () => {
    const user = await registerUser(app);
    const sid = (await http().get('/v1/me/sessions').set(bearer(user.tokens.accessToken))).body
      .data[0].id as string;
    const exp = Math.floor(Date.now() / 1000) + 2;
    const shortLived = await new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).signAsync(
      { sid, exp },
      { subject: user.id, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    );
    const w = await watch(shortLived);

    const result = await w.ended;

    expect([result, Date.now() >= exp * 1000]).toEqual([
      { reason: 'token_expired', disconnect: 'io server disconnect' },
      true,
    ]);
  });

  it('logout → chỉ socket của PHIÊN đó bị ngắt; phiên khác của cùng người vẫn sống', async () => {
    const user = await registerUser(app);
    const other = await login(user);
    const a = await watch(user.tokens.accessToken);
    const b = await watch(other.accessToken);

    await http().post('/v1/auth/logout').set(bearer(user.tokens.accessToken)).expect(204);
    const kicked = await a.ended;
    await settle();

    expect([kicked, b.socket.connected]).toEqual([SERVER_KICK, true]);
  });

  it('logout-all → mọi socket của người đó bị ngắt', async () => {
    const user = await registerUser(app);
    const other = await login(user);
    const a = await watch(user.tokens.accessToken);
    const b = await watch(other.accessToken);

    await http().post('/v1/auth/logout-all').set(bearer(user.tokens.accessToken)).expect(204);

    expect(await Promise.all([a.ended, b.ended])).toEqual([SERVER_KICK, SERVER_KICK]);
  });

  it('xoá một phiên ở /me/sessions → socket của phiên bị xoá bị ngắt, phiên đang dùng vẫn sống', async () => {
    const user = await registerUser(app);
    const other = await login(user);
    const a = await watch(user.tokens.accessToken);
    const b = await watch(other.accessToken);
    const sessions = (await http().get('/v1/me/sessions').set(bearer(user.tokens.accessToken))).body
      .data as Array<{ id: string; current: boolean }>;
    const otherId = sessions.find((s) => !s.current)?.id;

    await http()
      .delete(`/v1/me/sessions/${otherId}`)
      .set(bearer(user.tokens.accessToken))
      .expect(204);
    const kicked = await b.ended;
    await settle();

    expect([kicked, a.socket.connected]).toEqual([SERVER_KICK, true]);
  });

  it('phát hiện refresh token bị dùng lại → phiên bị thu hồi → socket của phiên bị ngắt', async () => {
    const user = await registerUser(app);
    const a = await watch(user.tokens.accessToken);
    await http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: user.tokens.refreshToken })
      .expect(200);
    // Giả lập "đã xoay từ 1 phút trước" (quá grace 10 s) thay vì chờ.
    await db
      .update(refreshTokens)
      .set({ rotatedAt: sql`rotated_at - interval '1 minute'` })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(user.tokens.refreshToken)));

    await http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: user.tokens.refreshToken })
      .expect(401);

    expect(await a.ended).toEqual(SERVER_KICK);
  });
});
