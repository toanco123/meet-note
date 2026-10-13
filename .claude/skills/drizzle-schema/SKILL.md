---
name: drizzle-schema
description: Thiết kế và thay đổi schema PostgreSQL 18 bằng Drizzle trong MeetNote — thêm bảng/cột/index/constraint, sinh migration bằng drizzle-kit hoặc viết SQL tay, composite FK giữ nhất quán tenant (org_id), partial unique index, enum bằng text + CHECK, generated column tsvector, uuidv7. Dùng mỗi khi động tới src/infra/database/schema hoặc thư mục migrations/, hoặc khi người dùng nói "thêm bảng", "thêm cột", "tạo index", "migration", "đổi schema", "unique", "foreign key", "constraint", "tìm kiếm không dấu". Use for any database schema or migration change in this repo.
---

# Schema & migration với Drizzle

**Nguồn sự thật là `docs/design/03-database.md`.** Đọc mục của bảng liên quan trước. Code khác tài liệu thì sửa tài liệu trong cùng thay đổi, và nói rõ với người dùng lý do đổi.

## Vị trí file

- `src/infra/database/schema/<domain>.ts`: mỗi domain một file. Re-export trong `schema/index.ts` (`export * from './users.js'`).
- `migrations/`: SQL do drizzle-kit sinh, kèm SQL viết tay. **Commit** cả `migrations/meta/`.
- `drizzle.config.ts`: `casing: 'snake_case'`. TS viết camelCase, DB sinh ra snake_case.

## Quy ước khi viết bảng

```ts
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

export const channels = pgTable(
  'channels',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`), // PG18 có sẵn uuidv7()
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    visibility: text({ enum: ['public', 'private'] }).notNull(), // enum chỉ là kiểu TS…
    archivedAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('channels_id_org_uq').on(t.id, t.orgId), // đích cho composite FK
    uniqueIndex('channels_org_name_uq')
      .on(t.orgId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`), // tên đã xoá mềm được dùng lại
    check('channels_visibility_ck', sql`${t.visibility} in ('public', 'private')`), // …CHECK mới chặn ở DB
    index('channels_org_created_idx')
      .on(t.orgId, t.createdAt, t.id)
      .where(sql`${t.deletedAt} is null`),
  ],
);
```

| Quy tắc                                                                                                                         | Lý do                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| PK `uuid` + `default(sql\`uuidv7()\`)`. Bảng log lớn dùng `bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity()` | uuidv7 có thứ tự thời gian, index ít phân mảnh                                            |
| Thời gian dùng `timestamp({ withTimezone: true })`. Ngày lịch (`week_start`) dùng `date()`                                      | Tránh lệch múi giờ                                                                        |
| Enum = `text({ enum })` + `check(...)`                                                                                          | Thêm/bớt giá trị dễ. `CREATE TYPE` khó sửa                                                |
| **Đặt tên mọi constraint/index**: `<bảng>_<cột>_<pk\|uq\|fk\|ck\|idx>`                                                          | Filter lỗi và service map `constraint` sang mã lỗi cụ thể. Tên tự sinh thì dài và khó đọc |
| Bảng con mang `orgId` + **composite FK** `(xId, orgId)` → `(id, orgId)` của bảng cha                                            | DB chặn dữ liệu chéo tổ chức kể cả khi code có bug                                        |
| "Tối đa 1 owner" bằng partial unique index `WHERE role = 'owner'`                                                               | Bất biến được ép ở tầng DB                                                                |
| `updatedAt` dùng `$onUpdate`                                                                                                    | Chỉ chạy khi update qua Drizzle. Update bằng SQL thô thì phải tự set                      |

Composite FK:

```ts
foreignKey({
  name: 'channel_members_channel_fk',
  columns: [t.channelId, t.orgId],
  foreignColumns: [channels.id, channels.orgId],
}).onDelete('cascade'),
```

Generated column tsvector (Drizzle không có sẵn kiểu `tsvector`):

```ts
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
// trong bảng transcript_segments:
search: tsvector().generatedAlwaysAs(
  (): SQL => sql`to_tsvector('meetnote_vi'::regconfig, ${transcriptSegments.text})`,
),
// + index('transcript_segments_search_idx').using('gin', t.search)
```

Tìm không dấu dùng hàm `f_unaccent()` (IMMUTABLE, tạo trong `0000_extensions.sql`), không gọi trực tiếp `unaccent()` (STABLE) trong index hay generated column.

## Quy trình đổi schema

1. Sửa/thêm file trong `schema/`, export ở `index.ts`.
2. `pnpm db:generate --name=<mo_ta_ngan>`.
3. **Đọc file SQL vừa sinh**, kiểm tra:
   - đổi tên cột có bị sinh thành `DROP` + `ADD` không (mất dữ liệu)? drizzle-kit hỏi rename khi chạy tương tác, ở chế độ không tương tác phải tự sửa SQL;
   - đủ CHECK, đúng thứ tự cột trong index, partial `WHERE`;
   - thêm cột `NOT NULL` vào bảng đã có dữ liệu thì phải có `DEFAULT` hoặc làm qua nhiều bước.
4. Thứ Drizzle không biểu diễn được (function, trigger, text search config, extension, `REVOKE`, policy RLS): `pnpm db:generate --custom --name=<mo_ta>` rồi viết SQL. Ngăn các câu lệnh bằng `--> statement-breakpoint`.
5. **Không sửa migration đã chạy/đã commit.** Muốn đổi thì tạo migration mới.
6. Chạy thử: `pnpm build && pnpm db:migrate` (DB local), hoặc `pnpm test:e2e` (global setup migrate vào template DB).
7. Viết integration test cho constraint quan trọng. Ví dụ insert vi phạm partial unique phải lỗi `23505` với đúng tên constraint. Xem skill `testing`.
8. Cập nhật `docs/design/03-database.md`.

## Bẫy

- **Migration chạy trong MỘT transaction.** `CREATE INDEX CONCURRENTLY` không chạy được trong transaction. Bảng lớn cần index concurrently thì tách migration riêng và cân nhắc kỹ.
- **Partial unique index không `DEFERRABLE` được.** Đổi owner phải hạ owner cũ trước, nâng owner mới sau.
- **Timestamp sang JS `Date` mất micro giây.** Cột dùng làm cursor thì select dạng `sql<string>\`${col}::text\``.
- **`text({ enum })` không tạo CHECK.** Thiếu `check(...)` thì DB nhận mọi chuỗi.
- **Extension cần quyền cao.** Local/Testcontainers không vấn đề gì, nhưng DB managed phải kiểm tra danh sách extension được phép.
- **Không chạy migration lúc app khởi động.** Migration chạy bằng service `migrate` (compose) hoặc `pnpm db:migrate`.
- Import giữa các file schema dùng `.js`. drizzle-kit 0.31 resolve được (đã kiểm chứng).
