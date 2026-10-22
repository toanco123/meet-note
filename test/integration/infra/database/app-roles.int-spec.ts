import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../src/common/errors/pg-error.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/**
 * Quyền tối thiểu ở DB (M11 B6). Toàn bộ e2e chạy dưới user của api là bằng chứng GRANT ĐỦ; file
 * này chứng minh GRANT KHÔNG THỪA: không DDL, không TRUNCATE, không superuser.
 */
describe('Role của app (Postgres thật)', () => {
  let app: TestDb;
  let owner: TestDb;

  beforeAll(() => {
    app = createTestDb(2);
    owner = createTestDb(1, process.env.TEST_ADMIN_DATABASE_URL);
  });

  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const codeOf = (statement: Promise<unknown>) =>
    statement.then(
      () => 'thành công',
      (error: unknown) => findPgError(error)?.code ?? String(error),
    );

  it('app = user đăng nhập riêng, không superuser, thuộc nhóm meetnote_app; worker có BYPASSRLS', async () => {
    const { rows } = await app.db.execute<{
      me: string;
      superuser: boolean;
      in_group: boolean;
      api_bypass: boolean;
      worker_bypass: boolean;
    }>(sql`
      select current_user as me,
             (select rolsuper from pg_roles where rolname = current_user) as superuser,
             pg_has_role(current_user, 'meetnote_app', 'member') as in_group,
             (select rolbypassrls from pg_roles where rolname = 'meetnote_api_login') as api_bypass,
             (select rolbypassrls from pg_roles where rolname = 'meetnote_worker_login') as worker_bypass`);
    expect(rows[0]).toEqual({
      me: 'meetnote_api_login',
      superuser: false,
      in_group: true,
      api_bypass: false,
      worker_bypass: true,
    });
  });

  it.each([
    ['CREATE TABLE', sql`create table x_${sql.raw(String(Date.now()))} (id int)`],
    ['DROP TABLE', sql`drop table users`],
    ['ALTER TABLE', sql`alter table users add column hacked text`],
    ['TRUNCATE', sql`truncate sessions`],
    ['CREATE FUNCTION', sql`create function f_hack() returns int language sql as 'select 1'`],
  ])('%s → 42501 (không phải chủ / không có quyền)', async (_label, statement) => {
    expect(await codeOf(app.db.execute(statement))).toBe('42501');
  });

  it('DML trên bảng của app được phép', async () => {
    expect(await codeOf(app.db.execute(sql`select count(*) from users`))).toBe('thành công');
  });

  // Đột biến: bỏ `ALTER DEFAULT PRIVILEGES` → bảng của migration SAU này app không đọc được.
  it('bảng do chủ schema tạo SAU (như migration mới) → app tự có quyền DML (default privileges)', async () => {
    const table = `future_${Date.now()}`;
    await owner.db.execute(sql.raw(`create table ${table} (id int)`));
    try {
      expect([
        await codeOf(app.db.execute(sql.raw(`insert into ${table} values (1)`))),
        await codeOf(app.db.execute(sql.raw(`select * from ${table}`))),
      ]).toEqual(['thành công', 'thành công']);
    } finally {
      await owner.db.execute(sql.raw(`drop table ${table}`));
    }
  });
});
