# M7 — Realtime

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-21: ★ cho Q1–Q4)
- **Nhánh:** `m7-realtime`
- **Tài liệu thiết kế liên quan:** [01-overview D6](../design/01-overview.md), [02-architecture §2 (nguyên tắc giao tiếp)](../design/02-architecture.md), [05-api Realtime](../design/05-api.md), [08-testing](../design/08-testing.md), [10-roadmap M7](../design/10-roadmap.md)
- **Ghi chú:** pipeline M6 đang hoãn → chưa có event `meeting.progress` thật. Mốc này dựng **hạ tầng realtime cho đúng** (xác thực, room theo quyền, nhiều instance, mất quyền là mất event); event `meeting.progress` cắm vào khi làm M6, `notification.created` khi làm M10.

## Mục tiêu

Cuối mốc:

- client kết nối Socket.IO namespace `/realtime` bằng access token; token sai / hết hạn / phiên đã thu hồi → bị từ chối; **token hết hạn hoặc phiên bị thu hồi khi đang mở socket → server chủ động ngắt**;
- mỗi socket tự vào room `user:{id}`; `subscribe { meetingId }` chỉ vào được room `meeting:{id}` nếu **xem được** meeting (dùng lại điều kiện xem của M6b);
- **mất quyền xem → rời room ngay** (gỡ share, xoá meeting, bị gỡ khỏi kênh / org, kênh đổi sang riêng tư…), không đợi tới lúc token hết hạn;
- chạy đúng với **≥ 2 api instance** (Redis adapter) và **worker phát event** qua Redis (emitter) — kiểm bằng test có 2 instance thật;
- event đầu tiên dùng thật: `meeting.status` khi upload complete (meeting `queued`), phát **sau commit**;
- trang HTML thử (chỉ ở môi trường dev) để kết nối, subscribe và xem event.

## Ngoài phạm vi

- `meeting.progress` (cần pipeline M6), `notification.created` (M10), `report.ready` (M9).
- Client gửi dữ liệu qua socket (chat, presence). Socket chỉ để **nhận** event; ghi vẫn qua REST.
- Lưu event để gửi bù khi client mất kết nối: DB là nguồn sự thật, client kết nối lại thì gọi REST (02 §2.3).

## Quyết định cần duyệt

| #   | Câu hỏi                                                                                  | Đề xuất ★                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Phương án khác                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Phiên bị thu hồi (logout, logout-all, phát hiện reuse refresh token) khi socket đang mở? | ★ **Ngắt ngay**: mỗi socket vào thêm room `session:{sid}`; sau khi thu hồi phiên commit → `in('session:{sid}').disconnectSockets()` — qua Redis adapter nên đúng cả khi socket nằm ở instance khác. Kèm hẹn giờ ngắt đúng lúc `exp` của token (client kết nối lại bằng token mới)                                                                                                                                                                                     | Chỉ ngắt khi token hết hạn (≤ 15 phút): đơn giản hơn, nhưng logout xong vẫn nhận event tới 15 phút                                                                            |
| Q2  | Mất quyền xem meeting khi đang ở room `meeting:{id}`?                                    | ★ **Kiểm lại có mục tiêu, sau commit**: thao tác làm mất quyền theo **meeting** (gỡ share, xoá meeting) → kiểm lại mọi socket trong room `meeting:{id}`; theo **người** (bị gỡ khỏi kênh / org, rời kênh) → kiểm lại các room meeting của socket người đó; theo **kênh** (đổi công khai → riêng tư, xoá kênh) → kiểm lại các room meeting của kênh. Socket không còn xem được → rời room + nhận event `meeting.access_revoked`. Hạn chót luôn là `exp` của token (Q1) | Kiểm lại định kỳ (vd mỗi 60 s) mọi subscription: đơn giản, nhưng có độ trễ và tốn truy vấn đều đặn. Kiểm quyền lúc PHÁT từng event: đúng tuyệt đối nhưng mỗi event N truy vấn |
| Q3  | Nhiều api instance?                                                                      | ★ `@socket.io/redis-adapter` (pub/sub thường) + `@socket.io/redis-emitter` cho worker, theo bảng 09-versions (`4.8.4` / `8.3.0` / `5.1.0`, tra lại lúc cài). Kết nối Redis riêng cho pub/sub (một connection ở chế độ subscribe không chạy lệnh khác được)                                                                                                                                                                                                            | Sharded adapter (Redis 7+ `SSUBSCRIBE`): hợp với Redis Cluster, dự án dùng một Redis nên chưa cần                                                                             |
| Q4  | Gửi lỗi cho client thế nào?                                                              | ★ Handshake bị từ chối: `connect_error` với `data: { code }` (`AUTH_TOKEN_MISSING` / `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_REVOKED`…) — cùng mã với REST. `subscribe` dùng **ack**: `{ data }` hoặc `{ error: { code, message } }` (cùng vỏ với REST, 07 §2–3); meeting không xem được → `NOT_FOUND`                                                                                                                                                                   | Event `error` riêng: client phải tự khớp lỗi với yêu cầu nào                                                                                                                  |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- **Event là gợi ý, không phải dữ liệu** (02 §2.3): payload nhỏ (`{ meetingId, status }`), client cần chi tiết thì gọi REST. Phát **sau commit** (như enqueue ở M5): phát trong transaction mà rollback → client thấy trạng thái "ma".
- `RealtimeEmitter` là interface trong `src/infra/realtime/`: api dùng server Socket.IO, worker dùng redis-emitter — module domain không biết đang chạy ở tiến trình nào.
- CORS của Socket.IO: env `REALTIME_CORS_ORIGINS` (mặc định chặn hết, dev cho `http://localhost:3000`).
- Trang thử phục vụ ở `/realtime-test.html` **chỉ khi `NODE_ENV=development`** (như Swagger).

## Thay đổi thiết kế

- Không có bảng mới.
- 05-api Realtime: thêm room `session:{sid}`, event `meeting.access_revoked`, ack của `subscribe` / `unsubscribe`, mã lỗi handshake.
- Biến môi trường: `REALTIME_CORS_ORIGINS`.

## Dependency mới

`socket.io`, `@nestjs/websockets` + `@nestjs/platform-socket.io` (12.1.3, cùng bản Nest), `@socket.io/redis-adapter`, `@socket.io/redis-emitter`; dev: `socket.io-client`. Cài theo skill `add-dependency`, cập nhật 09-versions.

## Các bước

- [ ] **B1 — Gateway + xác thực handshake**
  - Việc: cài dependency; `RealtimeModule`, gateway namespace `/realtime`; middleware handshake dùng lại `TokenService.verifyAccessToken` + `SessionsService.isActive` (cùng 2 lớp như `JwtAuthGuard`); tự join `user:{id}`, `session:{sid}`.
  - Test (e2e, `socket.io-client` thật): token đúng → kết nối; thiếu / sai / hết hạn / phiên đã thu hồi → `connect_error` đúng mã.
- [ ] **B2 — Ngắt khi token hết hạn / phiên bị thu hồi (Q1)**
  - Việc: hẹn giờ ngắt theo `exp`; logout, logout-all, phát hiện reuse → sau commit ngắt `session:{sid}` (hoặc mọi phiên của user).
  - Test: token TTL ngắn → bị ngắt đúng lúc; logout ở REST → socket của phiên đó bị ngắt, phiên khác còn sống.
- [ ] **B3 — Subscribe meeting theo quyền xem**
  - Việc: `subscribe` / `unsubscribe` (ack, Q4), kiểm bằng `meetingVisibleTo` (M6b).
  - Test: ma trận người xem → ack ok / `NOT_FOUND`; payload sai → `VALIDATION_FAILED`; subscribe xong mới nhận event của room.
- [ ] **B4 — Nhiều instance: Redis adapter + emitter**
  - Việc: adapter cho api, `RealtimeEmitter` (server / redis-emitter), kết nối Redis pub/sub riêng.
  - Test: **2 api instance** trong cùng test — client ở instance B nhận event phát từ instance A; worker emitter (application context, không HTTP) phát → client nhận; `disconnectSockets` của B2 đúng xuyên instance.
- [ ] **B5 — Mất quyền là rời room (Q2)**
  - Việc: các thao tác làm mất quyền (gỡ share, xoá meeting, gỡ khỏi kênh / org, rời kênh, đổi visibility, xoá kênh) phát yêu cầu "kiểm lại" SAU commit; gateway kiểm lại đúng nhóm socket bị ảnh hưởng.
  - Test: mỗi loại thay đổi → subscriber mất quyền nhận `meeting.access_revoked` và không nhận event tiếp theo; subscriber còn quyền vẫn nhận. Đột biến bỏ từng điểm phát "kiểm lại" → đúng ca đó đỏ.
- [ ] **B6 — `meeting.status` khi upload complete + trang thử**
  - Việc: phát `meeting.status { meetingId, status: 'queued' }` vào `user:{ownerId}` + `meeting:{id}` sau commit; trang `/realtime-test.html` (dev).
  - Test: complete upload qua HTTP → client nhận đúng 1 event; complete lại (200) → không phát lại; transaction lỗi → không có event.
- [ ] **B7 — Đóng mốc**
  - Việc: `openapi.json` (nếu đổi), đối chiếu tài liệu, chạy tay trên Compose với **2 api instance** sau một proxy, ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI, gồm test 2 instance
- [ ] Không có đường nào để socket tiếp tục nhận event sau khi mất phiên hoặc mất quyền xem
- [ ] `docs/design/` khớp code (05 Realtime, 02, 09)

## Điều sẽ học

- Socket.IO trong NestJS: gateway, namespace, middleware handshake, room, ack
- Xác thực kết nối sống lâu: token hết hạn giữa chừng, thu hồi phiên
- Scale ngang WebSocket: Redis adapter (pub/sub), emitter từ tiến trình không có HTTP, sticky session
- "Phát sau commit" và "mất quyền là mất event" — phân quyền không chỉ ở lúc vào cửa

## Điều học được / bẫy gặp phải

(Ghi trong lúc làm)
