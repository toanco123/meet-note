import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { EnvironmentVariables } from '../../config/env.validation.js';

/**
 * Kết nối Redis dùng chung cho cache / pub-sub / health check.
 * BullMQ tự quản lý kết nối riêng (worker cần kết nối blocking riêng), không dùng instance này.
 */
export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
          // Chỉ kết nối khi có lệnh đầu tiên: script không cần Redis (export OpenAPI)
          // vẫn khởi tạo được app.
          lazyConnect: true,
          // Redis down → lệnh lỗi sau 2 lần thử thay vì treo request mãi.
          maxRetriesPerRequest: 2,
        });
        redis.on('error', (error) => new Logger('Redis').warn(error.message));
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // Chỉ QUIT êm khi đang kết nối. Các trạng thái khác ('wait' = lazyConnect chưa từng kết nối,
    // 'reconnecting' = Redis đang chết) → ngắt ngay, đừng để shutdown chờ vòng retry.
    if (this.redis.status === 'ready') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    } else {
      this.redis.disconnect();
    }
  }
}
