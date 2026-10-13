import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/common/pagination/cursor.js';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { createTestApp } from '../support/app.js';
import { addMember, insertUser } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

interface MemberBody {
  userId: string;
  displayName: string;
  role: string;
}
interface PageBody {
  data: MemberBody[];
  nextCursor: string | null;
}

describe('GET /v1/orgs/:orgId/members — cursor + tìm không dấu (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let outsider: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());
  const list = (query: Record<string, string | number>, who: TestUser = owner) =>
    http().get(`/v1/orgs/${orgId}/members`).query(query).set(bearer(who.tokens.accessToken));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    owner = await registerUser(app, { displayName: 'Chủ Tổ Chức' });
    outsider = await registerUser(app);
    orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Phân trang' })
        .expect(201)
    ).body.id;

    // 24 thành viên + owner = 25. 6 người đầu tham gia CÙNG một thời điểm → buộc phải có tie-breaker.
    const sameInstant = new Date('2026-01-01T00:00:00.123456Z');
    const names = [
      'Nguyễn Văn An',
      'NGUYỄN THỊ BÌNH',
      'Trần Đức Cường',
      'Lê Thị Dung',
      'Phạm 100% Năng Lượng',
      'Hoàng_Gạch_Dưới',
    ];
    for (let i = 0; i < 24; i++) {
      const user = await insertUser(db, { displayName: names[i] ?? `Thành viên ${i}` });
      await addMember(
        db,
        orgId,
        user.id,
        i % 5 === 0 ? 'admin' : 'member',
        i < 6 ? sameInstant : undefined,
      );
    }
  });

  afterAll(async () => {
    await app.close();
  });

  async function collectAllPages(limit: number): Promise<{ pages: number; ids: string[] }> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(cursor ? { limit, cursor } : { limit }).expect(200);
      const body = res.body as PageBody;
      ids.push(...body.data.map((m) => m.userId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    return { pages, ids };
  }

  it('limit=10 → 3 trang (10, 10, 5): không trùng, không sót, trang cuối nextCursor = null', async () => {
    const { pages, ids } = await collectAllPages(10);

    expect(pages).toBe(3);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });

  it('limit=4 cắt ngang nhóm 6 người cùng thời điểm vẫn không trùng/sót (tie-breaker user_id)', async () => {
    const { ids } = await collectAllPages(4);
    expect(new Set(ids).size).toBe(25);
  });

  it('thứ tự ổn định giữa các lần gọi', async () => {
    const a = await collectAllPages(7);
    const b = await collectAllPages(25);
    expect(a.ids).toEqual(b.ids);
  });

  it('q="nguyen" khớp cả "Nguyễn Văn An" và "NGUYỄN THỊ BÌNH" (không dấu, không phân biệt hoa thường)', async () => {
    const res = await list({ q: 'nguyen' }).expect(200);
    expect((res.body as PageBody).data.map((m) => m.displayName).sort()).toEqual([
      'NGUYỄN THỊ BÌNH',
      'Nguyễn Văn An',
    ]);
  });

  it('q có dấu cũng khớp ("Đức" → "Trần Đức Cường")', async () => {
    const res = await list({ q: 'Đức' }).expect(200);
    expect((res.body as PageBody).data.map((m) => m.displayName)).toEqual(['Trần Đức Cường']);
  });

  it.each([
    ['%', 'Phạm 100% Năng Lượng'],
    ['_', 'Hoàng_Gạch_Dưới'],
  ])('q="%s" được tìm NGUYÊN VĂN (escape LIKE), chỉ khớp "%s"', async (q, expected) => {
    const res = await list({ q }).expect(200);
    expect((res.body as PageBody).data.map((m) => m.displayName)).toEqual([expected]);
  });

  it('role=admin chỉ trả admin', async () => {
    const res = await list({ role: 'admin', limit: 100 }).expect(200);
    const roles = new Set((res.body as PageBody).data.map((m) => m.role));
    expect([...roles]).toEqual(['admin']);
  });

  it.each([
    ['cursor không decode được', { cursor: 'xxx' }],
    ['cursor bị sửa tay: thời gian rác', { cursor: encodeCursor(["1' or 1=1 --", 'x']) }],
    [
      'cursor bị sửa tay: thời gian mili giây thay vì micro giây',
      {
        cursor: encodeCursor(['2026-01-01T00:00:00.123Z', '01a1348f-62e3-7e0b-a09a-7f6f8cd88117']),
      },
    ],
    ['cursor của danh sách khác (3 khoá)', { cursor: encodeCursor(['a', 'b', 'c']) }],
  ])('%s → 400 INVALID_CURSOR (không phải 500)', async (_label, query) => {
    const res = await list(query).expect(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it.each([
    ['limit=0', { limit: 0 }],
    ['limit=101', { limit: 101 }],
    ['role lạ', { role: 'superadmin' }],
  ])('%s → 400 VALIDATION_FAILED', async (_label, query) => {
    const res = await list(query).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('người ngoài → 404', async () => {
    const res = await list({}, outsider).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
