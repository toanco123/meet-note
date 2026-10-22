import { runMigrations } from '../infra/database/migrate.js';
import { provisionLoginRoles } from '../infra/database/provision-roles.js';

/**
 * Chạy: `pnpm build && pnpm db:migrate` (đọc .env nếu có) hoặc `node dist/scripts/migrate.js`.
 * Trong compose: service `migrate` chạy một lần trước khi api/worker khởi động.
 *
 * Kết nối bằng CHỦ schema (`MIGRATION_DATABASE_URL`, không có thì `DATABASE_URL`) — app thì không
 * (M11 B6). Có `DB_API_PASSWORD` + `DB_WORKER_PASSWORD` → tạo / cập nhật user đăng nhập của api, worker.
 */
const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Thiếu MIGRATION_DATABASE_URL / DATABASE_URL');
  process.exit(1);
}

console.log('Đang chạy migration...');
await runMigrations(databaseUrl);
console.log('Migration xong.');

const { DB_API_PASSWORD: api, DB_WORKER_PASSWORD: worker } = process.env;
if (api && worker) {
  await provisionLoginRoles(databaseUrl, { api, worker });
  console.log('Đã tạo / cập nhật user đăng nhập của api, worker.');
} else if (api || worker) {
  console.error('Cần CẢ DB_API_PASSWORD và DB_WORKER_PASSWORD');
  process.exit(1);
}
