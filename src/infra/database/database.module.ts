import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import type { PgPoolOptions } from './database.types.js';
import * as schema from './schema/index.js';

/** Inject bằng `@Inject(DRIZZLE) private readonly db: Database`. */
export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

/** Tách khỏi provider để test dựng được pool với timeout ngắn mà không cần dựng app. */
export function createPgPool(options: PgPoolOptions): Pool {
  // Trong lúc lệnh của connection B chờ khoá, transaction A giữ khoá cũng đang "idle in transaction".
  // Idle timeout ≤ lock timeout → Postgres giết NHẦM A (giữ khoá) thay vì cho B lỗi 55P03 (M11 B1).
  if (options.lockTimeoutMs >= options.idleInTransactionTimeoutMs) {
    throw new Error('DATABASE_LOCK_TIMEOUT_MS phải nhỏ hơn DATABASE_IDLE_TX_TIMEOUT_MS');
  }
  const logger = new Logger('PgPool');
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    // Phía CLIENT: đừng để request treo vô hạn khi pool cạn kết nối.
    connectionTimeoutMillis: 5_000,
    // Phía POSTGRES (gửi trong startup packet): áp cho mọi câu lệnh trên connection.
    lock_timeout: options.lockTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs,
    // App OLTP: JIT chỉ đáng với truy vấn phân tích chạy lâu. Ước lượng chi phí phồng (vd danh sách
    // meeting ~3M "cost") làm Postgres compile JIT ~17 ms cho câu chỉ đọc 9 buffer (M11 B5).
    options: '-c jit=off',
  });
  // BẪY: không lắng nghe 'error' thì một client rảnh bị DB ngắt (restart, failover)
  // sẽ phát 'error' không ai bắt → crash cả tiến trình.
  pool.on('error', (error) => logger.error(error));
  // BẪY (pg-pool 3.14): listener trên chỉ gắn với client RẢNH — `_acquireClient` gỡ nó khi cho mượn.
  // Postgres cắt session đang được mượn (`idle_in_transaction_session_timeout`, admin kill) → client
  // phát 'error' không ai nghe → uncaught exception, CẢ tiến trình chết. Listener cố định này chỉ
  // nuốt sự kiện; người đang mượn vẫn thấy lỗi ở câu lệnh kế tiếp, và `release(err)` bỏ client hỏng.
  pool.on('connect', (client) => {
    client.on('error', (error) =>
      logger.warn(`Connection đang được dùng bị ngắt: ${error.message}`),
    );
  });
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        createPgPool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          // main.ts / worker.ts đặt process.title → phân biệt api/worker trong pg_stat_activity.
          applicationName: process.title,
          lockTimeoutMs: config.get('DATABASE_LOCK_TIMEOUT_MS', { infer: true }),
          statementTimeoutMs: config.get('DATABASE_STATEMENT_TIMEOUT_MS', { infer: true }),
          idleInTransactionTimeoutMs: config.get('DATABASE_IDLE_TX_TIMEOUT_MS', { infer: true }),
        }),
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
