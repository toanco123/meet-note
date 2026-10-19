import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, escapeIdentifier } from 'pg';

export const POSTGRES_IMAGE = 'postgres:18.6-alpine';
export const REDIS_IMAGE = 'redis:8.8.3-alpine';
/** Giữ cùng phiên bản với `compose.yaml` (09-versions). */
export const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.1';
export const TEMPLATE_DATABASE = 'meetnote_template';

/** SQLSTATE 55006: object_in_use — template đang bị phiên khác dùng. */
const PG_OBJECT_IN_USE = '55006';

export function withDatabase(connectionUrl: string, database: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(
  connectionUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(
  adminUrl: string,
  name: string,
  template?: string,
): Promise<void> {
  const statement =
    `CREATE DATABASE ${escapeIdentifier(name)}` +
    (template ? ` TEMPLATE ${escapeIdentifier(template)}` : '');

  // BẪY: nhiều file test clone cùng template đồng thời có thể nhận lỗi 55006
  // ("source database is being accessed by other users") → thử lại có backoff.
  for (let attempt = 1; ; attempt++) {
    try {
      await withClient(adminUrl, (client) => client.query(statement));
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== PG_OBJECT_IN_USE || attempt >= 10) throw error;
      await sleep(50 * attempt + Math.random() * 50);
    }
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  // WITH (FORCE): ngắt các kết nối còn sót (pool của app chưa kịp đóng).
  await withClient(adminUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`),
  );
}

export interface TestDatabase {
  url: string;
  drop: () => Promise<void>;
}

/** Clone database template (đã migrate) → database riêng cho một file test, ~vài chục ms. */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  await createDatabase(adminUrl, name, TEMPLATE_DATABASE);
  return { url: withDatabase(adminUrl, name), drop: () => dropDatabase(adminUrl, name) };
}
