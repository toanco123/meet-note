import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  idempotencyKeys,
  meetings,
  organizationMembers,
  uploadParts,
  uploads,
} from '../../../../../src/infra/database/schema/index.js';
import {
  addMember,
  insertMeeting,
  insertOrg,
  insertUpload,
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

const MiB = 1024 * 1024;

describe('Schema uploads / meetings / idempotency (Postgres thật)', () => {
  let t: TestDb;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    t = createTestDb();
    const owner = await insertUser(t.db);
    userId = owner.id;
    orgId = (await insertOrg(t.db, owner.id)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  describe('uploads', () => {
    it.each([
      ['0 byte', { sizeBytes: 0, totalParts: 0 }, 'uploads_size_ck'],
      ['quá 2 GiB', { sizeBytes: 2 * 1024 * MiB + 1, totalParts: 257 }, 'uploads_size_ck'],
      ['sha256 không phải 64 hex thường', { sha256: 'ABC' }, 'uploads_sha256_ck'],
      [
        'chunk < 5 MiB (S3 từ chối phần nhỏ)',
        { chunkSize: 4 * MiB, totalParts: 5 },
        'uploads_chunk_size_ck',
      ],
      ['total_parts lệch ceil(size / chunk)', { totalParts: 2 }, 'uploads_total_parts_ck'],
      ['mime ngoài danh sách', { mimeType: 'image/png' as never }, 'uploads_mime_type_ck'],
      ['completed mà chưa có meeting', { status: 'completed' as const }, 'uploads_completed_ck'],
    ])('%s → CHECK %s', async (_label, overrides, constraint) => {
      expect(await pgErrorOf(insertUpload(t.db, orgId, userId, overrides))).toMatchObject({
        code: '23514',
        constraint,
      });
    });

    it('biên hợp lệ: đúng 2 GiB → 256 phần 8 MiB; file 1 byte → 1 phần', async () => {
      await expect(
        insertUpload(t.db, orgId, userId, { sizeBytes: 2 * 1024 * MiB, totalParts: 256 }),
      ).resolves.toMatchObject({ totalParts: 256 });
      await expect(
        insertUpload(t.db, orgId, userId, { sizeBytes: 1, totalParts: 1 }),
      ).resolves.toMatchObject({ totalParts: 1 });
    });

    it('meeting của upload phải cùng org (composite FK)', async () => {
      const otherOwner = await insertUser(t.db);
      const otherOrg = await insertOrg(t.db, otherOwner.id);
      const foreign = await insertMeeting(t.db, otherOrg.id, otherOwner.id);
      const error = await pgErrorOf(
        insertUpload(t.db, orgId, userId, {
          status: 'completed',
          meetingId: foreign.id,
          completedAt: new Date(),
        }),
      );
      expect(error).toMatchObject({ code: '23503', constraint: 'uploads_meeting_fk' });
    });
  });

  describe('upload_parts', () => {
    it('part_number ngoài 1–10000 → CHECK; gửi lại cùng phần → trùng PK (service dùng ON CONFLICT)', async () => {
      const upload = await insertUpload(t.db, orgId, userId);
      const part = (partNumber: number) =>
        t.db
          .insert(uploadParts)
          .values({ uploadId: upload.id, partNumber, sizeBytes: 8 * MiB, etag: 'e' });

      expect(await pgErrorOf(part(0))).toMatchObject({ constraint: 'upload_parts_number_ck' });
      expect(await pgErrorOf(part(10_001))).toMatchObject({ constraint: 'upload_parts_number_ck' });
      await part(1);
      expect(await pgErrorOf(part(1))).toMatchObject({
        code: '23505',
        constraint: 'upload_parts_pk',
      });
    });

    it('xoá upload → các phần đi theo (cascade)', async () => {
      const upload = await insertUpload(t.db, orgId, userId);
      await t.db
        .insert(uploadParts)
        .values({ uploadId: upload.id, partNumber: 1, sizeBytes: 1, etag: 'e' });
      await t.db.delete(uploads).where(eq(uploads.id, upload.id));
      const left = await t.db.select().from(uploadParts).where(eq(uploadParts.uploadId, upload.id));
      expect(left).toEqual([]);
    });
  });

  describe('meetings', () => {
    /**
     * M5 Q1: `ON DELETE SET NULL (owner_id)` (migration viết tay 0007). Dạng `SET NULL` thường sẽ
     * null CẢ `org_id` → 23502 → không gỡ được thành viên khỏi org.
     */
    it('gỡ chủ khỏi org → meeting ở lại: owner_id NULL, org_id GIỮ NGUYÊN', async () => {
      const member = await insertUser(t.db);
      await addMember(t.db, orgId, member.id, 'member');
      const meeting = await insertMeeting(t.db, orgId, member.id);

      await t.db
        .delete(organizationMembers)
        .where(
          and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, member.id)),
        );

      const [row] = await t.db
        .select({ orgId: meetings.orgId, ownerId: meetings.ownerId })
        .from(meetings)
        .where(eq(meetings.id, meeting.id));
      expect(row).toEqual({ orgId, ownerId: null });
    });

    it('chủ phải là thành viên của ĐÚNG org đó (composite FK)', async () => {
      const outsider = await insertUser(t.db);
      expect(await pgErrorOf(insertMeeting(t.db, orgId, outsider.id))).toMatchObject({
        code: '23503',
        constraint: 'meetings_owner_fk',
      });
    });

    it('status lạ / attempt 0 → CHECK', async () => {
      expect(
        await pgErrorOf(insertMeeting(t.db, orgId, userId, { status: 'done' as never })),
      ).toMatchObject({ constraint: 'meetings_status_ck' });
      expect(await pgErrorOf(insertMeeting(t.db, orgId, userId, { attempt: 0 }))).toMatchObject({
        constraint: 'meetings_attempt_ck',
      });
    });
  });

  describe('idempotency_keys', () => {
    it('completed mà chưa lưu response → CHECK; cùng (user, key) → trùng PK', async () => {
      const row = (status: 'processing' | 'completed') =>
        t.db.insert(idempotencyKeys).values({
          userId,
          key: 'k-1',
          method: 'POST',
          path: '/v1/x',
          requestHash: 'h',
          status,
          expiresAt: new Date(Date.now() + 3600_000),
        });
      expect(await pgErrorOf(row('completed'))).toMatchObject({
        constraint: 'idempotency_keys_completed_ck',
      });
      await row('processing');
      expect(await pgErrorOf(row('processing'))).toMatchObject({
        code: '23505',
        constraint: 'idempotency_keys_pk',
      });
    });
  });

  describe('index cho job dọn dẹp', () => {
    it('tìm upload `initiated` quá hạn → đọc partial index uploads_expiry_idx', async () => {
      const plan = await t.db.transaction(async (tx) => {
        await tx.execute(sql`analyze uploads`);
        await tx.execute(sql`set local enable_seqscan = off`);
        const result = await tx.execute(
          sql`explain select id from uploads where status = 'initiated' and expires_at < now() order by expires_at limit 100`,
        );
        return result.rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      });
      expect(plan).toContain('uploads_expiry_idx');
    });
  });
});
