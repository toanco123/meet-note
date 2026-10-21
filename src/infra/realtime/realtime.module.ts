import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { REDIS } from '../redis/redis.module.js';
import { RedisEmitterPublisher } from './redis-emitter.publisher.js';

/** Namespace duy nhất của app (05 Realtime). */
export const REALTIME_NAMESPACE = '/realtime';
/** Inject `@Inject(REALTIME_PUBLISHER) realtime: RealtimePublisher`. */
export const REALTIME_PUBLISHER = Symbol('REALTIME_PUBLISHER');

/**
 * Hạ tầng realtime dùng chung api + worker (nằm trong CoreModule). Gateway (chỉ api) ở
 * `modules/realtime`; phát event thì mọi nơi dùng `REALTIME_PUBLISHER`.
 */
@Global()
@Module({
  providers: [
    {
      provide: REALTIME_PUBLISHER,
      inject: [REDIS, ConfigService],
      // Key PHẢI khớp với Redis adapter (`RedisIoAdapter`) — cùng đọc `REALTIME_REDIS_KEY`.
      useFactory: (redis: Redis, config: ConfigService<EnvironmentVariables, true>) =>
        new RedisEmitterPublisher(
          redis,
          config.get('REALTIME_REDIS_KEY', { infer: true }),
          REALTIME_NAMESPACE,
        ),
    },
  ],
  exports: [REALTIME_PUBLISHER],
})
export class RealtimeInfraModule {}
