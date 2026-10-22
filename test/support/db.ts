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
export function createTestDb(max = 10, connectionString = process.env.DATABASE_URL): TestDb {
  const pool = new Pool({ connectionString, max });
  // Lưới an toàn: teardown (`DROP DATABASE … WITH (FORCE)`) cắt connection pool đang đóng dở →
  // `FATAL 57P01` → pool phát 'error'; không ai nghe = uncaught exception, CẢ lượt test bị tính
  // là thất bại dù mọi test xanh. Chỉ bỏ qua đúng ca đó; lỗi khác vẫn ném ra cho lộ.
  pool.on('error', (error) => {
    if ((error as { code?: string }).code === '57P01' && pool.ending) return;
    throw error;
  });
  // Như `createPgPool` (M11 B1): connection đang được MƯỢN (test race bị kẹt lúc teardown) không có
  // listener 'error' → `57P01` thành uncaught exception, che mất lỗi thật của test. Câu lệnh kế
  // tiếp của người mượn vẫn thấy lỗi.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      if ((error as { code?: string }).code !== '57P01') throw error;
    });
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool, close: () => endPool(pool) };
}

/**
 * BẪY (pg-pool 3.14): `pool.end()` resolve NGAY khi đã ra lệnh đóng cho các client, CHƯA đợi socket
 * đóng hẳn (`_remove` gỡ client khỏi danh sách đồng bộ, `client.end()` chạy sau). Teardown chạy
 * ngay sau đó sẽ cắt những connection còn sống. Đợi đủ sự kiện 'remove' (phát khi từng
 * `client.end()` xong) mới coi là đóng.
 */
async function endPool(pool: Pool): Promise<void> {
  const open = pool.totalCount;
  let removed = 0;
  const allClosed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    pool.on('remove', () => {
      if (++removed >= open) resolve();
    });
  });
  await pool.end();
  await allClosed;
}
