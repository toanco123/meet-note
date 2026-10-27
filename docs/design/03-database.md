# 03 — Thiết kế database (PostgreSQL 18)

## 0. Quy ước chung

- Tên bảng `snake_case` số nhiều, cột `snake_case`. Drizzle cấu hình `casing: 'snake_case'` nên TS dùng camelCase.
- PK `uuid DEFAULT uuidv7()`. Bảng log lớn (`audit_logs`, `transcript_segments`) dùng `bigint GENERATED ALWAYS AS IDENTITY`.
- Mọi thời gian dùng `timestamptz`. Riêng `week_start` dùng `date`, vì đó là ngày theo lịch VN chứ không phải thời điểm.
- Enum dùng `text` + `CHECK (col IN (...))` thay vì `CREATE TYPE ... AS ENUM`. Thêm giá trị không cần migration đặc biệt, và bỏ một giá trị cũng dễ.
- **Tenant consistency bằng composite FK:** bảng con mang theo `org_id` và FK `(x_id, org_id)` trỏ tới `UNIQUE (id, org_id)` của bảng cha. Như vậy DB **không cho phép** share meeting của org A vào kênh của org B, kể cả khi code có bug.
- Xoá mềm bằng `deleted_at`. Unique index kèm `WHERE deleted_at IS NULL` để tên đã xoá dùng lại được.

### Role của Postgres (M11 B6, migration `0011_app_roles`)

| Role                    | Loại                                          | Dùng bởi                             | Quyền                                                                                                                                                         |
| ----------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meetnote` (chủ schema) | LOGIN                                         | `migrate` (`MIGRATION_DATABASE_URL`) | Chủ mọi bảng: DDL, migration                                                                                                                                  |
| `meetnote_app`          | NHÓM, NOLOGIN                                 | —                                    | `SELECT, INSERT, UPDATE, DELETE` mọi bảng + sequence; trừ `UPDATE, DELETE` trên `audit_logs`. `ALTER DEFAULT PRIVILEGES` → bảng của migration sau tự có quyền |
| `meetnote_worker`       | NHÓM, NOLOGIN                                 | —                                    | Như `meetnote_app`                                                                                                                                            |
| `meetnote_api_login`    | LOGIN, thuộc `meetnote_app`                   | api                                  | Kế thừa quyền nhóm; bị RLS (M11 B7)                                                                                                                           |
| `meetnote_worker_login` | LOGIN, thuộc `meetnote_worker`, **BYPASSRLS** | worker                               | Kế thừa quyền nhóm; job xuyên tổ chức                                                                                                                         |

Role nhóm + GRANT nằm trong migration (không mật khẩu); user đăng nhập do `provisionLoginRoles` (script migrate khi có `DB_API_PASSWORD` + `DB_WORKER_PASSWORD`) tạo / cập nhật. **Bẫy:** thuộc tính role (`LOGIN`, `BYPASSRLS`, `SUPERUSER`…) KHÔNG kế thừa qua membership — chỉ GRANT trên đối tượng kế thừa → `BYPASSRLS` đặt trên user đăng nhập của worker. Bảng chỉ-ghi-thêm mới phải `REVOKE UPDATE, DELETE` tường minh (default privileges cấp đủ DML). DB managed: role chạy migration có thể không có `CREATEROLE` / không đặt được `BYPASSRLS` (cần superuser) → tạo role bằng tài khoản quản trị của nhà cung cấp.

### RLS: ranh giới tổ chức (M11 B7, migration `0012_rls_org_isolation`)

Lớp phòng thủ THỨ HAI (lớp một: guard + `org_id` trong mọi query + composite FK). Bảng có RLS (`ENABLE` + `FORCE`): `channels`, `channel_members`, `meetings`, `meeting_shares`, `uploads` — policy `org_id = app_current_org_id()` cho cả `USING` (đọc / sửa / xoá) lẫn `WITH CHECK` (ghi). `app_current_org_id()` = `nullif(current_setting('app.org_id', true), '')::uuid`: chưa đặt / rỗng → NULL → không thấy dòng nào.

- `app.org_id` do pool của app (`OrgContextPool` trong `createPgPool`) đặt mỗi lần cho mượn connection, từ `OrgContext` (`AsyncLocalStorage`): middleware HTTP mở ngữ cảnh rỗng, `OrgMemberGuard` điền org sau khi xác nhận thành viên; realtime bọc `runInOrg`. Chỉ gửi `set_config` khi giá trị ĐỔI so với lần trước trên connection (~1 round-trip ≈ 150 µs mỗi lần đổi tổ chức; thời gian thực thi query không đổi đáng kể — đo ở plan M11).
- Policy chỉ giữ ranh giới tổ chức, KHÔNG chứa quy tắc xem meeting (04 §3 ở code).
- M6 (migration `0013`) thêm `transcript_segments`, `meeting_summaries` cùng mẫu (M6 Q8). M9 thêm `weekly_reports`, `weekly_report_versions` (`0015`); M12 thêm `action_items` (`0018`).
- Không RLS: bảng tài khoản (`users`, `sessions`…), `organizations` / `organization_members` (đăng nhập, "tổ chức của tôi" đọc xuyên tổ chức), `notifications` (theo người dùng), `invites` / `join_requests` (chấp nhận link mời chưa là thành viên), `audit_logs`, `idempotency_keys`.
- Superuser và role `BYPASSRLS` (worker) luôn được miễn — vì thế api không được chạy bằng superuser (B6). Kiểm tra FK / cascade (gỡ thành viên → xoá `channel_members`) là thao tác toàn vẹn tham chiếu, không bị RLS chặn.

### Extension & đối tượng tạo bằng SQL viết tay (migration `0000_extensions`)

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() là STABLE (phụ thuộc search_path) → không dùng được trong index/generated column.
-- Bọc lại thành IMMUTABLE, chỉ định rõ schema của dictionary.
CREATE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN public.unaccent('public.unaccent'::regdictionary, $1);

-- Text search config cho tiếng Việt: tách từ kiểu 'simple' + bỏ dấu.
CREATE TEXT SEARCH CONFIGURATION meetnote_vi (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION meetnote_vi
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
```

> **Bẫy:** Extension cần quyền superuser hoặc `CREATE` trên database. Local/Testcontainers không vấn đề gì, nhưng trên DB managed phải xem danh sách extension được phép.

## 1. Tài khoản

### `users`

| Cột                    | Kiểu                                                                                    | Ghi chú                         |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| id                     | uuid PK                                                                                 |                                 |
| email                  | text NOT NULL                                                                           | lưu nguyên dạng người dùng nhập |
| password_hash          | text NOT NULL                                                                           | argon2id                        |
| display_name           | text NOT NULL                                                                           |                                 |
| search_text            | text GENERATED ALWAYS AS (`f_unaccent(lower(display_name \|\| ' ' \|\| email))`) STORED | dùng để tìm không dấu           |
| created_at, updated_at | timestamptz                                                                             |                                 |

Index: `UNIQUE (lower(email))` tên `users_email_lower_uq` (service map lỗi 23505 của tên này sang 409 `AUTH_EMAIL_TAKEN`), `GIN (search_text gin_trgm_ops)` tên `users_search_text_trgm_idx`.
CHECK: `users_email_length_ck` (3–254 ký tự), `users_display_name_length_ck` (1–80). DTO đã validate, CHECK là lớp chặn cuối.

### `sessions` (một lần đăng nhập trên một thiết bị)

| Cột            | Kiểu                                                                             | Ghi chú                                                                  |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| id             | uuid PK                                                                          | = `sid` trong access JWT, **không đổi** suốt phiên                       |
| user_id        | uuid FK → users ON DELETE CASCADE                                                |                                                                          |
| user_agent     | text NULL                                                                        | hiển thị trong `/me/sessions`                                            |
| ip             | inet NULL                                                                        | kiểu `inet` để Postgres tự kiểm tra định dạng IPv4/IPv6                  |
| created_at     | timestamptz                                                                      |                                                                          |
| last_used_at   | timestamptz                                                                      | cập nhật mỗi lần refresh                                                 |
| revoked_at     | timestamptz NULL                                                                 | có giá trị = phiên đã bị thu hồi, access token của phiên này bị 401 ngay |
| revoked_reason | text NULL CHECK IN (`logout`, `logout_all`, `revoked_by_user`, `reuse_detected`) |                                                                          |

Index: `(user_id) WHERE revoked_at IS NULL`, tên `sessions_user_active_idx`.
CHECK: `sessions_revoked_reason_ck`; `sessions_revoked_consistency_ck` = `(revoked_at IS NULL) = (revoked_reason IS NULL)`.

### `refresh_tokens` (mỗi lần refresh một dòng)

| Cột            | Kiểu                                 | Ghi chú                                                                |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| id             | uuid PK                              |                                                                        |
| session_id     | uuid FK → sessions ON DELETE CASCADE |                                                                        |
| token_hash     | bytea NOT NULL                       | SHA-256 của token (32 byte ngẫu nhiên, base64url). Không lưu token gốc |
| expires_at     | timestamptz NOT NULL                 | trượt: `REFRESH_TOKEN_TTL_DAYS` kể từ lúc cấp                          |
| created_at     | timestamptz                          |                                                                        |
| rotated_at     | timestamptz NULL                     | có giá trị = đã được đổi lấy token mới                                 |
| replaced_by_id | uuid NULL FK → refresh_tokens        | token mới thay thế                                                     |

Index: `UNIQUE (token_hash)` tên `refresh_tokens_hash_uq`, `(session_id)`.
CHECK: `refresh_tokens_hash_length_ck` (`octet_length = 32`); `refresh_tokens_rotation_consistency_ck` = `(rotated_at IS NULL) = (replaced_by_id IS NULL)`. FK `replaced_by_id` → `ON DELETE SET NULL`.

Vì sao tách hai bảng: `sid` trong JWT phải ổn định để guard kiểm tra "phiên còn sống" bằng một query theo khoá chính, và để `/me/sessions` liệt kê thiết bị. Nếu gộp chung, mỗi lần refresh lại sinh `sid` mới.

**Refresh (1 transaction):**

1. `SELECT … FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, rồi `SELECT … FROM sessions WHERE id = … FOR UPDATE`.
2. Không có, hết hạn, hoặc phiên đã thu hồi → 401 `AUTH_REFRESH_TOKEN_INVALID`.
3. `rotated_at` đã có:
   - trong `REFRESH_REUSE_GRACE_SECONDS` (mặc định 10s, cho trường hợp hai tab refresh cùng lúc) → 401 `AUTH_REFRESH_TOKEN_ROTATED`, **không** thu hồi;
   - quá grace → coi là token bị đánh cắp: thu hồi phiên (`reuse_detected`), 401 `AUTH_REFRESH_TOKEN_REUSED`.
4. Hợp lệ: insert token mới, set `rotated_at` + `replaced_by_id` cho token cũ, cập nhật `sessions.last_used_at`.

Không có `FOR UPDATE` thì 2 request refresh song song cùng đọc thấy token "chưa xoay", và cả hai cùng nhận token mới. Kết quả là một phiên có 2 nhánh token.

## 2. Tổ chức

### `organizations`

id (uuidv7), name, created_by (FK → users, `ON DELETE SET NULL`), `require_join_approval boolean NOT NULL DEFAULT false` (M3), created_at, updated_at, deleted_at.
CHECK `organizations_name_length_ck` (1–100 ký tự). Tên **không** unique toàn hệ thống.

- Chưa có `slug` (M2 Q1): API dùng `:orgId`.
- PK đã unique nên đủ làm đích cho composite FK của bảng con.

### `organization_members`

| Cột       | Kiểu                                      | Ghi chú |
| --------- | ----------------------------------------- | ------- |
| org_id    | uuid FK → organizations ON DELETE CASCADE |         |
| user_id   | uuid FK → users ON DELETE CASCADE         |         |
| role      | text CHECK IN ('owner','admin','member')  |         |
| joined_at | timestamptz                               |         |
| PK        | (org_id, user_id)                         |         |

Index:

- `organization_members_one_owner_uq`: `UNIQUE (org_id) WHERE role = 'owner'`: **mỗi org tối đa 1 owner**, ép ở tầng DB.
- `organization_members_user_idx (user_id)`: "các org của tôi".
- `organization_members_org_joined_idx (org_id, joined_at, user_id)`: phân trang cursor.
- CHECK `organization_members_role_ck`.

**Đổi vai trò / gỡ thành viên (M2):** transaction, `SELECT … WHERE org_id = $1 AND user_id IN (actor, target) ORDER BY user_id FOR UPDATE`, kiểm tra lại vai trò của cả hai sau khi khoá, rồi mới `UPDATE`/`DELETE`.

> **Bẫy:** Partial unique index **không thể** `DEFERRABLE`. Khi chuyển quyền sở hữu phải **hạ owner cũ trước, rồi mới nâng owner mới**. Làm ngược thứ tự thì dính lỗi 23505.

### `organization_invites` (M3)

| Cột        | Kiểu                            | Ghi chú                                                                                       |
| ---------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| id         | uuid PK                         |                                                                                               |
| org_id     | uuid FK → organizations CASCADE |                                                                                               |
| token_hash | bytea NOT NULL                  | SHA-256 của token (32 byte ngẫu nhiên, base64url). **Token chỉ hiện một lần lúc tạo** (M3 Q1) |
| role       | text CHECK ∈ admin/member       | vai trò người vào sẽ nhận                                                                     |
| created_by | uuid NULL FK → users SET NULL   |                                                                                               |
| expires_at | timestamptz NOT NULL            |                                                                                               |
| max_uses   | int NULL                        | NULL = không giới hạn                                                                         |
| use_count  | int NOT NULL DEFAULT 0          |                                                                                               |
| revoked_at | timestamptz NULL                |                                                                                               |
| created_at | timestamptz                     |                                                                                               |

Ràng buộc:

- `organization_invites_token_hash_uq UNIQUE (token_hash)`.
- CHECK `max_uses IS NULL OR max_uses > 0`.
- CHECK `use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses)`.
- Index `(org_id, created_at DESC, id DESC)` cho danh sách mới nhất trước.

**Dùng link không cần khoá dòng.** Một câu UPDATE có điều kiện đã là nguyên tử:

```sql
UPDATE organization_invites SET use_count = use_count + 1
WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
  AND (max_uses IS NULL OR use_count < max_uses)
RETURNING *;
```

0 dòng trả về nghĩa là link hết hạn, hết lượt hoặc đã bị thu hồi. 100 người bấm cùng lúc với `max_uses = 10` thì đúng 10 người thành công. Lượt dùng bị trừ **trong cùng transaction** với việc thêm thành viên / tạo yêu cầu, nên nếu bước sau lỗi (vd đã là thành viên) thì lượt dùng cũng được hoàn lại.

### `organization_join_requests` (M3)

id, org_id (FK CASCADE), user_id (FK → users CASCADE), invite_id (FK → invites SET NULL), role (admin/member, copy từ link), status (`pending|approved|rejected`), decided_by (FK → users SET NULL), decided_at, created_at.

- `organization_join_requests_one_pending_uq UNIQUE (org_id, user_id) WHERE status = 'pending'`.
- CHECK `(status = 'pending') = (decided_at IS NULL)`.
- Index `(org_id, status, created_at DESC, id DESC)`.

**Duyệt:** `SELECT … FOR UPDATE` → kiểm tra `pending` → `INSERT organization_members … ON CONFLICT DO NOTHING` → cập nhật status → audit. Tất cả trong 1 transaction.

## 3. Kênh

### `channels`

| Cột                     | Kiểu                               | Ghi chú |
| ----------------------- | ---------------------------------- | ------- |
| id                      | uuid PK                            |         |
| org_id                  | uuid FK → organizations            |         |
| name                    | text                               |         |
| description             | text NULL                          |         |
| visibility              | text CHECK IN ('public','private') |         |
| weekly_report_enabled   | boolean DEFAULT true               |         |
| created_by              | uuid FK → users                    |         |
| archived_at, deleted_at | timestamptz NULL                   |         |
| created_at, updated_at  | timestamptz                        |         |

Index:

- `channels_id_org_uq UNIQUE (id, org_id)`: đích của composite FK.
- `channels_org_name_uq UNIQUE (org_id, lower(name)) WHERE deleted_at IS NULL`: vừa chặn trùng tên, vừa phục vụ danh sách sắp theo tên (keyset chỉ trên `lower(name)`, M4 Q4: index unique nên không cần `id` làm tie-breaker).
- `channels_purge_idx (deleted_at) WHERE deleted_at IS NOT NULL`: cho job dọn dẹp.
- CHECK `channels_visibility_ck`, `channels_name_length_ck` (1–80).

### `channel_members`

| Cột        | Kiểu                                             | Ghi chú                                                              |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| channel_id | uuid                                             | FK `(channel_id, org_id)` → `channels(id, org_id)` ON DELETE CASCADE |
| org_id     | uuid                                             |                                                                      |
| user_id    | uuid                                             | FK `(org_id, user_id)` → `organization_members` ON DELETE CASCADE    |
| role       | text CHECK IN ('owner','admin','member','guest') |                                                                      |
| joined_at  | timestamptz                                      |                                                                      |
| PK         | (channel_id, user_id)                            |                                                                      |

Index: `channel_members_one_owner_uq UNIQUE (channel_id) WHERE role = 'owner'`, `channel_members_user_idx (user_id)`, `channel_members_channel_joined_idx (channel_id, joined_at, user_id)`.

Composite FK tới `organization_members` cho 2 bảo đảm:

- Không thể thêm người ngoài org vào kênh.
- Bị xoá khỏi org thì tự rời mọi kênh (cascade).

> **Bẫy:** Cascade cũng xoá luôn **chủ kênh**. Quyết định M4 Q3: rời / bị gỡ khỏi org khi còn làm chủ kênh (chưa xoá) → **409 `ORG_MEMBER_OWNS_CHANNELS`**. Phải chuyển chủ kênh trước, giống Owner tổ chức. Kiểm tra này phải chịu được race "đang gỡ X ‖ chuyển kênh cho X" (xem thứ tự khoá §7).

**Danh sách thành viên + tìm không dấu:**

```sql
SELECT … FROM channel_members cm JOIN users u ON u.id = cm.user_id
WHERE cm.channel_id = $1
  AND ($q IS NULL OR u.search_text LIKE '%' || f_unaccent(lower($q)) || '%')
  AND (cm.joined_at, cm.user_id) > ($cursorJoinedAt, $cursorUserId)
ORDER BY cm.joined_at, cm.user_id
LIMIT $limit + 1;
```

Trigram index giúp `LIKE '%…%'`. Lấy `limit + 1` dòng để biết còn trang sau không.

**Khoá khi đổi quyền trong kênh** (đổi vai trò, gỡ thành viên, chuyển chủ kênh): luôn **khoá dòng `channels` trước** (`SELECT … FROM channels WHERE id = $1 FOR UPDATE`), rồi mới đọc/sửa `channel_members`. Dòng kênh là "mutex" cho mọi thay đổi quyền của kênh. Mọi thao tác khoá theo **cùng thứ tự** (kênh → thành viên sắp theo `user_id`) nên không deadlock.

## 4. Upload & cuộc họp

### `uploads`

id, org_id, user_id, filename, mime_type, size_bytes bigint, sha256 (hex, client gửi lúc init), chunk_size int, total_parts int, title, recorded_at (khai lúc init để `complete` tạo được meeting), object_key (`orgs/{orgId}/uploads/{uploadId}/source`, không chứa dữ liệu người dùng), s3_upload_id, status (`initiated|completed|aborted|expired`), meeting_id NULL, expires_at, storage_aborted_at NULL, created_at, completed_at.

- FK `user_id → users` (**không** trỏ thành viên org, M5 Q1): người tạo rời org thì cascade không xoá dòng trong khi S3 còn giữ các phần; job dọn dẹp abort khi hết hạn. FK `(meeting_id, org_id) → meetings(id, org_id)`.
- CHECK (M5): size 1 B – 2 GiB; sha256 `^[0-9a-f]{64}$`; chunk_size ≥ 5 MiB (S3); `total_parts = ceil(size / chunk)` và ≤ 10 000; mime trong danh sách cho phép; `status = 'completed'` ⇔ có `meeting_id` + `completed_at`.
- `storage_aborted_at`: huỷ / hết hạn đánh dấu status TRƯỚC (trong DB), gọi `AbortMultipartUpload` SAU (ngoài transaction). S3 lỗi → cột này NULL → lần dọn sau thử lại.
- Index: `uploads_expiry_idx (expires_at) WHERE status = 'initiated'` (job dọn dẹp), `uploads_abort_retry_idx (id) WHERE status IN ('aborted','expired') AND storage_aborted_at IS NULL`.
- **Dọn dẹp (M5 B7, `UploadsCleanupService`; worker chạy mỗi 10 phút từ M6 B8):**
  - `expireBatch`: transaction ngắn, một câu `UPDATE uploads SET status = 'expired' WHERE id IN (SELECT … WHERE status = 'initiated' AND expires_at <= now() - 10 phút ORDER BY expires_at LIMIT n FOR UPDATE SKIP LOCKED) RETURNING …` + `lock_timeout`; commit xong mới abort từng multipart. **Ân hạn 10 phút** > `requestTimeout` 5 phút của Node: không còn PUT phần nào đang gửi lúc abort (S3 có thể vẫn lưu phần đang gửi dở sau abort).
  - `retryStorageAbortBatch`: lấy upload `aborted` / `expired` còn `storage_aborted_at IS NULL`, **không khoá** (abort + đánh dấu đều idempotent, hai worker trùng việc chỉ tốn một lời gọi S3). Mỗi lần chạy job một lô, không lặp tới rỗng (S3 sập thì lặp mãi).

> **M6 B4:** `uploads_meeting_uq (meeting_id) WHERE meeting_id IS NOT NULL` — index phía tham chiếu của `uploads_meeting_fk` (thiếu từ M5) + bất biến mỗi meeting từ đúng một upload; pipeline tra `sha256` theo meeting.

### `upload_parts`

upload_id FK ON DELETE CASCADE, part_number int (CHECK 1–10 000), size_bytes int, etag text, created_at. PK `(upload_id, part_number)`. Không mang `org_id`: chỉ có một bảng cha nên không có đường ghép chéo tổ chức (composite FK theo org chỉ cần khi dòng tham chiếu từ hai phía, như `channel_members`).
PUT part là **idempotent**: `INSERT … ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = EXCLUDED.etag`.

**Complete:** `SELECT uploads … FOR UPDATE`. Nếu status đã là `completed` thì trả lại meeting đã tạo (idempotent). Nếu chưa:

1. Kiểm tra đủ part.
2. Gọi S3 `CompleteMultipartUpload`.
3. Tạo `meetings`, set `status = completed`.
4. Commit, rồi mới enqueue job với `jobId = meeting.preprocess.{meetingId}.a{attempt}`.

### `meetings`

| Cột                                 | Kiểu                                                                                       | Ghi chú                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                  | uuid PK                                                                                    |                                                                                                                                                                                                                                                                                                     |
| org_id                              | uuid                                                                                       | `UNIQUE (id, org_id)`                                                                                                                                                                                                                                                                               |
| owner_id                            | uuid NULL                                                                                  | FK `meetings_owner_fk (org_id, owner_id)` → organization_members **ON DELETE SET NULL (owner_id)** (M5 Q1, PG 15+, migration viết tay `0007`): chủ rời org thì meeting ở lại, `org_id` giữ nguyên. `SET NULL` thường sẽ null cả `org_id` → 23502                                                    |
| title                               | text                                                                                       |                                                                                                                                                                                                                                                                                                     |
| recorded_at                         | timestamptz NOT NULL                                                                       | thời điểm họp, dùng cho báo cáo tuần                                                                                                                                                                                                                                                                |
| duration_ms                         | int NULL                                                                                   | điền sau khi ffprobe                                                                                                                                                                                                                                                                                |
| language                            | text NULL                                                                                  | Whisper phát hiện                                                                                                                                                                                                                                                                                   |
| status                              | text CHECK IN ('queued','preprocessing','transcribing','summarizing','completed','failed') |                                                                                                                                                                                                                                                                                                     |
| failure_code, failure_message       | text NULL                                                                                  | M6: CHECK `meetings_failure_code_ck` — `SOURCE_CHECKSUM_MISMATCH`, `MEDIA_UNREADABLE`, `MEDIA_NO_AUDIO`, `MEDIA_TOO_LONG`, `TRANSCRIBE_FAILED`, `SUMMARIZE_FAILED`, `PREPROCESS_FAILED` (B4: preprocess hết lượt vì lỗi tạm); `failure_message` là câu ngắn cho người dùng (stderr thô chỉ vào log) |
| attempt                             | int DEFAULT 1                                                                              | lần chạy pipeline, đếm từ 1 cho khớp `jobId …a1`; CHECK ≥ 1                                                                                                                                                                                                                                         |
| source_object_key, audio_object_key | text                                                                                       |                                                                                                                                                                                                                                                                                                     |
| stage_token, stage_lease_until      | uuid NULL, timestamptz NULL                                                                | LEASE của bước pipeline đang chạy (M6 B4, migration `0014`): nhận việc = token mới + hạn; ghi kết quả chỉ khi token còn là của mình (06 §1.2)                                                                                                                                                       |
| created_at, updated_at, deleted_at  | timestamptz                                                                                |                                                                                                                                                                                                                                                                                                     |

Index: `meetings_org_owner_created_idx (org_id, owner_id, created_at DESC NULLS FIRST, id DESC NULLS FIRST)` — **không partial**, vì còn phục vụ khoá ngoại `meetings_owner_fk` (xoá một thành viên phải tìm mọi meeting của họ, kể cả đã xoá mềm; Postgres không tự tạo index cho phía tham chiếu); `meetings_org_recorded_idx (org_id, recorded_at)` (báo cáo tuần; luồng "một lượt" của danh sách meeting). M6 thêm `meetings_stuck_idx (updated_at) WHERE status IN ('queued','preprocessing','transcribing','summarizing') AND deleted_at IS NULL` — quét meeting kẹt, cũ nhất trước theo lô. M11 B5 thêm cho danh sách meeting: `meetings_org_owner_recorded_idx (org_id, owner_id, recorded_at DESC NULLS FIRST, id DESC NULLS FIRST) WHERE deleted_at IS NULL` (luồng "của mình"), `meetings_org_ownerless_recorded_idx (org_id, recorded_at DESC NULLS FIRST, id DESC NULLS FIRST) WHERE owner_id IS NULL AND deleted_at IS NULL` (luồng "không chủ" của OrgAdm).

**Chuyển trạng thái = UPDATE có điều kiện** (optimistic, không giữ khoá lâu):

```sql
UPDATE meetings SET status = 'transcribing', updated_at = now()
WHERE id = $1 AND status = 'preprocessing' RETURNING id;
```

0 dòng nghĩa là job này đã cũ hoặc bị chạy trùng: bỏ qua, không lỗi. **Không giữ transaction trong lúc chạy Whisper** (có thể vài chục phút).

### `meeting_shares`

meeting_id, channel_id, org_id, shared_by NULL (FK `users` ON DELETE SET NULL), shared_at, **recorded_at** (M11 B5, migration `0010`: BẢN CHÉP `meetings.recorded_at` — ghi khi share từ dòng meeting đã khoá, `MeetingsRepository.update` cập nhật cùng transaction khi sửa `recordedAt`; migration thêm cột NULL → backfill → `SET NOT NULL`). PK `meeting_shares_pk (meeting_id, channel_id)` (M6b, migration `0008`).
Có 2 composite FK, cả hai **ON DELETE CASCADE**:

- `meeting_shares_meeting_fk (meeting_id, org_id)` → `meetings(id, org_id)`
- `meeting_shares_channel_fk (channel_id, org_id)` → `channels(id, org_id)`

Như vậy không thể share chéo org. Purge kênh (xoá cứng) tự gỡ share, meeting còn nguyên (D3). Chủ meeting rời org: `owner_id` NULL, share giữ nguyên.
Index: `meeting_shares_channel_shared_idx (channel_id, shared_at DESC, meeting_id DESC)` — danh sách meeting theo kênh, cũng là index phía tham chiếu của FK kênh; `meeting_shares_channel_recorded_idx (channel_id, recorded_at DESC NULLS FIRST, meeting_id DESC NULLS FIRST)` — luồng "theo từng kênh" của danh sách meeting theo org (M11 B5). Phía meeting đã có PK bắt đầu bằng `meeting_id`.

### `transcript_segments`

| Cột                  | Kiểu                                                                     | Ghi chú                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| id                   | bigint identity PK                                                       |                                                                                                                                               |
| meeting_id, org_id   | uuid                                                                     | composite FK `transcript_segments_meeting_fk` → `meetings(id, org_id)` ON DELETE CASCADE; **RLS** theo `org_id` (M6 Q8)                       |
| seq                  | int                                                                      | `UNIQUE (meeting_id, seq)`                                                                                                                    |
| start_ms, end_ms     | int                                                                      | `CHECK (end_ms >= start_ms)`                                                                                                                  |
| speaker              | text NULL                                                                | để dành                                                                                                                                       |
| text                 | text                                                                     |                                                                                                                                               |
| version              | int NOT NULL DEFAULT 1                                                   | khoá LẠC QUAN cho sửa tay (M13): mỗi lần sửa +1; `CHECK (version >= 1)`; `version > 1` ⇔ đã sửa                                               |
| edited_at, edited_by | timestamptz NULL, uuid NULL                                              | lần sửa tay gần nhất; FK `transcript_segments_edited_by_fk` → `users` ON DELETE SET NULL + index một phần `transcript_segments_edited_by_idx` |
| search               | tsvector GENERATED ALWAYS AS (`to_tsvector('meetnote_vi', text)`) STORED | `GIN (search)`                                                                                                                                |

Id `bigint identity`, `seq ≥ 0`, `transcript_segments_meeting_seq_uq` cũng là index phía tham chiếu của FK (migration `0013`). Ghi transcript = **xoá rồi chèn lại** trong 1 transaction. Job chạy lại vẫn ra cùng kết quả (idempotent).
Sửa tay (M13): `UPDATE … SET text, version = version + 1 WHERE meeting_id AND seq AND version = $n` — một câu nguyên tử, 0 dòng thì đọc lại để phân biệt "đoạn không còn" với "version lệch". `CHECK (char_length(text) >= 1)` (`transcript_segments_text_ck`); cận trên 5000 ký tự là luật của DTO, không đặt ở DB để không chặn đầu ra Whisper. Cột `search` là generated nên tự theo `text`. **Invariant:** `replaceSegments` (ghi transcript của pipeline) từ chối nếu meeting đã có đoạn `version > 1` — hôm nay không đường nào chạm tới, nhưng một tính năng "tạo lại transcript" sau này sẽ không lặng lẽ xoá công người sửa.
Search: `search @@ websearch_to_tsquery('meetnote_vi', $q)`, highlight bằng `ts_headline`. Quyền xem: điều kiện `meetingVisibleTo` nằm TRONG câu truy vấn, trước `LIMIT` (M8). Hình dạng "meeting trước" — đi meeting mới → cũ, `EXISTS` đoạn khớp — thắng hình dạng "đoạn trước" 30× với từ khoá phổ biến (đo trên 600k đoạn, plan M8 bài học 1).

> **Bẫy:** `to_tsvector` trong generated column phải nhận tên config dạng hằng (`'meetnote_vi'::regconfig`). Hàm 2 tham số với hằng là immutable. Hàm 1 tham số thì không.

### `meeting_summaries`

meeting_id PK, org_id (composite FK `meeting_summaries_meeting_fk` → `meetings(id, org_id)` ON DELETE CASCADE, **RLS** theo `org_id`), content jsonb (`{ overview, keyPoints[], decisions[], actionItems[{ owner, task, due }] }`), model, prompt_version, input_tokens, output_tokens (CHECK ≥ 0), created_at. Upsert theo `meeting_id` (M6, migration `0013`).

### `action_items` (M12)

Việc cần làm của một meeting. Dữ liệu **hai nguồn**: máy (`origin = 'ai'`, trích từ tóm tắt) và người (`manual`, hoặc việc AI đã bị sửa).

| Cột                    | Kiểu                 | Ghi chú                                                                                                                          |
| ---------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| id                     | uuid PK uuidv7       | tăng theo thời gian: `ORDER BY id` = thứ tự tạo                                                                                  |
| org_id, meeting_id     | uuid                 | composite FK `action_items_meeting_fk` → `meetings(id, org_id)` ON DELETE CASCADE; **RLS** theo `org_id` (`0018`)                |
| origin                 | text                 | `ai` \| `manual` (CHECK)                                                                                                         |
| source_index           | int NULL             | vị trí trong `actionItems` của tóm tắt. `action_items_source_ck`: `ai` ⇒ không NULL và ≥ 0; `manual` ⇒ NULL                      |
| task                   | text                 | 1–500 ký tự                                                                                                                      |
| owner_name             | text NULL            | tên người phụ trách model nêu, giữ chữ gốc (1–200)                                                                               |
| assignee_id            | uuid NULL            | FK `action_items_assignee_fk` `(org_id, assignee_id)` → `organization_members` **`ON DELETE SET NULL (assignee_id)`** (viết tay) |
| due_text, due_date     | text NULL, date NULL | chữ hạn model nêu ("thứ sáu", 1–200) và ngày đã quy; sửa `due_date` tay thì xoá `due_text`                                       |
| status                 | text                 | `open` \| `done` \| `dismissed`; CHECK `(status = 'done') = (completed_at IS NOT NULL)`                                          |
| completed_at/by        | timestamptz, uuid    | `completed_by` FK `users` SET NULL                                                                                               |
| version                | int DEFAULT 1        | khoá lạc quan (`If-Match`), `CHECK >= 1`                                                                                         |
| created_by             | uuid NULL            | người tạo việc thủ công, FK `users` SET NULL                                                                                     |
| created_at, updated_at | timestamptz          |                                                                                                                                  |

Index: `action_items_ai_source_uq` UNIQUE `(meeting_id, source_index) WHERE origin = 'ai'` — **khoá idempotency** của pipeline: chèn bằng `ON CONFLICT (meeting_id, source_index) WHERE origin = 'ai' DO NOTHING` (phải nêu lại `WHERE` để Postgres suy ra index đích). Pipeline **chỉ chèn**, không UPDATE / DELETE → chạy lại không sinh trùng và không đè việc đã sửa. Không có xoá: bỏ việc = `dismissed` (xoá hẳn việc AI thì lần chạy lại chèn lại nó). `action_items_meeting_idx (meeting_id, id)` — danh sách theo meeting. `action_items_org_assignee_due_idx (org_id, assignee_id, status, due_date ASC NULLS LAST, id)` — "việc của tôi"; **cố ý không partial**: cũng là index phía tham chiếu cho FK assignee (gỡ thành viên phải tìm mọi việc, mọi trạng thái của người đó — cùng bẫy với `meetings_org_owner_*`). Hai index một phần cho `completed_by`, `created_by`.

> **Bẫy CHECK + NULL:** `source_index >= 0` với NULL cho NULL, mà CHECK coi NULL là _thoả_ — nên `ai` ⇒ `source_index IS NOT NULL AND source_index >= 0` phải viết tường minh (lần đầu thiếu `IS NOT NULL`, test schema bắt được).

Meeting `completed` trước M12 **không** có việc (không backfill).

## 5. Báo cáo tuần

### `weekly_reports`

| Cột                    | Kiểu                                                                  | Ghi chú                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | uuid PK                                                               | `uuidv7()`; `UNIQUE (id, org_id)` là đích của composite FK từ bảng versions                                                             |
| channel_id, org_id     | uuid                                                                  | composite FK `weekly_reports_channel_fk` → `channels(id, org_id)` ON DELETE CASCADE; **RLS** theo `org_id` (M9 Q9)                      |
| week_start             | date                                                                  | Thứ Hai theo giờ VN; CHECK `extract(isodow …) = 1`. Đọc về dạng chuỗi `'YYYY-MM-DD'`, không qua `Date`                                  |
| status                 | text CHECK IN ('pending','generating','completed','failed','skipped') | `skipped` = < 2 meeting. Là CHẶNG hiện tại, như `meetings.status`                                                                       |
| regenerate_count       | smallint DEFAULT 0 CHECK BETWEEN 0 AND 3                              | DB là chốt chặn cuối của quota                                                                                                          |
| current_version        | int NULL CHECK ≥ 1                                                    | Phiên bản đang hiển thị. Tạo lại LỖI không đổi cột này. CHECK: `completed` ⇒ có `current_version`                                       |
| last_error             | text NULL                                                             |                                                                                                                                         |
| requested_trigger      | text DEFAULT 'scheduled' CHECK IN ('scheduled','manual')              | Lần tạo hiện tại do tick hay do người bấm (M9 B4). Lưu trên dòng — không nhét vào payload job — để job quét kẹt dựng lại đúng thông tin |
| requested_by           | uuid NULL                                                             | Người bấm "tạo lại" (FK `weekly_reports_requested_by_fk` → `users` ON DELETE SET NULL). Version mới chép sang `triggered_by`            |
| generation_token       | uuid NULL                                                             | **Fencing token** của lần nhận việc hiện tại (M9 Q4). Chỉ ghi kết quả khi token còn là của mình                                         |
| lease_until            | timestamptz NULL                                                      | Lease: worker khác chỉ nhận việc khi NULL hoặc đã hết hạn                                                                               |
| created_at, updated_at | timestamptz                                                           |                                                                                                                                         |

`UNIQUE (channel_id, week_start)` (`weekly_reports_channel_week_uq`) là **khoá idempotency** của cron:

```sql
INSERT INTO weekly_reports (…) VALUES (…)
ON CONFLICT (channel_id, week_start) DO NOTHING RETURNING id;
```

Cron chạy 2 lần (do retry hoặc nhiều instance) thì lần 2 không làm gì. Index: `weekly_reports_week_status_idx (week_start, status)` cho tick; `weekly_reports_stuck_idx (updated_at) WHERE status IN ('pending','generating')` cho quét kẹt.

> **Vì sao có lease thay vì `UPDATE … WHERE status IN ('pending','failed')`** (bản thiết kế đầu): retry của BullMQ thấy `generating` do chính lần thử trước để lại → điều kiện không khớp → bỏ qua → báo cáo kẹt mãi. Cùng bài học 9 của M6.

### `weekly_report_versions`

id, report_id + org_id (composite FK `weekly_report_versions_report_fk` → `weekly_reports(id, org_id)` ON DELETE CASCADE; **RLS** theo `org_id`), version int (CHECK ≥ 1), trigger (`scheduled|manual`, CHECK), triggered_by NULL (FK `weekly_report_versions_triggered_by_fk` → `users` ON DELETE SET NULL), content jsonb, meeting_ids uuid[] (chụp danh sách meeting lúc sinh), truncated boolean (đã cắt bớt meeting khi đưa vào prompt), model, prompt_version, input_tokens, output_tokens (CHECK ≥ 0), created_at. `UNIQUE (report_id, version)`. Chỉ THÊM, không sửa. Migration `0015` (hai bảng) + `0016` (`requested_trigger`, `requested_by`).

**Tạo lại (manual):**

1. `SELECT weekly_reports … FOR UPDATE`.
2. Kiểm tra `status <> 'generating'` và `regenerate_count < 3`.
3. `regenerate_count += 1`, `status = 'pending'` (người xem vẫn thấy `current_version` cũ).
4. Commit, rồi enqueue với `jobId = weekly-report.generate.{id}.v{n}`.

Nếu không có `FOR UPDATE`, 2 cú bấm cùng lúc đều đọc được `count = 2` và cùng tăng. CHECK constraint sẽ bắt được trường hợp này, nhưng người dùng nhận lỗi 500 thay vì 409.

## 6. Thông báo & audit

### `notifications`

id, user_id (FK `users` ON DELETE CASCADE), org_id NULL, type text (CHECK `notifications_type_ck`: `channel.member_added`, `channel.ownership_transferred`, `org.join_request_approved`, `meeting.shared`, `meeting.completed`, `meeting.failed`, `report.ready` (M6, migration `0013`) — M9 thêm loại bằng migration), payload jsonb (id + tên lúc tạo, M10 Q4), dedupe_key text NULL, read_at, deleted_at, created_at. Migration `0009` (M10).

- **FK `notifications_org_member_fk (org_id, user_id)` → `organization_members` ON DELETE CASCADE** (M10 Q3): rời / bị gỡ khỏi tổ chức → thông báo của tổ chức đó bị xoá theo, thay vì JOIN membership ở mọi truy vấn đọc. `org_id` NULL → FK không áp (MATCH SIMPLE).

Index:

- `notifications_user_dedupe_uq UNIQUE (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL`: thao tác / job tạo thông báo chạy lại không sinh bản trùng.
- `notifications_user_created_idx (user_id, created_at DESC, id DESC)` — **không partial**: cũng là index phía tham chiếu của FK `user_id` (partial thì FK không dùng được, M5 bài học 2). Lọc `deleted_at IS NULL` lúc đọc.
- `notifications_user_unread_idx (user_id) WHERE read_at IS NULL AND deleted_at IS NULL`: đếm số chưa đọc.
- `notifications_org_user_idx (org_id, user_id)`: phía tham chiếu của FK tổ chức.

### `audit_logs` (M3)

id bigint identity, org_id, actor_id NULL (NULL = hệ thống), action text (vd `org.member.role_changed`), target_type, target_id, metadata jsonb (`{ before, after }`), request_id, ip inet, created_at.

- Index `(org_id, created_at DESC, id DESC)`.
- **Không FK** tới organizations/users: log phải sống lâu hơn bản ghi mà nó mô tả.
- Ghi **trong cùng transaction** với thao tác. Thao tác rollback thì log cũng rollback, không có log "ma".
- **Chỉ ghi thêm**, ép bằng trigger `audit_logs_append_only` (chặn `UPDATE`/`DELETE`/`TRUNCATE`). `REVOKE` không đủ, vì user ứng dụng là chủ của bảng.

### `idempotency_keys` (M5)

user_id, key, method, path, request_hash (sha256 hex của method + path + body JSON chuẩn hoá), status (`processing|completed`), response_status, response_body jsonb, created_at, expires_at. PK `(user_id, key)`, CHECK `completed` ⇔ có `response_status`, index `idempotency_keys_expiry_idx (expires_at)` để dọn.
Dùng cho các POST không tự idempotent, theo header `Idempotency-Key` (`@Idempotent()`, M5 B6).

- **Giữ chỗ bằng MỘT câu lệnh:** `INSERT … ON CONFLICT (user_id, key) DO UPDATE … WHERE <được chiếm> RETURNING created_at::text`. Có dòng trả về = mình được chạy handler. "SELECT trước rồi INSERT" để hở khe: 20 request song song → handler chạy 20 lần (đột biến đã chứng minh).
- **Được chiếm dòng cũ khi:** `expires_at <= now()` (hết 24 giờ, như key mới) **hoặc** `processing` quá **lease 60 giây** và cùng `request_hash` (request đầu đã chết giữa chừng). Không có lease → crash giữa chừng làm key kẹt 409 suốt 24 giờ.
- **`created_at` = lúc giữ chỗ gần nhất, dùng làm fencing token:** lưu response / xoá chỗ giữ đều có `WHERE status = 'processing' AND created_at = <token>`. Request cũ "sống dậy" sau khi bị chiếm chỗ không ghi đè được. Token đi dạng text (đủ micro giây), không qua JS `Date`.
- Handler lỗi → **xoá** chỗ giữ (lỗi không được ghi nhớ, client sửa rồi gửi lại cùng key). Lưu `data` thô (trước envelope); trả lại thì bọc với `requestId` mới.
- Dọn dòng hết hạn: `IdempotencyRepository.deleteExpiredBatch` theo lô (`SKIP LOCKED`), worker chạy mỗi 10 phút (job `idempotency.cleanup`, M6 B8).

## 7. Thứ tự khoá chung (M4) và tóm tắt chỗ cần transaction / khoá

> **Timeout cho mọi connection (M11 B1)** — đặt trong `createPgPool`, gửi lúc mở connection: `lock_timeout` 3 s (lỗi `55P03` → HTTP 503), `statement_timeout` 15 s (worker 60 s; `57014` → 503), `idle_in_transaction_session_timeout` 30 s (Postgres cắt session, nhả khoá). `lock_timeout` < idle timeout là BẮT BUỘC: khi lệnh của connection B chờ khoá do transaction A giữ, A cũng đang "idle in transaction" — idle timeout ngắn hơn thì Postgres giết A thay vì cho B lỗi. Job purge vẫn đặt `lock_timeout` riêng bằng `set_config` (ngắn hơn). Migration dùng connection riêng, không bị giới hạn. Pool cũng tắt JIT (`-c jit=off`, M11 B5): app OLTP, ước lượng chi phí phồng làm Postgres compile JIT ~17 ms cho câu chỉ đọc vài buffer.

**Mọi thao tác khoá nhiều loại dòng phải theo đúng thứ tự sau** (khoá ngược thứ tự → hai transaction có thể chờ nhau vòng tròn → Postgres giết một bên với `40P01`):

0. `organizations` (dòng cha của mọi thứ; hiện chỉ xoá tổ chức và sửa tổ chức khoá dòng này)
1. `organization_members`, sắp theo `user_id` (`FOR UPDATE` khi đổi/xoá, `FOR SHARE` khi chỉ cần "vai trò này giữ nguyên")
2. `channels`, sắp theo `id` (dòng kênh là mutex cho mọi thay đổi quyền trong kênh)
3. `channel_members`, sắp theo `user_id`
4. `meetings` (M6b). Đứng SAU `organization_members` vì gỡ thành viên khỏi org (khoá bậc 1) cập nhật `meetings.owner_id` qua `ON DELETE SET NULL`. Share meeting: kênh `FOR SHARE` (bậc 2) → dòng `channel_members` của người share `FOR SHARE` (bậc 3) → meeting `FOR SHARE` (bậc 4)

Ví dụ:

- **Chuyển chủ kênh (CO hoặc OrgAdm):** khoá `FOR SHARE` dòng tổ chức của người gọi và người nhận (bậc 1) → kênh (bậc 2) → dòng chủ hiện tại + người nhận (bậc 3). Đảo bậc 1 xuống cuối thì "gỡ X khỏi org ‖ chuyển cho X" chờ nhau vòng tròn → `40P01` (đã chứng minh bằng đột biến, M4 B5).
- **Tham gia kênh:** khoá `FOR SHARE` dòng tổ chức của mình (bậc 1) → kênh (bậc 2) → `INSERT … ON CONFLICT DO NOTHING`.
- **Rời kênh:** kênh (bậc 2) → dòng của mình (bậc 3), kiểm tra không phải chủ trên dòng VỪA KHOÁ.
- **Lưu trữ / bỏ lưu trữ / xoá kênh:** khoá `FOR SHARE` dòng tổ chức của người gọi (bậc 1, vì quyền override của OrgAdm dựa trên nó) → kênh (bậc 2).
- **Dọn kênh đã xoá mềm (`purgeBatch`):** một câu `DELETE … WHERE id IN (SELECT … ORDER BY deleted_at LIMIT n FOR UPDATE SKIP LOCKED)`, chỉ chạm bậc 2 (cascade xoá `channel_members`). `lock_timeout` đặt bằng `set_config('lock_timeout', $1, true)`, vì `SET LOCAL … = $1` không nhận tham số bind (lỗi 42601).
- **Gỡ X khỏi org / X tự rời:** khoá `FOR UPDATE` dòng tổ chức của người gỡ và X (bậc 1) → kiểm tra X không làm chủ kênh nào (chưa xoá mềm) → xoá. Chuyển chủ kênh cho X khoá `FOR SHARE` chính dòng đó, nên hai việc chạy tuần tự: chuyển trước → gỡ nhận 409; gỡ trước → chuyển nhận 404.
- **Xoá tổ chức:** `organizations` `FOR UPDATE` (bậc 0) → dòng tổ chức của người gọi `FOR SHARE` (bậc 1), kiểm tra lại vẫn là Owner → `deleted_at = now()`.
- **Thêm X vào kênh:** khoá `FOR SHARE` dòng tổ chức của X (bậc 1) → kênh (bậc 2) → `INSERT … ON CONFLICT DO NOTHING`.
- **Đổi vai trò / gỡ X khỏi kênh:** kênh (bậc 2) → dòng `channel_members` của X (bậc 3). Vẫn phải khoá bậc 3 dù kênh đã là mutex: gỡ X khỏi **tổ chức** xoá dòng này qua cascade mà không đi qua dòng kênh.

Hai thao tác chạm cùng người X luôn tuần tự, không deadlock.

### Tóm tắt

| Thao tác                           | Kỹ thuật                                                                                                                       | Lý do                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Refresh token                      | tx + `FOR UPDATE` refresh_token rồi session                                                                                    | Chặn 2 refresh song song, phát hiện reuse                                                   |
| Chuyển quyền sở hữu org            | tx + `FOR UPDATE` 2 dòng member (sắp theo user_id) + hạ trước nâng sau                                                         | Partial unique index, chống deadlock                                                        |
| Đổi vai trò / gỡ thành viên org    | tx + `FOR UPDATE` dòng member mục tiêu + kiểm tra không gỡ owner                                                               | Owner không bị gỡ nhầm                                                                      |
| Rời / bị gỡ khỏi org               | tx + `FOR UPDATE` member → còn làm chủ kênh thì 409 → xoá member                                                               | Cascade không để lại kênh mồ côi (M4 Q3)                                                    |
| Dùng link mời                      | UPDATE có điều kiện                                                                                                            | Nguyên tử, không cần khoá                                                                   |
| Duyệt yêu cầu vào org              | tx + `FOR UPDATE` request                                                                                                      | Chặn duyệt 2 lần                                                                            |
| Thêm thành viên kênh               | tx + `FOR SHARE` org member của X → `FOR UPDATE` kênh → ON CONFLICT                                                            | X không bị gỡ khỏi org giữa chừng; 404 rõ                                                   |
| Đổi vai trò / gỡ / chuyển chủ kênh | tx + `FOR UPDATE` dòng `channels` trước, rồi dòng `channel_members`                                                            | Một mutex cho mỗi kênh, thứ tự khoá cố định                                                 |
| Complete upload                    | tx + `FOR UPDATE` upload, gọi S3 Complete **trong** khoá (timeout 30 s, M5 Q2); enqueue sau commit                             | Idempotent, chặn tạo 2 meeting; S3 xong mà DB lỗi → gọi lại tự gỡ bằng `HEAD`               |
| Share / gỡ share meeting           | tx: kênh `FOR SHARE` → dòng thành viên của người gọi `FOR SHARE` → meeting `FOR SHARE`, kiểm tra lại, `ON CONFLICT DO NOTHING` | Share song song không chặn nhau; chặn lưu trữ, gỡ quyền, gỡ khỏi org (cascade), xoá meeting |
| Giữ chỗ `Idempotency-Key`          | `INSERT … ON CONFLICT DO UPDATE … WHERE` (hết hạn / quá lease) + fencing token `created_at`                                    | Một câu nguyên tử, không khoá tường minh; crash giữa chừng không kẹt key                    |
| Chuyển trạng thái meeting          | UPDATE … WHERE status = expected                                                                                               | Optimistic, không giữ khoá trong lúc chạy lâu                                               |
| Ghi transcript                     | tx delete + insert                                                                                                             | Idempotent khi chạy lại                                                                     |
| Cron báo cáo                       | INSERT … ON CONFLICT DO NOTHING                                                                                                | Idempotent theo (kênh, tuần)                                                                |
| Tạo lại báo cáo                    | tx + `FOR UPDATE` report                                                                                                       | Quota 3 lần chính xác                                                                       |
| Job purge / dọn upload             | `FOR UPDATE SKIP LOCKED` theo lô + `lock_timeout` (`set_config`); dọn upload: abort S3 **sau** commit                          | Nhiều worker chạy song song không giẫm nhau; không giữ khoá lúc gọi S3                      |
| Dọn `idempotency_keys` hết hạn     | `DELETE … WHERE (user_id, key) IN (SELECT … FOR UPDATE SKIP LOCKED)` theo lô                                                   | `claim` cùng key chờ rồi INSERT như mới, không lỗi trùng khoá                               |
| Lưu trữ / xoá kênh                 | tx + `FOR SHARE` org member người gọi → `FOR UPDATE` kênh                                                                      | Quyền override của OrgAdm giữ nguyên tới commit                                             |
| Audit log                          | INSERT trong tx của thao tác                                                                                                   | Nhất quán                                                                                   |
