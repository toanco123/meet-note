import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeGateway } from '../../../src/modules/realtime/realtime.gateway.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../../src/modules/auth/services/token.service.js';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser } from '../../support/factories.js';
import { connectRealtime, portOf } from '../../support/realtime.js';
import type { Socket } from 'socket.io-client';

/** Handshake `/realtime`: cùng hai lớp kiểm tra với REST (chữ ký + hạn, phiên còn sống) — M7 B1. */
describe('Realtime: xác thực handshake (e2e, socket.io-client thật)', () => {
  let app: INestApplication<App>;
  let port: number;
  const opened: Socket[] = [];
  const http = () => request(app.getHttpServer());
  const connect = async (token: string | undefined) => {
    const r = await connectRealtime(port, token);
    opened.push(r.socket);
    return r;
  };
  const signRaw = (payload: object, options: object = {}) =>
    new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).signAsync(payload, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      ...options,
    });
  const sessionOf = async (accessToken: string) =>
    (await http().get('/v1/me/sessions').set(bearer(accessToken))).body.data.find(
      (s: { current: boolean }) => s.current,
    ).id as string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = portOf(app);
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await app.close();
  });

  it('token đúng → kết nối; socket tự vào room user:{id} và session:{sid}', async () => {
    const user = await registerUser(app);
    const sid = await sessionOf(user.tokens.accessToken);

    const { outcome } = await connect(user.tokens.accessToken);

    const ns = app.get(RealtimeGateway).namespace;
    const [inUser, inSession] = await Promise.all([
      ns.in(`user:${user.id}`).fetchSockets(),
      ns.in(`session:${sid}`).fetchSockets(),
    ]);
    expect([outcome, inUser.length, inSession.length]).toEqual(['OK', 1, 1]);
  });

  it('bị từ chối ở handshake với ĐÚNG mã lỗi của REST', async () => {
    const user = await registerUser(app);
    const sid = await sessionOf(user.tokens.accessToken);
    const expired = await signRaw(
      { sid, exp: Math.floor(Date.now() / 1000) - 5 },
      { subject: user.id },
    );
    const revoked = await registerUser(app);
    await http().post('/v1/auth/logout').set(bearer(revoked.tokens.accessToken)).expect(204);

    const outcomes = [];
    for (const [label, token] of [
      ['thiếu token', undefined],
      ['token rỗng', ''],
      ['token rác', 'abc.def.ghi'],
      ['token hết hạn (chữ ký đúng)', expired],
      ['phiên đã logout, token còn hạn', revoked.tokens.accessToken],
    ] as const) {
      outcomes.push([label, (await connect(token)).outcome]);
    }

    expect(outcomes).toEqual([
      ['thiếu token', 'AUTH_TOKEN_MISSING'],
      ['token rỗng', 'AUTH_TOKEN_MISSING'],
      ['token rác', 'AUTH_TOKEN_INVALID'],
      ['token hết hạn (chữ ký đúng)', 'AUTH_TOKEN_EXPIRED'],
      ['phiên đã logout, token còn hạn', 'AUTH_SESSION_REVOKED'],
    ]);
  });

  it('bị từ chối thì KHÔNG từng vào room nào (xác thực ở middleware, không ở handleConnection)', async () => {
    const revoked = await registerUser(app);
    await http().post('/v1/auth/logout').set(bearer(revoked.tokens.accessToken)).expect(204);

    await connect(revoked.tokens.accessToken);

    const inUser = await app.get(RealtimeGateway).namespace.in(`user:${revoked.id}`).fetchSockets();
    expect(inUser).toHaveLength(0);
  });
});
