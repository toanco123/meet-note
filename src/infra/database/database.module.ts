import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import * as schema from './schema/index.js';

/** Inject bằng `@Inject(DRIZZLE) private readonly db: Database`. */
export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          // main.ts / worker.ts đặt process.title → phân biệt api/worker trong pg_stat_activity.
          application_name: process.title,
          // Đừng để request treo vô hạn khi pool cạn kết nối.
          connectionTimeoutMillis: 5_000,
        });
        // BẪY: không lắng nghe 'error' thì một client rảnh bị DB ngắt (restart, failover)
        // sẽ phát 'error' không ai bắt → crash cả tiến trình.
        pool.on('error', (error) => new Logger('PgPool').error(error));
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle({ client: pool, schema, casing: 'snake_case' }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
