import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm db:generate`            → so sánh schema TS với snapshot, sinh file SQL mới trong migrations/
 * `pnpm db:generate --custom --name=xxx` → tạo file SQL rỗng để viết tay (extension, function…)
 *
 * Luôn ĐỌC file SQL sinh ra trước khi commit: drizzle-kit có thể sinh DROP + ADD thay vì RENAME.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infra/database/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://meetnote:meetnote@localhost:5432/meetnote',
  },
});
