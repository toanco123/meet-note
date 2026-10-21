# M7 — Realtime

- **Trạng thái:** **Xong** (2026-10-21): B1–B7, chưa push / mở PR → CI chưa chạy. Plan đã duyệt 2026-10-21 (★ cho Q1–Q4)
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

- [x] **B1 — Gateway + xác thực handshake**
  - Việc: cài dependency; `RealtimeModule`, gateway namespace `/realtime`; middleware handshake dùng lại `TokenService.verifyAccessToken` + `SessionsService.isActive` (cùng 2 lớp như `JwtAuthGuard`); tự join `user:{id}`, `session:{sid}`.
  - Test (e2e, `socket.io-client` thật): token đúng → kết nối; thiếu / sai / hết hạn / phiên đã thu hồi → `connect_error` đúng mã.
- [x] **B2 — Ngắt khi token hết hạn / phiên bị thu hồi (Q1)**
  - Việc: hẹn giờ ngắt theo `exp`; logout, logout-all, phát hiện reuse → sau commit ngắt `session:{sid}` (hoặc mọi phiên của user).
  - Test: token TTL ngắn → bị ngắt đúng lúc; logout ở REST → socket của phiên đó bị ngắt, phiên khác còn sống.
  - **Điều chỉnh so với plan:** Redis adapter + `RealtimePublisher` (redis-emitter) chuyển từ B4 lên B2 — xem bài học 3. B4 còn: test 2 instance thật, worker phát event, CORS.
- [x] **B3 — Subscribe meeting theo quyền xem**
  - Việc: `subscribe` / `unsubscribe` (ack, Q4), kiểm bằng `meetingVisibleTo` (M6b).
  - Test: ma trận người xem → ack ok / `NOT_FOUND`; payload sai → `VALIDATION_FAILED`; subscribe xong mới nhận event của room.
- [x] **B4 — Nhiều instance: kiểm chứng 2 instance + worker + CORS** (adapter / emitter đã có từ B2)
  - Việc: adapter cho api, `RealtimeEmitter` (server / redis-emitter), kết nối Redis pub/sub riêng.
  - Test: **2 api instance** trong cùng test — client ở instance B nhận event phát từ instance A; worker emitter (application context, không HTTP) phát → client nhận; `disconnectSockets` của B2 đúng xuyên instance.
- [x] **B5 — Mất quyền là rời room (Q2)**
  - Việc: các thao tác làm mất quyền (gỡ share, xoá meeting, gỡ khỏi kênh / org, rời kênh, đổi visibility, xoá kênh) phát yêu cầu "kiểm lại" SAU commit; gateway kiểm lại đúng nhóm socket bị ảnh hưởng.
  - Test: mỗi loại thay đổi → subscriber mất quyền nhận `meeting.access_revoked` và không nhận event tiếp theo; subscriber còn quyền vẫn nhận. Đột biến bỏ từng điểm phát "kiểm lại" → đúng ca đó đỏ.
- [x] **B6 — `meeting.status` khi upload complete + trang thử**
  - Việc: phát `meeting.status { meetingId, status: 'queued' }` vào `user:{ownerId}` + `meeting:{id}` sau commit; trang `/realtime-test.html` (dev).
  - Test: complete upload qua HTTP → client nhận đúng 1 event; complete lại (200) → không phát lại; transaction lỗi → không có event.
- [x] **B7 — Đóng mốc**
  - Việc: `openapi.json` (nếu đổi), đối chiếu tài liệu, chạy tay trên Compose với **2 api instance** sau một proxy, ghi "Điều học được".

## Tiêu chí hoàn thành

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh (unit 391)
- [x] `pnpm test:e2e` xanh ở local (521 test), gồm test 2 api instance + worker
- [ ] `pnpm test:e2e` xanh trên CI — chạy khi push / mở PR
- [x] Không có đường nào để socket tiếp tục nhận event sau khi mất phiên (token hết hạn, logout, logout-all, xoá phiên, reuse) hoặc mất quyền xem (10 điểm phát "kiểm lại", mỗi điểm có đột biến đỏ)
- [x] `docs/design/` khớp code (05 Realtime, 02, 07, 09) — đối chiếu bằng script
- [x] Docker Compose với 2 api instance + worker: 7 bước qua Redis thật (event, cho rời room, ngắt phiên, worker phát, kiểm Origin)

## Điều sẽ học

- Socket.IO trong NestJS: gateway, namespace, middleware handshake, room, ack
- Xác thực kết nối sống lâu: token hết hạn giữa chừng, thu hồi phiên
- Scale ngang WebSocket: Redis adapter (pub/sub), emitter từ tiến trình không có HTTP, sticky session
- "Phát sau commit" và "mất quyền là mất event" — phân quyền không chỉ ở lúc vào cửa

## Điều học được / bẫy gặp phải

1. **`@nestjs/websockets` / `@nestjs/platform-socket.io`: `latest` là 12.2.0 (phát hành 2 ngày trước), core của dự án là 12.1.3** → cài 12.1.3 cho cùng bản với core. Các gói `@nestjs/*` lệch minor là nguồn lỗi DI / metadata khó thấy; nâng thì nâng cả bộ một lần.
2. **Xác thực ở middleware của namespace, không ở `handleConnection`.** Từ chối trong `handleConnection` (disconnect) thì client đã nhận `connect` một nhịp — đủ để client tưởng là thành công, và socket có thể đã vào room. Middleware từ chối → `connect_error` mang `err.data.code` (cùng mã REST). Đột biến bỏ lớp "phiên còn sống" → token của phiên đã logout kết nối được (`OK` thay vì `AUTH_SESSION_REVOKED`).
3. **Vòng phụ thuộc gateway ↔ auth, gỡ bằng một cổng phát qua Redis.** Thu hồi phiên (`SessionsService`) phải ngắt socket; nhưng gateway lại cần `SessionsService` để xác thực handshake → inject thẳng qua lại là vòng. Gỡ: mọi lệnh phát / ngắt đi qua interface `RealtimePublisher` (`src/infra/realtime/`) hiện thực bằng `@socket.io/redis-emitter` — không phụ thuộc gateway, đi xuyên mọi api instance, và worker dùng y nguyên. Hệ quả: server phải có Redis adapter mới nhận được lệnh từ emitter → adapter chuyển từ B4 lên B2. Một đường duy nhất cho api lẫn worker, không có kiểu "ở api gọi server, ở worker gọi emitter".
4. **Kết nối sống lâu hơn token.** Handshake chỉ kiểm lúc vào cửa; socket mở 1 giờ với token 15 phút thì phải tự ngắt đúng `exp` (`setTimeout`, huỷ khi socket tự ngắt trước để không giữ timer rác). `TokenService.verifyAccessToken` trả thêm `expiresAt` cho việc này — test cũ so nguyên object kết quả đỏ, sửa thành khẳng định thêm `expiresAt` (lệch < 1 s vì `exp` tính bằng giây). Thu hồi phiên → `session.ended` rồi `disconnectSockets(true)`: hai lệnh PUBLISH trên cùng kết nối Redis nên tới mỗi instance đúng thứ tự. 4 đột biến (bỏ hẹn giờ; bỏ ngắt ở revoke / revokeAll / reuse) đều đỏ đúng ca.
5. **`APP_GUARD` chạy cả cho message WebSocket — và đã chặn âm thầm.** Ack của `subscribe` timeout ở MỌI ca, kể cả hợp lệ; log tạm cho thấy handler không hề được gọi. Nguyên nhân: `JwtAuthGuard` đăng ký bằng `APP_GUARD` (toàn cục) nên Nest áp nó cho từng message của gateway, và từ M1 guard có `if (context.getType() !== 'http') return false` (cố ý chặn mặc định). Guard từ chối → Nest phát event `exception` riêng, KHÔNG trả ack → client chỉ thấy timeout. Sửa: context `ws` cho qua khi socket đã qua middleware handshake (`socket.data.user`); context khác vẫn chặn mặc định. Không kiểm lại phiên mỗi message vì B2 đã ngắt socket khi phiên bị thu hồi. Thêm unit test cho các nhánh context. Bài học: "chặn mặc định" đúng hướng an toàn, nhưng phải để lại dấu vết dễ thấy — lỗi của guard ở WS không có log, không có HTTP 403.
6. **Socket không có org trên path như REST** → `subscribe` tự tìm org của meeting rồi vai trò của người gọi trong org đó, thay cho `OrgMemberGuard` — vì biểu thức xem của M6b có tiền điều kiện "người xem thuộc org" (M6b bài học 1). Người org khác subscribe → `NOT_FOUND`. Đột biến bỏ kiểm quyền → ma trận đỏ.
7. **Test "scale" ngay trong một tiến trình test:** hai app Nest thật (`createTestApp` hai lần, cùng Postgres + Redis, hai cổng) + một application context của `WorkerModule`. Kiểm: event từ A tới client ở B; worker phát tới client; logout gọi vào A ngắt socket ở B; `fetchSockets` ở A thấy socket ở B. Đột biến bỏ Redis adapter → cả 4 ca đỏ — một instance đơn lẻ thì mọi test trước đó vẫn xanh, nên lỗi "quên adapter" chỉ lộ ra khi có ≥ 2 instance.
8. **CORS không bảo vệ WebSocket.** Tuỳ chọn `cors` của Socket.IO chỉ áp cho HTTP long-polling; trình duyệt không áp CORS cho WebSocket → một trang web lạ vẫn mở được socket (Cross-Site WebSocket Hijacking nếu xác thực dựa trên cookie). Dự án xác thực bằng token trong `auth` (trang lạ không đọc được token) nhưng vẫn kiểm `Origin` ở `allowRequest` (chạy cho handshake của mọi transport) theo `REALTIME_CORS_ORIGINS`; không có `Origin` = client không phải trình duyệt → cho qua. Đột biến cho qua mọi origin → test đỏ.
9. **"Kiểm lại" theo phạm vi, mỗi instance lo socket của mình.** Thao tác làm mất quyền chỉ biết NGƯỜI / MEETING / KÊNH / TỔ CHỨC bị ảnh hưởng, không biết socket nào đang ở đâu → phát `serverSideEmit('realtime.revalidate', scope)` qua redis-emitter; gateway MỌI instance nhận, dùng `.local.fetchSockets()` để chỉ kiểm socket của chính mình. Phạm vi kênh / tổ chức: lấy các room meeting đang có subscriber ở instance này (`adapter.rooms`), rồi hỏi DB "trong các id này, cái nào thuộc kênh / tổ chức" — không quét mọi meeting của kênh. 10 điểm phát (gỡ share, xoá meeting, gỡ khỏi / rời kênh, kênh → riêng tư, xoá kênh, hạ vai trò org, gỡ khỏi / rời org, xoá org) — đột biến bỏ TỪNG điểm → đúng một ca đỏ.
10. **Lỗ hổng tìm ra khi viết test "xoá tổ chức": `canView` của B3 dùng `findMember`, KHÔNG loại tổ chức đã xoá mềm** — REST thì `OrgMemberGuard` dùng `findMembership` (có `organizations.deleted_at IS NULL`). Hệ quả: xoá org xong vẫn subscribe được meeting của nó. Sửa: socket dùng CHÍNH hàm của guard REST. Bài học: khi một đường mới (WebSocket) dựng lại kiểm tra của đường cũ (REST), dùng lại đúng hàm thay vì hàm "trông giống"; đột biến quay về `findMember` → 2 ca đỏ.
11. **Khe giữa "kiểm quyền" và `join`.** `subscribe` kiểm quyền rồi mới `join`; nếu thay đổi làm mất quyền commit + phát "kiểm lại" đúng giữa hai bước, lệnh kiểm lại không thấy socket trong room → bỏ sót. Sửa: kiểm LẦN HAI sau `join` — thay đổi commit trước lần kiểm này thì lần kiểm thấy; commit sau thì lệnh kiểm lại (phát sau commit) thấy socket đã trong room. Lập luận theo thứ tự sự kiện, không cần khoá. (Khe này khó ép thứ tự bằng test e2e; ghi lại lập luận.)
12. **Test chạy song song dùng chung Redis → `fetchSockets` xuyên instance timeout.** Lượt e2e đầy đủ đỏ một ca (chạy riêng thì xanh): `timeout reached while waiting for fetchSockets response` từ redis-adapter. `fetchSockets()` (không `.local`) gửi yêu cầu qua kênh Redis rồi chờ phản hồi từ MỌI server đang nghe kênh đó (đếm bằng `PUBSUB NUMSUB`) — gồm cả server của FILE TEST KHÁC (cùng container Redis, cùng key `meetnote:socket.io`); server nào vừa đóng là không bao giờ trả lời → chờ hết 5 s. Mỗi file test có DB riêng nhưng Redis thì chưa từng được cô lập theo kênh realtime. Sửa: key thành env `REALTIME_REDIS_KEY`, `setup-e2e` đặt key ngẫu nhiên mỗi file (như DB riêng); e2e đầy đủ chạy lại 2 lần đều xanh. Ở production cùng bẫy đó: hai môi trường chung Redis phải khác key. Code chính chỉ dùng `.local.fetchSockets()` nên không phụ thuộc phản hồi của instance khác (rolling deploy không làm treo "kiểm lại").
13. **"Phát sau commit" kiểm bằng chính quan sát của publisher** (như queue ở M5): publisher giả ghi lại, ngay lúc `emit`, một connection KHÁC có thấy meeting không. Test cũng bắt được lỗi của chính nó: lần đầu reset danh sách event SAU lượt complete bị lỗi → nếu lượt lỗi có phát thì cũng đã bị xoá mất; dời reset lên trước. Đột biến phát cả khi complete gọi lại (200) → đỏ.
14. **Route Express gắn sau `app.init()` không bao giờ tới được.** Trang thử trả 404 trong test: `createTestApp` đã `init()` (Nest gắn handler 404 cuối chuỗi lúc init) rồi mới gắn route. `main.ts` thì đúng thứ tự (gắn trước `listen()`). Thêm `beforeInit` cho `createTestApp` để test đi đúng thứ tự như main.ts.
15. **Chạy tay 2 api instance trên Compose không cần sửa `compose.yaml`:** file override ngoài repo thêm `api2` bằng `extends` + `ports: !override ['3001:3000']` (Compose 2.24+). Socket nối instance 2, REST gọi instance 1, và một bước phát event **từ trong container worker** bằng redis-emitter — 7 bước đều đúng. Không cần sticky session vì client chỉ dùng transport WebSocket (sticky session cần cho HTTP long-polling, khi các request của một phiên Engine.IO phải tới cùng instance).
