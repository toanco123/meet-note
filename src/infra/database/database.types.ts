import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/** Kiểu của `tx` bên trong `db.transaction(async (tx) => …)`. Repository nhận `Database | Transaction`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DbExecutor = Database | Transaction;

/** Cấu hình pool — `createPgPool`. Ba timeout phía Postgres (ms), gửi lúc mở connection (M11 Q1). */
export interface PgPoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
  /** Chờ khoá dòng / bảng quá lâu → lỗi `55P03` thay vì treo. */
  lockTimeoutMs: number;
  /** Một câu lệnh chạy quá lâu → bị huỷ, lỗi `57014`. */
  statementTimeoutMs: number;
  /** Transaction mở mà không gửi lệnh nào quá lâu → Postgres CẮT session (`25P03`), nhả khoá. */
  idleInTransactionTimeoutMs: number;
}
