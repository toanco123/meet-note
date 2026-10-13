import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Cùng một đường dẫn khi chạy từ src/ (vitest) lẫn dist/ (node): <root>/migrations
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '../../../migrations');

/**
 * Áp dụng các migration chưa chạy. Drizzle ghi lịch sử vào bảng `drizzle.__drizzle_migrations`.
 *
 * Chạy như một bước riêng (service `migrate` trong compose, job riêng trong CI/CD),
 * KHÔNG chạy lúc api khởi động: nhiều instance cùng migrate sẽ tranh nhau.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
