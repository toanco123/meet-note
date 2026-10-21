import { Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { RedisEmitterPublisher } from './redis-emitter.publisher.js';

/** Namespace duy nhất của app (05 Realtime). */
export const REALTIME_NAMESPACE = '/realtime';
/** Kênh Redis của adapter + emitter — PHẢI khớp nhau; có tiền tố riêng như BullMQ (`meetnote`). */
export const REALTIME_REDIS_KEY = 'meetnote:socket.io';
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
      inject: [REDIS],
      useFactory: (redis: Redis) =>
        new RedisEmitterPublisher(redis, REALTIME_REDIS_KEY, REALTIME_NAMESPACE),
    },
  ],
  exports: [REALTIME_PUBLISHER],
})
export class RealtimeInfraModule {}
