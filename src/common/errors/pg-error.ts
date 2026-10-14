import type { PgLikeError } from './errors.types.js';

/** SQLSTATE của Postgres: https://www.postgresql.org/docs/current/errcodes-appendix.html */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

/**
 * Drizzle (≥ 0.44) bọc lỗi driver trong DrizzleQueryError, lỗi gốc của `pg` nằm ở `.cause`.
 * Vì vậy phải đi dọc chuỗi `cause` thay vì kiểm tra trực tiếp.
 */
export function findPgError(error: unknown, depth = 0): PgLikeError | undefined {
  if (depth > 5 || typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; severity?: unknown; cause?: unknown };
  if (
    typeof candidate.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(candidate.code) &&
    candidate.severity !== undefined
  ) {
    return candidate as PgLikeError;
  }
  return findPgError(candidate.cause, depth + 1);
}

/** `true` nếu lỗi là vi phạm unique của đúng constraint/index này. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pg = findPgError(error);
  return pg?.code === PG_UNIQUE_VIOLATION && pg.constraint === constraint;
}
