# 05 — Danh sách API

- Base: `/v1`, trừ health (`VERSION_NEUTRAL`).
- Mọi route mặc định yêu cầu `Authorization: Bearer <access>`. Route `@Public()` được đánh dấu **Public**.
- Ký hiệu quyền: xem [04-authorization.md](04-authorization.md). "Member+" = Member trở lên.
- Response thành công: `{ data, meta: { statusCode, requestId } }`; danh sách: `data` là mảng, `meta.nextCursor`, query `?cursor=&limit=`. Lỗi: `{ error: { code, statusCode, message, details?, requestId } }`. `204` không có body; `/health/*` trả body thô. Xem [07-conventions.md](07-conventions.md) §2–3.

## Health (tag `Health`)

| Method | Path            | Ai gọi                      |
| ------ | --------------- | --------------------------- |
| GET    | `/health/live`  | Public: tiến trình còn sống |
| GET    | `/health/ready` | Public: DB + Redis sẵn sàng |

## Auth (tag `Auth`) và Me

| Method | Path                         | Ai gọi                     | Response / ghi chú                                                                             |
| ------ | ---------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| POST   | `/v1/auth/register`          | Public                     | 201 `AuthTokensResponseDto`. Email trùng (không phân biệt hoa thường) → 409 `AUTH_EMAIL_TAKEN` |
| POST   | `/v1/auth/login`             | Public                     | 200 `AuthTokensResponseDto`. Sai email hoặc mật khẩu → **cùng** 401 `AUTH_INVALID_CREDENTIALS` |
| POST   | `/v1/auth/refresh`           | Public (gửi refresh token) | 200 `AuthTokensResponseDto`. Xoay vòng, xem `03-database.md` §1                                |
| POST   | `/v1/auth/logout`            | User                       | 204. Thu hồi phiên hiện tại                                                                    |
| POST   | `/v1/auth/logout-all`        | User                       | 204. Thu hồi mọi phiên của user                                                                |
| GET    | `/v1/me`                     | User                       | `MeResponseDto` gồm `organizations: [{ id, name, role }]` theo thứ tự tham gia (từ M2)         |
| PATCH  | `/v1/me`                     | User                       | Đổi display name                                                                               |
| GET    | `/v1/me/sessions`            | User                       | `SessionResponseDto[]`, phiên đang dùng có `current: true`. Ít phần tử nên không phân trang    |
| DELETE | `/v1/me/sessions/:sessionId` | User                       | 204. Phiên của người khác → 404                                                                |

`AuthTokensResponseDto = { tokenType: 'Bearer', accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`.

## Organizations (tag `Organizations`)

Mọi route có `:orgId` đi qua `OrgMemberGuard`: không phải thành viên, org đã xoá, hoặc `:orgId` không phải uuid → **404**.

| Method | Path                                                  | Ai gọi                                                                                                                               |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/orgs`                                            | User (trở thành Owner). 201                                                                                                          |
| GET    | `/v1/orgs`                                            | User: mảng org của tôi `{ id, name, role, joinedAt }`, **không phân trang**                                                          |
| GET    | `/v1/orgs/:orgId`                                     | Member+: `{ id, name, createdAt, myRole, memberCount }`                                                                              |
| PATCH  | `/v1/orgs/:orgId`                                     | Admin+ (đổi tên, `requireJoinApproval` từ M3)                                                                                        |
| DELETE | `/v1/orgs/:orgId`                                     | Owner. **Hoãn tới M4** (M2 Q2)                                                                                                       |
| GET    | `/v1/orgs/:orgId/members?q=&role=&cursor=&limit=`     | Member+: `{ userId, displayName, email, role, joinedAt }`, sắp theo `(joined_at, user_id)`                                           |
| PATCH  | `/v1/orgs/:orgId/members/:userId`                     | Owner (`role: admin \| member`). Đổi Owner → 409 `ORG_OWNER_IMMUTABLE`                                                               |
| DELETE | `/v1/orgs/:orgId/members/:userId`                     | Owner; Admin (chỉ gỡ Member). 204. Gỡ Owner → 409; người bị gỡ còn làm chủ kênh → 409 `ORG_MEMBER_OWNS_CHANNELS` (details: các kênh) |
| POST   | `/v1/orgs/:orgId/leave`                               | Admin, Member. 204. Owner → 409 `ORG_OWNER_MUST_TRANSFER`; còn làm chủ kênh → 409 `ORG_MEMBER_OWNS_CHANNELS`                         |
| POST   | `/v1/orgs/:orgId/ownership-transfer`                  | Owner. `{ newOwnerId }`. Owner cũ thành Admin. Chuyển cho chính mình → 409                                                           |
| POST   | `/v1/orgs/:orgId/invites`                             | Admin+ (link role `admin` chỉ Owner). `{ role?, expiresInHours?, maxUses? }` → 201, `token` chỉ trả **một lần**                      |
| GET    | `/v1/orgs/:orgId/invites?cursor=`                     | Admin+. Không trả token. Mới nhất trước                                                                                              |
| DELETE | `/v1/orgs/:orgId/invites/:inviteId`                   | Admin+. Thu hồi → 204                                                                                                                |
| GET    | `/v1/invites/:token`                                  | **Public**: `{ orgName, role, expiresAt, requiresApproval }`. Không có/đã thu hồi → 404, hết hạn/hết lượt → 410                      |
| POST   | `/v1/invites/:token/accept`                           | User: `{ status: joined, orgId }` hoặc `{ status: pending, requestId }`. Đã là thành viên → 409                                      |
| GET    | `/v1/orgs/:orgId/join-requests?status=&cursor=`       | Admin+. Mặc định `pending`, mới nhất trước                                                                                           |
| POST   | `/v1/orgs/:orgId/join-requests/:requestId/approve`    | Admin+ (yêu cầu role `admin` chỉ Owner duyệt). Đã xử lý → 409                                                                        |
| POST   | `/v1/orgs/:orgId/join-requests/:requestId/reject`     | Admin+                                                                                                                               |
| GET    | `/v1/orgs/:orgId/audit-logs?action=&actorId=&cursor=` | Admin+. Mới nhất trước                                                                                                               |

## Channels (tag `Channels`)

Prefix `/v1/orgs/:orgId/channels`. Mọi route có `:channelId` đi qua `@RequireChannelPermission(...)` = `OrgMemberGuard → ChannelAccessGuard → ChannelPermissionGuard`. Kênh không tồn tại / đã xoá / riêng tư mà người gọi không được thấy → **404**. Kênh đã lưu trữ + thao tác ghi → **409 `CHANNEL_ARCHIVED`** (trừ bỏ lưu trữ, xoá, rời kênh).

| Method | Path                                            | Ai gọi                                                                                                                                                                |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/`                                             | Thành viên org (trở thành CO). Tên trùng (không phân biệt hoa thường) → 409 `CHANNEL_NAME_TAKEN`                                                                      |
| GET    | `/?q=&visibility=&archived=&cursor=&limit=`     | Thành viên org. Chỉ kênh thấy được: công khai, kênh mình là thành viên, OrgAdm thấy mọi kênh. Sắp theo tên A→Z. Mặc định ẩn kênh lưu trữ (`archived=true` để xem)     |
| GET    | `/:channelId`                                   | Người thấy được kênh. Có `myRole` (null nếu chưa join)                                                                                                                |
| PATCH  | `/:channelId`                                   | CO, CA: `name`, `description`, `visibility`, `weeklyReportEnabled`                                                                                                    |
| POST   | `/:channelId/archive` · `/:channelId/unarchive` | CO, OrgAdm. 200 + chi tiết kênh (`archivedAt`). Đã đúng trạng thái → 200, không đổi gì, không audit                                                                   |
| DELETE | `/:channelId`                                   | CO, OrgAdm. 204. Xoá mềm → 404 với mọi người, tên dùng lại được ngay. Xoá cứng sau 30 ngày (`ChannelsPurgeService`, lên lịch ở M6). Xoá được cả kênh đang lưu trữ     |
| POST   | `/:channelId/join`                              | Thành viên org, kênh công khai. 200 + chi tiết kênh (`myRole: member`). Đã ở trong kênh → 409 `CHANNEL_ALREADY_MEMBER`; kênh riêng tư (OrgAdm) → 403                  |
| POST   | `/:channelId/leave`                             | Mọi thành viên kênh. 204. CO → 409 `CHANNEL_OWNER_MUST_TRANSFER`. Kênh lưu trữ vẫn rời được                                                                           |
| GET    | `/:channelId/members?q=&role=&cursor=&limit=`   | CO, CA, CM, ngoài (pub), OrgAdm. Khách → 403                                                                                                                          |
| POST   | `/:channelId/members`                           | CO, CA. `{ userId, role }` (CA chỉ thêm member/guest; người ngoài org → 404)                                                                                          |
| PATCH  | `/:channelId/members/:userId`                   | CO, CA (giới hạn theo ma trận)                                                                                                                                        |
| DELETE | `/:channelId/members/:userId`                   | CO, CA (giới hạn theo ma trận)                                                                                                                                        |
| POST   | `/:channelId/ownership-transfer`                | CO, OrgAdm. `{ newOwnerId }` → 200 `{ channelId, ownerId }`. Người nhận không trong kênh / org → 404; là Khách hoặc đã là chủ → 409 `CHANNEL_TRANSFER_INVALID_TARGET` |
| GET    | `/:channelId/meetings?cursor=&limit=`           | `channel.content.read`: thành viên kênh, thành viên org với kênh công khai (kể cả lưu trữ); OrgAdm + riêng tư → 403                                                   | Meeting chưa xoá share vào kênh, mới share trước: keyset `(shared_at DESC, meeting_id DESC)`, mỗi dòng có `sharedAt` (M6b) |

`DELETE /v1/orgs/:orgId` (chỉ Owner, 204, xoá mềm, từ M4): mọi route bên trong trả 404, link mời hết dùng được. Rời / bị gỡ khỏi org khi còn làm chủ kênh (chưa xoá) → 409 `ORG_MEMBER_OWNS_CHANNELS`, `details[i] = { field: "channels.<id>", message: <tên kênh> }` (A→Z).

## Meetings (tag `Meetings`)

Prefix `/v1/orgs/:orgId`.

| Method | Path                                                     | Ai gọi                                                                        | Ghi chú                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/uploads`                                               | Thành viên org                                                                | Init: `{ filename, mimeType, sizeBytes, sha256, title, recordedAt }` → 201 upload (`id`, `status`, `chunkSize` = 8 MiB, `totalParts`, `receivedParts: []`, `expiresAt` = +24 giờ). Mở S3 multipart trước, INSERT sau; INSERT lỗi → abort multipart (bù trừ). Header tuỳ chọn `Idempotency-Key` (07 §3): gọi lại cùng key + cùng body → **201 với đúng upload cũ** + `Idempotent-Replayed: true` (không mở multipart thứ hai); request đầu chưa xong → 409 `IDEMPOTENCY_IN_PROGRESS`; body khác → 422 `IDEMPOTENCY_KEY_REUSED` |
| GET    | `/uploads/:uploadId`                                     | Người tạo (người khác, kể cả OrgAdm → 404)                                    | Trạng thái + `receivedParts` (để resume). `initiated` quá hạn → báo `expired` ngay                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PUT    | `/uploads/:uploadId/parts/:partNumber`                   | Người tạo                                                                     | Body `application/octet-stream` (khác → 415), bắt buộc `Content-Length` (thiếu / chunked → 411) đúng kích thước phần: lớn hơn → **413 ngay từ header** (kèm `Connection: close`), nhỏ hơn → 400 `UPLOAD_PART_SIZE_MISMATCH`. Số phần ngoài 1..totalParts → 400 `UPLOAD_PART_OUT_OF_RANGE`; hết hạn → 410 `UPLOAD_EXPIRED`; đã huỷ / xong → 409. Stream thẳng sang S3, không buffer. Gửi lại cùng phần → ghi đè (idempotent). → `{ partNumber, sizeBytes }`                                                                    |
| POST   | `/uploads/:uploadId/complete`                            | Người tạo                                                                     | → **201** meeting `queued` (lần đầu) / **200** cùng meeting (gọi lại). Thiếu phần → 409 `UPLOAD_INCOMPLETE` (`details[i].field = parts.<n>`); huỷ → 409; hết hạn → 410. Enqueue `meeting.preprocess` **sau commit** (`jobId = meeting.preprocess.<id>.a1`). Tự idempotent theo trạng thái upload nên **không** dùng `Idempotency-Key` (gửi kèm thì bị bỏ qua): hai complete song song đều nhận meeting, không có 409                                                                                                          |
| DELETE | `/uploads/:uploadId`                                     | Người tạo                                                                     | Huỷ → 204: đánh dấu `aborted` trong transaction, abort multipart NGOÀI transaction (S3 lỗi → job dọn dẹp thử lại). Gọi lại → 204. Đã complete → 409 `UPLOAD_NOT_ACTIVE`                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/meetings?channelId=&status=&from=&to=&cursor=&limit=`  | Thành viên org                                                                | Chỉ meeting xem được (04 §3), mới họp trước: keyset `(recorded_at DESC, id DESC)`. `from` gồm, `to` không gồm (lọc `recorded_at`). Lọc `channelId` cần đọc được nội dung kênh: không thấy kênh → 404, OrgAdm + kênh riêng tư → 403 (không lộ meeting nào nằm trong kênh riêng tư)                                                                                                                                                                                                                                             |
| GET    | `/meetings/:meetingId`                                   | Người xem được (04 §3); không xem được → 404                                  | Trạng thái xử lý + `channels`: các kênh chứa meeting mà người gọi thấy được metadata (thành viên / công khai / OrgAdm)                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH  | `/meetings/:meetingId`                                   | Chủ meeting                                                                   | title, recordedAt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DELETE | `/meetings/:meetingId`                                   | Chủ meeting                                                                   | Xoá mềm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/meetings/:meetingId/retry`                             | Chủ meeting                                                                   | Chỉ khi `failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/meetings/:meetingId/shares`                            | Chủ meeting + CO / CA / CM của kênh (khách, người ngoài, OrgAdm → 403)        | `{ channelId }` → **201** lần đầu / **200** cùng `sharedAt` (idempotent). Meeting của người khác → 404; kênh không thấy → 404; kênh lưu trữ → 409                                                                                                                                                                                                                                                                                                                                                                             |
| DELETE | `/meetings/:meetingId/shares/:channelId`                 | Chủ meeting (kể cả đã rời kênh), CO, CA; meeting không chủ: Owner / Admin org | 204, gọi lại → 204. Không quyền → 403, nhưng không xem được meeting → 404; kênh lưu trữ → 409                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/meetings/:meetingId/transcript?cursor=&limit=`         | Người xem được                                                                | Segment theo `seq`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/meetings/:meetingId/transcript/export?format=srt\|vtt` | Người xem được                                                                | Stream file, `Content-Disposition`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/meetings/:meetingId/summary`                           | Người xem được                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/search/transcripts?q=&channelId=&cursor=`              | Member+                                                                       | Trả meeting + đoạn khớp (`ts_headline`) + `startMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Reports (tag `Reports`)

Prefix `/v1/orgs/:orgId/channels/:channelId/reports`.

| Method | Path                            | Ai gọi                                  |
| ------ | ------------------------------- | --------------------------------------- |
| GET    | `/?cursor=`                     | Người xem được kênh                     |
| GET    | `/:weekStart` (vd `2026-10-05`) | Người xem được kênh. Trả bản mới nhất   |
| GET    | `/:weekStart/versions`          | Người xem được kênh                     |
| POST   | `/:weekStart/regenerate`        | CO, CA. 409 nếu hết quota hoặc đang tạo |

Bật/tắt báo cáo: `PATCH /v1/orgs/:orgId/channels/:channelId { weeklyReportEnabled }`.

## Notifications (tag `Notifications`)

| Method | Path                                           | Ai gọi               |
| ------ | ---------------------------------------------- | -------------------- |
| GET    | `/v1/notifications?orgId=&unreadOnly=&cursor=` | User                 |
| GET    | `/v1/notifications/unread-count?orgId=`        | User                 |
| POST   | `/v1/notifications/:id/read`                   | User (chủ thông báo) |
| POST   | `/v1/notifications/read-all?orgId=`            | User                 |
| DELETE | `/v1/notifications/:id`                        | User (xoá mềm)       |

## Realtime (Socket.IO, namespace `/realtime`)

- Kết nối: `io('/realtime', { auth: { token: '<access JWT>' } })`. Middleware xác thực trong handshake. Token sai thì từ chối kết nối.
- Server tự join `user:{userId}`. Client gửi `subscribe { meetingId }`, server kiểm tra quyền xem rồi mới join `meeting:{meetingId}`.

| Event (server → client) | Room                             | Payload                               |
| ----------------------- | -------------------------------- | ------------------------------------- |
| `meeting.progress`      | `meeting:{id}`                   | `{ meetingId, stage, percent }`       |
| `meeting.status`        | `meeting:{id}`, `user:{ownerId}` | `{ meetingId, status, failureCode? }` |
| `notification.created`  | `user:{id}`                      | Notification DTO                      |
| `report.ready`          | thông qua notification           |                                       |

> **Bẫy:** Access token hết hạn khi socket vẫn đang mở. Server lưu `exp` lúc handshake và chủ động ngắt khi hết hạn, client kết nối lại bằng token mới. Nếu không làm vậy, user bị thu hồi quyền vẫn nhận event.
