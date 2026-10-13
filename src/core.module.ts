import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './infra/database/database.module.js';
import { LoggerModule } from './infra/logger/logger.module.js';
import { QueueModule } from './infra/queue/queue.module.js';
import { RedisModule } from './infra/redis/redis.module.js';

/**
 * Hạ tầng dùng chung cho CẢ api và worker: config, log, database, redis, queue.
 * Không chứa controller — worker import module này mà không kéo theo HTTP.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // Test tự đặt process.env; không để file .env của máy dev lẫn vào.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
  ],
  exports: [LoggerModule, QueueModule],
})
export class CoreModule {}
