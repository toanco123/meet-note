# 03 — Thiết kế database (PostgreSQL 18)

## 0. Quy ước chung

- Tên bảng `snake_case` số nhiều, cột `snake_case`. Drizzle cấu hình `casing: 'snake_case'` nên TS dùng camelCase.
- PK `uuid DEFAULT uuidv7()`. Bảng log lớn (`audit_logs`, `transcript_segments`) dùng `bigint GENERATED ALWAYS AS IDENTITY`.
- Mọi thời gian dùng `timestamptz`. Riêng `week_start` dùng `date`, vì đó là ngày theo lịch VN chứ không phải thời điểm.
- Enum dùng `text` + `CHECK (col IN (...))` thay vì `CREATE TYPE ... AS ENUM`. Thêm giá trị không cần migration đặc biệt, và bỏ một giá trị cũng dễ.
- **Tenant consistency bằng composite FK:** bảng con mang theo `org_id` và FK `(x_id, org_id)` trỏ tới `UNIQUE (id, org_id)` của bảng cha. Như vậy DB **không cho phép** share meeting của org A vào kênh của org B, kể cả khi code có bug.
- Xoá mềm bằng `deleted_at`. Unique index kèm `WHERE deleted_at IS NULL` để tên đã xoá dùng lại được.

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

id, name, slug (`UNIQUE`), `require_join_approval boolean DEFAULT false`, created_at, updated_at, deleted_at.
Thêm `UNIQUE (id)` là đủ cho composite FK: PK đã unique, và bảng con trỏ `(org_id)`.

### `organization_members`

| Cột       | Kiểu                                      | Ghi chú |
| --------- | ----------------------------------------- | ------- |
| org_id    | uuid FK → organizations ON DELETE CASCADE |         |
| user_id   | uuid FK → users ON DELETE CASCADE         |         |
| role      | text CHECK IN ('owner','admin','member')  |         |
| joined_at | timestamptz                               |         |
| PK        | (org_id, user_id)                         |         |

Index:

- `UNIQUE (org_id) WHERE role = 'owner'`: **mỗi org tối đa 1 owner**, ép ở tầng DB.
- `(user_id)`: "các org của tôi".
- `(org_id, joined_at, user_id)`: phân trang cursor.

> **Bẫy:** Partial unique index **không thể** `DEFERRABLE`. Khi chuyển quyền sở hữu phải **hạ owner cũ trước, rồi mới nâng owner mới**. Làm ngược thứ tự thì dính lỗi 23505.

### `organization_invites`

id, org_id, token_hash (bytea UNIQUE), role (`'admin'|'member'`, mặc định member), created_by, expires_at, max_uses (NULL = không giới hạn), use_count int DEFAULT 0, revoked_at, created_at.
`CHECK (max_uses IS NULL OR use_count <= max_uses)`.

**Không cần khoá dòng.** Một câu UPDATE có điều kiện đã là nguyên tử:

```sql
UPDATE organization_invites SET use_count = use_count + 1
WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
  AND (max_uses IS NULL OR use_count < max_uses)
RETURNING *;
```

0 dòng trả về nghĩa là link hết hạn, hết lượt hoặc đã bị thu hồi. 100 người bấm cùng lúc với `max_uses = 10` thì đúng 10 người thành công.

### `organization_join_requests`

id, org_id, user_id, invite_id, status (`pending|approved|rejected|cancelled`), decided_by, decided_at, created_at.
`UNIQUE (org_id, user_id) WHERE status = 'pending'`.
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

- `UNIQUE (id, org_id)`: đích của composite FK.
- `UNIQUE (org_id, lower(name)) WHERE deleted_at IS NULL`.
- `(org_id, created_at, id) WHERE deleted_at IS NULL`.
- `(deleted_at) WHERE deleted_at IS NOT NULL`: cho job purge.

### `channel_members`

| Cột        | Kiểu                                             | Ghi chú                                                              |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| channel_id | uuid                                             | FK `(channel_id, org_id)` → `channels(id, org_id)` ON DELETE CASCADE |
| org_id     | uuid                                             |                                                                      |
| user_id    | uuid                                             | FK `(org_id, user_id)` → `organization_members` ON DELETE CASCADE    |
| role       | text CHECK IN ('owner','admin','member','guest') |                                                                      |
| joined_at  | timestamptz                                      |                                                                      |
| PK         | (channel_id, user_id)                            |                                                                      |

Index: `UNIQUE (channel_id) WHERE role = 'owner'`, `(user_id)`, `(channel_id, joined_at, user_id)`.

Composite FK tới `organization_members` cho 2 bảo đảm:

- Không thể thêm người ngoài org vào kênh.
- Bị xoá khỏi org thì tự rời mọi kênh (cascade).

> **Bẫy:** Cascade cũng xoá luôn **chủ kênh**. Trước khi gỡ một người khỏi org, service phải chuyển các kênh mà người đó làm Owner sang một người khác, trong **cùng transaction**.

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

id, org_id, user_id, filename, mime_type, size_bytes bigint, sha256 (hex, client gửi lúc init), chunk_size int, total_parts int, object_key, s3_upload_id, status (`initiated|completed|aborted|expired`), meeting_id NULL, expires_at, created_at, completed_at.
Index: `(status, expires_at) WHERE status = 'initiated'` cho job dọn dẹp.

### `upload_parts`

upload_id FK ON DELETE CASCADE, part_number int, size_bytes int, etag text, created_at. PK `(upload_id, part_number)`.
PUT part là **idempotent**: `INSERT … ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = EXCLUDED.etag`.

**Complete:** `SELECT uploads … FOR UPDATE`. Nếu status đã là `completed` thì trả lại meeting đã tạo (idempotent). Nếu chưa:

1. Kiểm tra đủ part.
2. Gọi S3 `CompleteMultipartUpload`.
3. Tạo `meetings`, set `status = completed`.
4. Commit, rồi mới enqueue job với `jobId = meeting.preprocess.{meetingId}.a{attempt}`.

### `meetings`

| Cột                                 | Kiểu                                                                                       | Ghi chú                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| id                                  | uuid PK                                                                                    |                                                                                                                              |
| org_id                              | uuid                                                                                       | `UNIQUE (id, org_id)`                                                                                                        |
| owner_id                            | uuid                                                                                       | FK `(org_id, owner_id)` → organization_members. Nếu owner rời org thì chặn (RESTRICT): service chuyển chủ hoặc xoá mềm trước |
| title                               | text                                                                                       |                                                                                                                              |
| recorded_at                         | timestamptz NOT NULL                                                                       | thời điểm họp, dùng cho báo cáo tuần                                                                                         |
| duration_ms                         | int NULL                                                                                   | điền sau khi ffprobe                                                                                                         |
| language                            | text NULL                                                                                  | Whisper phát hiện                                                                                                            |
| status                              | text CHECK IN ('queued','preprocessing','transcribing','summarizing','completed','failed') |                                                                                                                              |
| failure_code, failure_message       | text NULL                                                                                  |                                                                                                                              |
| attempt                             | int DEFAULT 0                                                                              |                                                                                                                              |
| source_object_key, audio_object_key | text                                                                                       |                                                                                                                              |
| created_at, updated_at, deleted_at  | timestamptz                                                                                |                                                                                                                              |

Index: `(org_id, owner_id, created_at DESC, id) WHERE deleted_at IS NULL`, `(org_id, recorded_at)`.

**Chuyển trạng thái = UPDATE có điều kiện** (optimistic, không giữ khoá lâu):

```sql
UPDATE meetings SET status = 'transcribing', updated_at = now()
WHERE id = $1 AND status = 'preprocessing' RETURNING id;
```

0 dòng nghĩa là job này đã cũ hoặc bị chạy trùng: bỏ qua, không lỗi. **Không giữ transaction trong lúc chạy Whisper** (có thể vài chục phút).

### `meeting_shares`

meeting_id, channel_id, org_id, shared_by, shared_at. PK `(meeting_id, channel_id)`.
Có 2 composite FK:

- `(meeting_id, org_id)` → `meetings(id, org_id)`
- `(channel_id, org_id)` → `channels(id, org_id)`

Như vậy không thể share chéo org.
Index: `(channel_id, shared_at DESC, meeting_id)`.

### `transcript_segments`

| Cột              | Kiểu                                                                     | Ghi chú                      |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------- |
| id               | bigint identity PK                                                       |                              |
| meeting_id       | uuid FK ON DELETE CASCADE                                                |                              |
| seq              | int                                                                      | `UNIQUE (meeting_id, seq)`   |
| start_ms, end_ms | int                                                                      | `CHECK (end_ms >= start_ms)` |
| speaker          | text NULL                                                                | để dành                      |
| text             | text                                                                     |                              |
| search           | tsvector GENERATED ALWAYS AS (`to_tsvector('meetnote_vi', text)`) STORED | `GIN (search)`               |

Ghi transcript = **xoá rồi chèn lại** trong 1 transaction. Job chạy lại vẫn ra cùng kết quả (idempotent).
Search: `search @@ websearch_to_tsquery('meetnote_vi', $q)`, highlight bằng `ts_headline`. Quyền được lọc bằng cách join với các meeting mà user được xem.

> **Bẫy:** `to_tsvector` trong generated column phải nhận tên config dạng hằng (`'meetnote_vi'::regconfig`). Hàm 2 tham số với hằng là immutable. Hàm 1 tham số thì không.

### `meeting_summaries`

meeting_id PK FK, content jsonb (`{ overview, keyPoints[], decisions[], actionItems[{ owner, task, due }] }`), model, prompt_version, input_tokens, output_tokens, created_at.

## 5. Báo cáo tuần

### `weekly_reports`

| Cột                    | Kiểu                                                                  | Ghi chú                 |
| ---------------------- | --------------------------------------------------------------------- | ----------------------- |
| id                     | uuid PK                                                               |                         |
| channel_id, org_id     | uuid                                                                  | composite FK → channels |
| week_start             | date                                                                  | Thứ 2 theo giờ VN       |
| status                 | text CHECK IN ('pending','generating','completed','failed','skipped') | `skipped` = < 2 meeting |
| regenerate_count       | smallint DEFAULT 0 CHECK (regenerate_count BETWEEN 0 AND 3)           | DB là chốt chặn cuối    |
| current_version        | int NULL                                                              |                         |
| last_error             | text NULL                                                             |                         |
| created_at, updated_at | timestamptz                                                           |                         |

`UNIQUE (channel_id, week_start)` là **khoá idempotency** của cron:

```sql
INSERT INTO weekly_reports (…) VALUES (…)
ON CONFLICT (channel_id, week_start) DO NOTHING RETURNING id;
```

Cron chạy 2 lần (do retry hoặc nhiều instance) thì lần 2 không làm gì.

### `weekly_report_versions`

id, report_id FK, version int, trigger (`scheduled|manual`), triggered_by NULL, content jsonb, meeting_ids uuid[], model, created_at. `UNIQUE (report_id, version)`.

**Tạo lại (manual):**

1. `SELECT weekly_reports … FOR UPDATE`.
2. Kiểm tra `status <> 'generating'` và `regenerate_count < 3`.
3. `regenerate_count += 1`, `status = 'generating'`.
4. Commit, rồi enqueue với `jobId = weekly-report.generate.{id}.v{n}`.

Nếu không có `FOR UPDATE`, 2 cú bấm cùng lúc đều đọc được `count = 2` và cùng tăng. CHECK constraint sẽ bắt được trường hợp này, nhưng người dùng nhận lỗi 500 thay vì 409.

## 6. Thông báo & audit

### `notifications`

id, user_id FK, org_id NULL, type text, payload jsonb, dedupe_key text NULL, read_at, deleted_at, created_at.
Index:

- `UNIQUE (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL`: job tạo thông báo chạy lại không sinh bản trùng.
- `(user_id, created_at DESC, id) WHERE deleted_at IS NULL`.
- `(user_id) WHERE read_at IS NULL AND deleted_at IS NULL`: đếm số chưa đọc.

### `audit_logs`

id bigint identity, org_id, actor_id NULL (NULL = hệ thống), action text (vd `org.member.role_changed`), target_type, target_id, metadata jsonb (`{ before, after }`), request_id, ip, created_at.
Index: `(org_id, created_at DESC, id)`.
Ghi **trong cùng transaction** với thao tác: thao tác rollback thì log cũng rollback, không có log "ma". Chỉ INSERT, không UPDATE/DELETE. Có thể `REVOKE UPDATE, DELETE` với role ứng dụng.

### `idempotency_keys` (M5)

key text, user_id, method, path, request_hash, status_code, response jsonb, created_at, expires_at. PK `(user_id, key)`.
Dùng cho các POST không tự idempotent, theo header `Idempotency-Key`.

## 7. Tóm tắt: chỗ nào cần transaction / khoá

| Thao tác                           | Kỹ thuật                                                               | Lý do                                         |
| ---------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Refresh token                      | tx + `FOR UPDATE` refresh_token rồi session                            | Chặn 2 refresh song song, phát hiện reuse     |
| Chuyển quyền sở hữu org            | tx + `FOR UPDATE` 2 dòng member (sắp theo user_id) + hạ trước nâng sau | Partial unique index, chống deadlock          |
| Đổi vai trò / gỡ thành viên org    | tx + `FOR UPDATE` dòng member mục tiêu + kiểm tra không gỡ owner       | Owner không bị gỡ nhầm                        |
| Rời / bị gỡ khỏi org               | tx: chuyển các kênh đang làm chủ → xoá member                          | Cascade không để lại kênh mồ côi              |
| Dùng link mời                      | UPDATE có điều kiện                                                    | Nguyên tử, không cần khoá                     |
| Duyệt yêu cầu vào org              | tx + `FOR UPDATE` request                                              | Chặn duyệt 2 lần                              |
| Đổi vai trò / gỡ / chuyển chủ kênh | tx + `FOR UPDATE` dòng `channels` trước                                | Một mutex cho mỗi kênh, thứ tự khoá cố định   |
| Complete upload                    | tx + `FOR UPDATE` upload                                               | Idempotent, chặn tạo 2 meeting                |
| Chuyển trạng thái meeting          | UPDATE … WHERE status = expected                                       | Optimistic, không giữ khoá trong lúc chạy lâu |
| Ghi transcript                     | tx delete + insert                                                     | Idempotent khi chạy lại                       |
| Cron báo cáo                       | INSERT … ON CONFLICT DO NOTHING                                        | Idempotent theo (kênh, tuần)                  |
| Tạo lại báo cáo                    | tx + `FOR UPDATE` report                                               | Quota 3 lần chính xác                         |
| Job purge / dọn upload             | `FOR UPDATE SKIP LOCKED` theo lô                                       | Nhiều worker chạy song song không giẫm nhau   |
| Audit log                          | INSERT trong tx của thao tác                                           | Nhất quán                                     |
