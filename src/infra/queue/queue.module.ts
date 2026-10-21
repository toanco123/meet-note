import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';

/**
 * Tên queue. Tách queue theo đặc tính tải, không theo domain:
 * - `default`: job ngắn (tóm tắt, báo cáo, thông báo, dọn dẹp)
 * - `transcription`: job CPU nặng, chạy ở worker riêng với concurrency thấp
 */
export const QueueName = {
  Default: 'default',
  Transcription: 'transcription',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/**
 * Cấu hình kết nối BullMQ dùng chung cho api (producer) và worker (consumer).
 * Module domain đăng ký queue của mình bằng `BullModule.registerQueue({ name })`.
 *
 * BẪY: Redis dùng cho BullMQ phải đặt `maxmemory-policy noeviction` (xem compose.yaml),
 * nếu không Redis có thể âm thầm xoá key của job khi đầy bộ nhớ.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
        defaultJobOptions: {
          removeOnComplete: { age: 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
