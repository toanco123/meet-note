import { runMigrations } from '../infra/database/migrate.js';

/**
 * Chạy: `pnpm build && pnpm db:migrate` (đọc .env nếu có) hoặc `node dist/scripts/migrate.js`.
 * Trong compose: service `migrate` chạy một lần trước khi api/worker khởi động.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Thiếu DATABASE_URL');
  process.exit(1);
}

console.log('Đang chạy migration...');
await runMigrations(databaseUrl);
console.log('Migration xong.');
