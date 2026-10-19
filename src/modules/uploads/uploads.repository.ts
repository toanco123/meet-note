import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { type UploadRow, uploadParts, uploads } from '../../infra/database/schema/index.js';
import type { SavedPart, UploadView } from './uploads.types.js';

@Injectable()
export class UploadsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Lấy id TRƯỚC khi INSERT: object key trên S3 chứa id, mà multipart phải mở trước khi ghi DB
   * (xem `UploadsService.init`). `uuidv7()` của Postgres giữ id có thứ tự thời gian như mọi bảng khác.
   */
  async allocateId(): Promise<string> {
    const result = await this.db.execute<{ id: string }>(sql`select uuidv7()::text as id`);
    const id = result.rows[0]?.id;
    if (!id) throw new Error('uuidv7() không trả giá trị');
    return id;
  }

  /** `PgInsertValue` (không phải `$inferInsert`) để cột nhận được biểu thức SQL, vd `now() + …`. */
  async insert(
    values: PgInsertValue<typeof uploads>,
    executor: DbExecutor = this.db,
  ): Promise<UploadRow> {
    const [row] = await executor.insert(uploads).values(values).returning();
    if (!row) throw new Error('INSERT uploads không trả về dòng nào');
    return row;
  }

  /** Upload của ĐÚNG người tạo trong ĐÚNG tổ chức — điều kiện thiếu bất kỳ vế nào cũng là lỗ hổng. */
  async findOwned(orgId: string, userId: string, uploadId: string): Promise<UploadRow | undefined> {
    const [row] = await this.db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, uploadId), eq(uploads.orgId, orgId), eq(uploads.userId, userId)));
    return row;
  }

  async lockOwned(
    orgId: string,
    userId: string,
    uploadId: string,
    executor: DbExecutor,
  ): Promise<UploadRow | undefined> {
    const [row] = await executor
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, uploadId), eq(uploads.orgId, orgId), eq(uploads.userId, userId)))
      .for('update');
    return row;
  }

  listParts(uploadId: string, executor: DbExecutor = this.db): Promise<UploadView['parts']> {
    return executor
      .select({ partNumber: uploadParts.partNumber, sizeBytes: uploadParts.sizeBytes })
      .from(uploadParts)
      .where(eq(uploadParts.uploadId, uploadId))
      .orderBy(asc(uploadParts.partNumber));
  }

  /**
   * Lưu phần vừa lên S3 — CHỈ khi upload vẫn đang nhận dữ liệu (chưa huỷ / complete / hết hạn).
   * Gửi lại cùng phần = `ON CONFLICT DO UPDATE` (idempotent, ETag mới thay ETag cũ).
   * Không khoá dòng upload: phần có thể mất hàng phút để lên S3, không giữ khoá suốt thời gian đó;
   * điều kiện `EXISTS` cùng câu lệnh là đủ (huỷ giữa chừng → 0 dòng → 409).
   */
  async upsertPart(part: SavedPart & { uploadId: string }): Promise<boolean> {
    const result = await this.db.execute(sql`
      insert into ${uploadParts} (upload_id, part_number, size_bytes, etag)
      select ${part.uploadId}::uuid, ${part.partNumber}::int, ${part.sizeBytes}::int, ${part.etag}
      where exists (
        select 1 from ${uploads}
        where ${uploads.id} = ${part.uploadId}::uuid
          and ${uploads.status} = 'initiated'
          and ${uploads.expiresAt} > now()
      )
      on conflict (upload_id, part_number) do update
        set size_bytes = excluded.size_bytes, etag = excluded.etag, created_at = now()
      returning part_number`);
    return result.rows.length > 0;
  }

  async markAborted(uploadId: string, executor: DbExecutor): Promise<void> {
    await executor.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, uploadId));
  }

  async markStorageAborted(uploadId: string): Promise<void> {
    await this.db
      .update(uploads)
      .set({ storageAbortedAt: sql`now()` })
      .where(eq(uploads.id, uploadId));
  }
}
