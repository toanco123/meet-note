import { defineConfig } from 'vitest/config';

/**
 * E2E + integration: Postgres và Redis THẬT qua Testcontainers (cần Docker).
 * - globalSetup: khởi động container 1 lần, migrate vào database template.
 * - setupFiles: mỗi file test clone 1 database riêng từ template → chạy song song an toàn.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts', 'src/**/*.int-spec.ts'],
    environment: 'node',
    globalSetup: ['test/support/global-setup.ts'],
    setupFiles: ['reflect-metadata', 'test/support/setup-e2e.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
