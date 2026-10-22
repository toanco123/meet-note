import { type ExecutionContext, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { REDIS } from '../redis/redis.module.js';
import { CREDENTIAL_ROUTE } from './credential-throttle.decorator.js';
import { RateLimit, ThrottlerName } from './rate-limits.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

/** Email trong body đăng nhập, chuẩn hoá như lúc tìm user (không phân biệt hoa thường). */
function emailOf(req: Record<string, unknown>): string {
  const email = (req as unknown as Request).body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Cấu hình `@nestjs/throttler` cho api (không import vào worker). Guard (`AppThrottlerGuard`) đăng
 * ký ở AuthModule. Khoá trong Redis là sha256 của (class, handler, throttler, tracker) — email
 * không nằm trần trong Redis.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService<EnvironmentVariables, true>, redis: Redis) => {
        const disabled = () => !config.get('RATE_LIMIT_ENABLED', { infer: true });
        // BẪY: `skipIf` của một throttler THAY THẾ `skipIf` chung (không cộng dồn) → tự kiểm lại
        // `disabled()`.
        const notCredentialRoute = (context: ExecutionContext) =>
          disabled() || Reflect.getMetadata(CREDENTIAL_ROUTE, context.getHandler()) !== true;
        return {
          throttlers: [
            { name: ThrottlerName.Default, ...RateLimit.default },
            {
              name: ThrottlerName.Credential,
              ...RateLimit.credential,
              getTracker: (req) => `ip:${String(req.ip)}|email:${emailOf(req)}`,
              skipIf: notCredentialRoute,
            },
            {
              name: ThrottlerName.Account,
              ...RateLimit.account,
              getTracker: (req) => `email:${emailOf(req)}`,
              skipIf: notCredentialRoute,
            },
          ],
          storage: new RedisThrottlerStorage(
            redis,
            config.get('RATE_LIMIT_PREFIX', { infer: true }),
          ),
          skipIf: disabled,
        };
      },
    }),
  ],
})
export class RateLimitModule {}
