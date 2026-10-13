import type { UserRow } from '../../../infra/database/schema/index.js';

export class MeResponseDto {
  id: string;

  /** @example "an.nguyen@example.com" */
  email: string;

  /** @example "Nguyễn Văn An" */
  displayName: string;

  /** @example "2026-10-13T08:00:00.000Z" */
  createdAt: string;

  // M2 thêm: organizations: { id, name, role }[]

  /** Map tường minh từng field — KHÔNG spread row (row có passwordHash). */
  static from(row: UserRow): MeResponseDto {
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
