# 05 — Danh sách API

- Base: `/v1`, trừ health (`VERSION_NEUTRAL`).
- Mọi route mặc định yêu cầu `Authorization: Bearer <access>`. Route `@Public()` được đánh dấu **Public**.
- Ký hiệu quyền: xem [04-authorization.md](04-authorization.md). "Member+" = Member trở lên.
- Danh sách trả `{ data, nextCursor }`, query `?cursor=&limit=`. Xem [07-conventions.md](07-conventions.md).

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
| GET    | `/v1/me`                     | User                       | `MeResponseDto` (M2 thêm danh sách org: id, name, role)                                        |
| PATCH  | `/v1/me`                     | User                       | Đổi display name                                                                               |
| GET    | `/v1/me/sessions`            | User                       | `SessionResponseDto[]`, phiên đang dùng có `current: true`. Ít phần tử nên không phân trang    |
| DELETE | `/v1/me/sessions/:sessionId` | User                       | 204. Phiên của người khác → 404                                                                |

`AuthTokensResponseDto = { tokenType: 'Bearer', accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`.

## Organizations (tag `Organizations`)

| Method | Path                                                  | Ai gọi                                 |
| ------ | ----------------------------------------------------- | -------------------------------------- |
| POST   | `/v1/orgs`                                            | User (trở thành Owner)                 |
| GET    | `/v1/orgs`                                            | User: org của tôi                      |
| GET    | `/v1/orgs/:orgId`                                     | Member+                                |
| PATCH  | `/v1/orgs/:orgId`                                     | Admin+                                 |
| DELETE | `/v1/orgs/:orgId`                                     | Owner                                  |
| GET    | `/v1/orgs/:orgId/members?q=&cursor=&limit=`           | Member+                                |
| PATCH  | `/v1/orgs/:orgId/members/:userId`                     | Owner (đổi role)                       |
| DELETE | `/v1/orgs/:orgId/members/:userId`                     | Owner; Admin (chỉ gỡ Member)           |
| POST   | `/v1/orgs/:orgId/leave`                               | Admin, Member                          |
| POST   | `/v1/orgs/:orgId/ownership-transfer`                  | Owner                                  |
| POST   | `/v1/orgs/:orgId/invites`                             | Admin+                                 |
| GET    | `/v1/orgs/:orgId/invites`                             | Admin+                                 |
| DELETE | `/v1/orgs/:orgId/invites/:inviteId`                   | Admin+                                 |
| GET    | `/v1/invites/:token`                                  | User: xem trước tên org                |
| POST   | `/v1/invites/:token/accept`                           | User: vào thẳng, hoặc tạo join request |
| GET    | `/v1/orgs/:orgId/join-requests?status=`               | Admin+                                 |
| POST   | `/v1/orgs/:orgId/join-requests/:requestId/approve`    | Admin+                                 |
| POST   | `/v1/orgs/:orgId/join-requests/:requestId/reject`     | Admin+                                 |
| GET    | `/v1/orgs/:orgId/audit-logs?action=&actorId=&cursor=` | Admin+                                 |

## Channels (tag `Channels`)

Prefix `/v1/orgs/:orgId/channels`.

| Method | Path                                            | Ai gọi                          |
| ------ | ----------------------------------------------- | ------------------------------- |
| POST   | `/`                                             | Member+ của org (trở thành CO)  |
| GET    | `/?q=&visibility=&archived=&cursor=`            | Member+ (lọc theo quyền thấy)   |
| GET    | `/:channelId`                                   | Người thấy được kênh            |
| PATCH  | `/:channelId`                                   | CO, CA                          |
| POST   | `/:channelId/archive` · `/:channelId/unarchive` | CO, OrgAdm                      |
| DELETE | `/:channelId`                                   | CO, OrgAdm (xoá mềm)            |
| POST   | `/:channelId/join`                              | Thành viên org (kênh công khai) |
| POST   | `/:channelId/leave`                             | CA, CM, G                       |
| GET    | `/:channelId/members?q=&role=&cursor=&limit=`   | CO, CA, CM, ngoài (pub), OrgAdm |
| POST   | `/:channelId/members`                           | CO, CA                          |
| PATCH  | `/:channelId/members/:userId`                   | CO, CA (giới hạn theo ma trận)  |
| DELETE | `/:channelId/members/:userId`                   | CO, CA (giới hạn theo ma trận)  |
| POST   | `/:channelId/ownership-transfer`                | CO, OrgAdm                      |
| GET    | `/:channelId/meetings?cursor=`                  | Người xem được kênh             |

## Meetings (tag `Meetings`)

Prefix `/v1/orgs/:orgId`.

| Method | Path                                                     | Ai gọi                        | Ghi chú                                                                                                      |
| ------ | -------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST   | `/uploads`                                               | Member+                       | Init: `{ filename, mimeType, sizeBytes, sha256, title, recordedAt }` → `{ uploadId, chunkSize, totalParts }` |
| GET    | `/uploads/:uploadId`                                     | Người tạo                     | Trạng thái + danh sách part đã nhận (để resume)                                                              |
| PUT    | `/uploads/:uploadId/parts/:partNumber`                   | Người tạo                     | Body `application/octet-stream`, header `Content-Length`. Idempotent                                         |
| POST   | `/uploads/:uploadId/complete`                            | Người tạo                     | Header `Idempotency-Key`. Trả meeting                                                                        |
| DELETE | `/uploads/:uploadId`                                     | Người tạo                     | Huỷ upload, abort multipart                                                                                  |
| GET    | `/meetings?channelId=&status=&from=&to=&cursor=`         | Member+                       | Chỉ meeting xem được                                                                                         |
| GET    | `/meetings/:meetingId`                                   | Người xem được                |                                                                                                              |
| PATCH  | `/meetings/:meetingId`                                   | Chủ meeting                   | title, recordedAt                                                                                            |
| DELETE | `/meetings/:meetingId`                                   | Chủ meeting                   | Xoá mềm                                                                                                      |
| POST   | `/meetings/:meetingId/retry`                             | Chủ meeting                   | Chỉ khi `failed`                                                                                             |
| POST   | `/meetings/:meetingId/shares`                            | Chủ meeting + là CM+ của kênh | `{ channelId }`                                                                                              |
| DELETE | `/meetings/:meetingId/shares/:channelId`                 | Chủ meeting, CO, CA           |                                                                                                              |
| GET    | `/meetings/:meetingId/transcript?cursor=&limit=`         | Người xem được                | Segment theo `seq`                                                                                           |
| GET    | `/meetings/:meetingId/transcript/export?format=srt\|vtt` | Người xem được                | Stream file, `Content-Disposition`                                                                           |
| GET    | `/meetings/:meetingId/summary`                           | Người xem được                |                                                                                                              |
| GET    | `/search/transcripts?q=&channelId=&cursor=`              | Member+                       | Trả meeting + đoạn khớp (`ts_headline`) + `startMs`                                                          |

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
