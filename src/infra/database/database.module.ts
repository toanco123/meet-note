import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import type { PgPoolOptions } from './database.types.js';
import { OrgContext } from './org-context.js';
import * as schema from './schema/index.js';

/** Inject bằng `@Inject(DRIZZLE) private readonly db: Database`. */
export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: boolean | Error) => void,
) => void;

/** `app.org_id` đã đặt trên từng connection — chỉ gửi `set_config` khi giá trị ĐỔI. */
const appliedOrg = new WeakMap<PoolClient, string>();

/**
 * Pool đặt `app.org_id` (policy RLS đọc, M11 B7) MỖI lần cho mượn connection — cả câu lẻ
 * (`pool.query` → `connect(cb)` bên trong) lẫn transaction (`pool.connect()`).
 *
 * - Đọc `OrgContext.current()` ngay lúc gọi. BẪY (đo ở `rls.int-spec`): pool đầy thì yêu cầu xếp
 *   hàng và CALLBACK của pg-pool chạy trong ngữ cảnh async của request vừa TRẢ connection — đọc ngữ
 *   cảnh trong callback đó (hay sự kiện `'acquire'`) là lấy nhầm tổ chức. Đọc trong `.then` của
 *   promise thì vẫn đúng (AsyncLocalStorage theo nơi ĐĂNG KÝ `.then`), nhưng đọc lúc gọi là chắc nhất.
 * - Không có ngữ cảnh → đặt rỗng (policy: không thấy dòng nào), KHÔNG giữ giá trị của request trước.
 * - `set_config(…, false)` là một câu tự commit riêng, trước mọi `BEGIN` của người dùng → `ROLLBACK`
 *   sau đó không hoàn tác nó; nhờ vậy nhớ được giá trị theo connection để bỏ round-trip thừa.
 */
class OrgContextPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const orgId = OrgContext.current() ?? '';
    const ready = super.connect().then(async (client) => {
      if (appliedOrg.get(client) === orgId) return client;
      try {
        await client.query(`select set_config('app.org_id', $1, false)`, [orgId]);
      } catch (error) {
        client.release(error as Error);
        throw error;
      }
      appliedOrg.set(client, orgId);
      return client;
    });
    if (!callback) return ready;
    ready.then(
      (client) => callback(undefined, client, (release) => client.release(release)),
      (error: Error) => callback(error, undefined, () => undefined),
    );
  }
}

/** Tách khỏi provider để test dựng được pool với timeout ngắn mà không cần dựng app. */
export function createPgPool(options: PgPoolOptions): Pool {
  // Trong lúc lệnh của connection B chờ khoá, transaction A giữ khoá cũng đang "idle in transaction".
  // Idle timeout ≤ lock timeout → Postgres giết NHẦM A (giữ khoá) thay vì cho B lỗi 55P03 (M11 B1).
  if (options.lockTimeoutMs >= options.idleInTransactionTimeoutMs) {
    throw new Error('DATABASE_LOCK_TIMEOUT_MS phải nhỏ hơn DATABASE_IDLE_TX_TIMEOUT_MS');
  }
  const logger = new Logger('PgPool');
  const pool = new OrgContextPool({
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
