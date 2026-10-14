import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  channelMembers,
  channels,
  organizationMembers,
} from '../../../../../src/infra/database/schema/index.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertOrg,
  insertUser,
} from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

describe('Schema channels (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });

  afterAll(async () => {
    await t.close();
  });

  async function orgWithOwner() {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    return { owner, org };
  }

  it('người KHÔNG thuộc org không vào được kênh → 23503 channel_members_org_member_fk', async () => {
    const { owner, org } = await orgWithOwner();
    const channel = await insertChannel(t.db, org.id, owner.id);
    const outsider = await insertUser(t.db);

    const error = await pgErrorOf(addChannelMember(t.db, channel, org.id, outsider.id));
    expect(error).toMatchObject({ code: '23503', constraint: 'channel_members_org_member_fk' });
  });

  it('không ghi được membership "org B" vào kênh của org A (composite FK chặn dữ liệu chéo tenant)', async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    const channelOfA = await insertChannel(t.db, a.org.id, a.owner.id);

    // Người này là thành viên org B (thoả FK thứ hai), nhưng kênh thuộc org A.
    const error = await pgErrorOf(addChannelMember(t.db, channelOfA, b.org.id, b.owner.id));
    expect(error).toMatchObject({ code: '23503', constraint: 'channel_members_channel_fk' });
  });

  it('mỗi kênh tối đa 1 chủ → 23505 channel_members_one_owner_uq', async () => {
    const { owner, org } = await orgWithOwner();
    const other = await insertUser(t.db);
    await addMember(t.db, org.id, other.id);
    const channel = await insertChannel(t.db, org.id, owner.id);

    const error = await pgErrorOf(
      t.db
        .insert(channelMembers)
        .values({ channelId: channel.id, orgId: org.id, userId: other.id, role: 'owner' }),
    );
    expect(error).toMatchObject({ code: '23505', constraint: 'channel_members_one_owner_uq' });
  });

  it('bị xoá khỏi org → tự rời mọi kênh (cascade) — kể cả dòng CHỦ kênh (vì vậy service phải chặn)', async () => {
    const { owner, org } = await orgWithOwner();
    const member = await insertUser(t.db);
    await addMember(t.db, org.id, member.id);
    const ownedByMember = await insertChannel(t.db, org.id, member.id);
    const other = await insertChannel(t.db, org.id, owner.id);
    await addChannelMember(t.db, other, org.id, member.id);

    await t.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, member.id)));

    expect(
      await t.db.select().from(channelMembers).where(eq(channelMembers.userId, member.id)),
    ).toHaveLength(0);
    // Kênh mà người đó làm chủ giờ KHÔNG CÒN CHỦ — đúng điều M4 Q3 phải ngăn ở tầng service.
    expect(
      await t.db
        .select()
        .from(channelMembers)
        .where(eq(channelMembers.channelId, ownedByMember.id)),
    ).toHaveLength(0);
  });

  describe('tên kênh', () => {
    it('trùng tên khác hoa thường trong cùng org → 23505 channels_org_name_uq', async () => {
      const { owner, org } = await orgWithOwner();
      await insertChannel(t.db, org.id, owner.id, { name: 'Backend' });

      const error = await pgErrorOf(insertChannel(t.db, org.id, owner.id, { name: 'BACKEND' }));
      expect(error).toMatchObject({ code: '23505', constraint: 'channels_org_name_uq' });
    });

    it('xoá mềm rồi thì dùng lại được tên; org khác trùng tên thoải mái', async () => {
      const { owner, org } = await orgWithOwner();
      const old = await insertChannel(t.db, org.id, owner.id, { name: 'Dự án X' });
      await t.db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, old.id));

      await expect(
        insertChannel(t.db, org.id, owner.id, { name: 'dự án x' }),
      ).resolves.toBeDefined();
      const another = await orgWithOwner();
      await expect(
        insertChannel(t.db, another.org.id, another.owner.id, { name: 'Dự án X' }),
      ).resolves.toBeDefined();
    });

    it('tên rỗng / visibility lạ bị CHECK chặn', async () => {
      const { owner, org } = await orgWithOwner();
      expect(await pgErrorOf(insertChannel(t.db, org.id, owner.id, { name: '' }))).toMatchObject({
        code: '23514',
        constraint: 'channels_name_length_ck',
      });
      const error = await pgErrorOf(
        // @ts-expect-error — cố tình đưa giá trị ngoài enum để kiểm tra CHECK ở tầng DB
        t.db.insert(channels).values({ orgId: org.id, name: 'x', visibility: 'secret' }),
      );
      expect(error).toMatchObject({ code: '23514', constraint: 'channels_visibility_ck' });
    });
  });

  /**
   * Danh sách kênh sắp theo BIỂU THỨC `lower(name)` (M4 Q4). Index `channels_org_name_uq` được tạo
   * trên đúng biểu thức đó + cùng điều kiện partial `deleted_at IS NULL` → planner đọc thẳng index
   * theo thứ tự. Viết `ORDER BY name` (không lower) thì không khớp → phải Sort.
   */
  describe('index biểu thức phục vụ danh sách theo tên', () => {
    async function planOf(orgId: string, orderBy: string, extra = ''): Promise<string> {
      return t.db.transaction(async (tx) => {
        await tx.execute(sql`analyze channels`);
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`set local enable_bitmapscan = off`);
        const result = await tx.execute(
          sql.raw(
            `explain select id from channels where org_id = '${orgId}' and deleted_at is null ${extra} order by ${orderBy} limit 21`,
          ),
        );
        return result.rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      });
    }

    it('ORDER BY lower(name) + cursor `lower(name) > …` → Index Scan, không Sort', async () => {
      const { owner, org } = await orgWithOwner();
      for (const name of ['Bravo', 'alpha', 'Charlie']) {
        await insertChannel(t.db, org.id, owner.id, { name });
      }
      const plan = await planOf(org.id, 'lower(name)', "and lower(name) > 'alpha'");
      expect(plan).toContain('channels_org_name_uq');
      expect(plan).not.toMatch(/\bSort\b/);
    });

    it('ORDER BY name (lệch biểu thức của index) → phải Sort', async () => {
      const { org } = await orgWithOwner();
      expect(await planOf(org.id, 'name')).toMatch(/\bSort\b/);
    });
  });
});
