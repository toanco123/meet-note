import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/infra/database/migrate.js';
import {
  createDatabase,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  TEMPLATE_DATABASE,
  withDatabase,
} from './database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL tới database mặc định của container — chỉ dùng để CREATE/DROP database. */
    postgresAdminUrl: string;
    redisUrl: string;
  }
}

/** Chạy MỘT lần cho cả lượt test: khởi động container, migrate vào database template. */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  const adminUrl = postgres.getConnectionUri();
  await createDatabase(adminUrl, TEMPLATE_DATABASE);
  // runMigrations tự đóng pool sau khi xong — template phải KHÔNG còn kết nối nào
  // thì CREATE DATABASE ... TEMPLATE mới chạy được.
  await runMigrations(withDatabase(adminUrl, TEMPLATE_DATABASE));

  project.provide('postgresAdminUrl', adminUrl);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
