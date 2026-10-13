import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { type NewUserRow, type UserRow, users } from '../../infra/database/schema/index.js';

/** Tên unique index trên `lower(email)` — service dùng để nhận ra lỗi "email đã tồn tại". */
export const USERS_EMAIL_UNIQUE = 'users_email_lower_uq';

@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insert(
    values: Pick<NewUserRow, 'email' | 'passwordHash' | 'displayName'>,
    executor: DbExecutor = this.db,
  ): Promise<UserRow> {
    const [row] = await executor.insert(users).values(values).returning();
    if (!row) throw new Error('INSERT users không trả về dòng nào');
    return row;
  }

  /**
   * So sánh `lower(email) = lower($1)` — PHẢI viết đúng biểu thức của index
   * `users_email_lower_uq` thì Postgres mới dùng index (viết `email ILIKE $1` sẽ quét cả bảng).
   */
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`);
    return row;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }
}
