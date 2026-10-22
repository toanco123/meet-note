import { Client, escapeIdentifier, escapeLiteral } from 'pg';

/** User đăng nhập của từng tiến trình — thành viên của role nhóm tạo ở migration `0011_app_roles`. */
export const DB_LOGINS = {
  api: { name: 'meetnote_api_login', group: 'meetnote_app', bypassRls: false },
  /** Job chạy xuyên tổ chức (purge, fan-out) → bỏ qua RLS (M11 B7). Đặt trên USER, không kế thừa từ nhóm. */
  worker: { name: 'meetnote_worker_login', group: 'meetnote_worker', bypassRls: true },
} as const;

/**
 * Tạo / cập nhật user đăng nhập (M11 B6). Chạy bằng kết nối có quyền tạo role — bước provision của
 * script migrate, test global setup. Mật khẩu KHÔNG nằm trong migration (git) và không được log.
 *
 * `CREATE ROLE … PASSWORD` không nhận tham số bind ($1) → escape bằng `escapeLiteral` của `pg`.
 * Gọi lại được: đã có thì `ALTER ROLE` (đổi mật khẩu = chạy lại với env mới).
 */
export async function provisionLoginRoles(
  adminUrl: string,
  passwords: Record<keyof typeof DB_LOGINS, string>,
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [key, login] of Object.entries(DB_LOGINS) as Array<
      [keyof typeof DB_LOGINS, (typeof DB_LOGINS)[keyof typeof DB_LOGINS]]
    >) {
      const name = escapeIdentifier(login.name);
      const attributes = `LOGIN PASSWORD ${escapeLiteral(passwords[key])} ${login.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`;
      const exists = await client.query('select 1 from pg_roles where rolname = $1', [login.name]);
      await client.query(
        exists.rowCount ? `ALTER ROLE ${name} ${attributes}` : `CREATE ROLE ${name} ${attributes}`,
      );
      await client.query(`GRANT ${escapeIdentifier(login.group)} TO ${name}`);
    }
  } finally {
    await client.end();
  }
}
