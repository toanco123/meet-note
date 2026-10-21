import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { JwtAuthGuard } from '../../../../../src/modules/auth/guards/jwt-auth.guard.js';
import type { SessionsService } from '../../../../../src/modules/auth/services/sessions.service.js';
import type { TokenService } from '../../../../../src/modules/auth/services/token.service.js';

/**
 * JwtAuthGuard là APP_GUARD → Nest chạy nó cho CẢ message của gateway WebSocket (M7 bài học 5).
 * Socket đã qua handshake (có `data.user`) → cho qua; context khác HTTP / WS → chặn mặc định.
 */
describe('JwtAuthGuard — context không phải HTTP', () => {
  const guard = new JwtAuthGuard(
    { getAllAndOverride: () => false } as unknown as Reflector,
    {} as TokenService,
    {} as SessionsService,
  );
  const ctx = (type: string, client: unknown = {}) =>
    ({
      getType: () => type,
      switchToWs: () => ({ getClient: () => client }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as unknown as ExecutionContext;

  it.each([
    ['ws, socket đã xác thực ở handshake', ctx('ws', { data: { user: { id: 'u1' } } }), true],
    ['ws, socket chưa có user (không qua middleware)', ctx('ws', { data: {} }), false],
    ['ws, client không có data', ctx('ws', {}), false],
    ['rpc (chưa dùng) → chặn mặc định', ctx('rpc'), false],
  ] as const)('%s → %s', async (_label, context, expected) => {
    expect(await guard.canActivate(context)).toBe(expected);
  });
});
