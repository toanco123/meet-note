import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Database } from '../../src/infra/database/database.types.js';
import * as schema from '../../src/infra/database/schema/index.js';

export interface TestDb {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * Drizzle trỏ vào database riêng của file test (do setup-e2e tạo) — dùng cho integration test
 * không cần dựng cả app Nest. `max` đủ lớn cho test concurrency (mỗi transaction 1 connection).
 */
export function createTestDb(max = 10): TestDb {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
