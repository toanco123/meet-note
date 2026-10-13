import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/** Kiểu của `tx` bên trong `db.transaction(async (tx) => …)`. Repository nhận `Database | Transaction`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DbExecutor = Database | Transaction;
