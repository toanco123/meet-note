# 04 — Phân quyền

## 1. Ma trận cấp tổ chức

O = Owner, A = Admin, M = Member. ✓ = được, ✗ = không, ghi chú = có điều kiện.

| Hành động                                                 |                         O                          |       A       |                           M                           |
| --------------------------------------------------------- | :------------------------------------------------: | :-----------: | :---------------------------------------------------: |
| Xem thông tin org, danh sách thành viên                   |                         ✓                          |       ✓       |                           ✓                           |
| Sửa thông tin org, bật/tắt `require_join_approval`        |                         ✓                          |       ✓       |                           ✗                           |
| Xoá org                                                   |                         ✓                          |       ✗       |                           ✗                           |
| Tạo / thu hồi link mời (role member)                      |                         ✓                          |       ✓       |                           ✗                           |
| Tạo link mời với role admin                               |                         ✓                          |       ✗       |                           ✗                           |
| Duyệt / từ chối yêu cầu vào org                           |                         ✓                          |       ✓       |                           ✗                           |
| Đổi vai trò member ↔ admin                                |                         ✓                          |       ✗       |                           ✗                           |
| Gỡ thành viên                                             |                 ✓ (trừ chính mình)                 | chỉ gỡ Member |                           ✗                           |
| Chuyển quyền sở hữu                                       | ✓ (cho member/admin hiện có; owner cũ thành admin) |       ✗       |                           ✗                           |
| Rời org                                                   |              phải chuyển sở hữu trước              |       ✓       |                           ✓                           |
| Tạo kênh                                                  |                         ✓                          |       ✓       |                           ✓                           |
| Upload cuộc họp (thao tác trên một upload: chỉ người tạo) |                         ✓                          |       ✓       |                           ✓                           |
| Xem danh sách mọi kênh, kể cả riêng tư (chỉ metadata)     |                         ✓                          |       ✓       | chỉ kênh công khai + kênh riêng tư mình là thành viên |
| Quản trị bất kỳ kênh (lưu trữ, xoá, chỉ định chủ kênh)    |                         ✓                          |       ✓       |                           ✗                           |
| Xem audit log                                             |                         ✓                          |       ✓       |                           ✗                           |

Quy tắc chung: **không ai được tác động lên người có vai trò ≥ mình**, trừ Owner.

Cấp vai trò (tạo link mời, duyệt yêu cầu tham gia) theo `canGrantRole(actor, role)` (M3): Owner cấp được admin/member, Admin chỉ cấp được member. Tức **không ai cấp được vai trò ngang hoặc cao hơn mình**, trừ Owner. Đây là kiểm tra theo _đối tượng_, nên nằm trong service/policy chứ không chỉ ở guard.

## 2. Ma trận cấp kênh

CO = Chủ kênh, CA = QTV kênh, CM = Thành viên kênh, G = Khách.
**Ngoài (pub)** = thành viên org chưa join kênh công khai.
**OrgAdm** = Org Owner/Admin không phải thành viên kênh.

| Hành động                                    |          CO           |        CA        |          CM          |          G           |        Ngoài (pub)        |              OrgAdm               |
| -------------------------------------------- | :-------------------: | :--------------: | :------------------: | :------------------: | :-----------------------: | :-------------------------------: |
| Xem metadata kênh                            |           ✓           |        ✓         |          ✓           |          ✓           |             ✓             |                 ✓                 |
| Xem meeting / transcript / tóm tắt / báo cáo |           ✓           |        ✓         |          ✓           |          ✓           |             ✓             |      chỉ khi kênh công khai       |
| Xem danh sách thành viên                     |           ✓           |        ✓         |          ✓           |          ✗           |             ✓             |                 ✓                 |
| Tự join                                      |   409 (đã ở trong)    | 409 (đã ở trong) |   409 (đã ở trong)   |         409          |             ✓             |       ✓ nếu kênh công khai        |
| Rời kênh                                     | phải chuyển chủ trước |        ✓         |          ✓           |          ✓           |             –             |                 –                 |
| Chia sẻ meeting (của chính mình) vào kênh    |           ✓           |        ✓         |          ✓           |          ✗           |             ✗             |                 ✗                 |
| Gỡ meeting khỏi kênh                         |           ✓           |        ✓         | chỉ meeting của mình | chỉ meeting của mình | chỉ meeting của mình (Q4) |  chỉ meeting không chủ (M6b Q2)   |
| Thêm thành viên (role member/guest)          |           ✓           |        ✓         |          ✗           |          ✗           |             ✗             |                 ✗                 |
| Thêm/nâng lên admin                          |           ✓           |        ✗         |          ✗           |          ✗           |             ✗             |                 ✗                 |
| Đổi vai trò member ↔ guest                   |           ✓           |        ✓         |          ✗           |          ✗           |             ✗             |                 ✗                 |
| Gỡ thành viên                                |     ✓ (trừ mình)      | chỉ member/guest |          ✗           |          ✗           |             ✗             |                 ✗                 |
| Chuyển chủ kênh                              |           ✓           |        ✗         |          ✗           |          ✗           |             ✗             | ✓ (override, vd chủ kênh rời org) |
| Sửa tên/mô tả/visibility, bật/tắt báo cáo    |           ✓           |        ✓         |          ✗           |          ✗           |             ✗             |                 ✗                 |
| Lưu trữ / bỏ lưu trữ                         |           ✓           |        ✗         |          ✗           |          ✗           |             ✗             |                 ✓                 |
| Xoá kênh                                     |           ✓           |        ✗         |          ✗           |          ✗           |             ✗             |                 ✓                 |
| Tạo lại báo cáo tuần                         |           ✓           |        ✓         |          ✗           |          ✗           |             ✗             |                 ✗                 |
| Nhận thông báo báo cáo tuần                  |           ✓           |        ✓         |          ✓           |          ✗           |             ✗             |                 ✗                 |

**Gỡ meeting khỏi kênh:** chủ meeting luôn gỡ được meeting của mình, kể cả khi không (còn) ở trong kênh (M6b Q4). Kiểm theo đối tượng: `decideUnshare` (`src/modules/meetings/meeting-share.policy.ts`); share là `channel.meeting.share` trong `channelPolicy`.
**Kênh đã lưu trữ:** mọi hành động ghi đều trả `409 CHANNEL_ARCHIVED`, trừ bỏ lưu trữ, xoá và **rời kênh** (để không ai bị kẹt trong kênh chỉ đọc). Danh sách nằm ở `BLOCKED_WHEN_ARCHIVED` trong `channel.policy.ts`.
**Kênh riêng tư mà người gọi không có quyền thấy:** trả `404`, không trả `403`, để không lộ việc kênh tồn tại.

## 3. Quyền xem meeting

User (thành viên org) được xem meeting M **chưa xoá** khi thoả **một** trong các điều kiện:

1. User là `owner_id` của M.
2. M được share vào kênh C **chưa xoá**, và user là thành viên C (bất kỳ vai trò, kể cả khách).
3. M được share vào kênh **công khai chưa xoá**. Kênh **đã lưu trữ vẫn tính**: lưu trữ = chỉ đọc (M6b Q1, khớp `channel.content.read` của M4).
4. M **không chủ** (chủ đã rời org, D16) và user là Owner / Admin org (M6b Q2).

Org Owner / Admin **không** đọc nội dung kênh riêng tư mình không ở trong (D2) — điều 2 không có nhánh OrgAdm.

Hiện thực (M6b B2): **một** biểu thức SQL `meetingVisibleTo(viewer)` trong `src/modules/meetings/meeting-visibility.ts` (`EXISTS` lồng nhau), test bằng toàn bộ ma trận người xem. Chi tiết, danh sách theo kênh, và sau này search (M8), báo cáo (M9) đều ghép đúng biểu thức này. **Ngoại lệ có kiểm soát (M11 B5): danh sách meeting theo org** dùng cách viết TƯƠNG ĐƯƠNG — sinh ứng viên từ các luồng keyset có trần (`meeting-list-candidates.ts`: của mình / qua kênh thấy được / không chủ cho OrgAdm), mỗi luồng là một điều 1–4 ở trên — vì ghép `meetingVisibleTo` làm chi phí tỷ lệ tổng số share của org ở mọi request (đo: 29–40 ms → < 4 ms, plan M11). `meetingVisibleTo` vẫn là ĐỊNH NGHĨA: test đối chiếu (`meeting-list-oracle.int-spec.ts`) so `listVisible` với nó trên ma trận người xem × bộ lọc × duyệt hết trang; đổi quy tắc xem thì sửa cả hai, test đối chiếu đỏ nếu lệch. **Tiền điều kiện:** người xem là thành viên org đang query và `orgRole` là vai trò thật — `OrgMemberGuard` bảo đảm; biểu thức không tự kiểm membership.

> **Lớp phòng thủ thứ hai — RLS (M11 B7).** Ngoài các tầng dưới đây, Postgres tự giữ ranh giới tổ chức trên `channels`, `channel_members`, `meetings`, `meeting_shares`, `uploads` (03 §0): request trong `/orgs/:orgId` chỉ đọc / ghi được dòng của đúng org đó, kể cả khi một query trong code quên `org_id`. RLS KHÔNG thay các tầng dưới (vai trò, quyền kênh, điều kiện xem meeting vẫn ở code).

## 4. Cách hiện thực trong NestJS (nhiều tầng)

```
Request
  │
  ├─ 1. JwtAuthGuard (global)            → verify access token + kiểm tra session chưa bị thu hồi (1 query theo PK),
  │                                         gắn req.user = { id, sessionId }
  │                                         @Public() để bỏ qua
  ├─ 2. OrgMemberGuard (route có :orgId) → tải organization_members, gắn req.orgMembership
  │                                         không phải thành viên / :orgId không phải uuid → 404
  │                                         (guard chạy TRƯỚC pipe → tự kiểm tra uuid, đừng để
  │                                          chuỗi rác xuống Postgres thành lỗi 22P02 → 500)
  ├─ 3. ChannelAccessGuard (có :channelId) → tải channel + channel_members, gắn req.channelAccess
  │                                         { channel, channelRole | null, orgRole }
  │                                         không có / đã xoá / riêng tư mà không phải thành viên
  │                                         kênh và không phải OrgAdm → 404
  ├─ 4. Guard quyền theo domain           → hàm policy(ctx) → boolean, sai → 403
  │      (OrgPermissionGuard / ChannelPermissionGuard)
  └─ 5. Service                            → kiểm tra theo đối tượng (target role, archived...)
                                            trong transaction, sau khi đã khoá dòng
```

**Cách gắn (đã chốt ở M2):** mỗi domain có MỘT decorator gộp sẵn guard theo đúng thứ tự, kèm tài liệu Swagger:

```ts
@Patch(':orgId')
@RequireOrgPermission('org.update')   // = SetMetadata + UseGuards(OrgMemberGuard, OrgPermissionGuard)
                                      //   + ApiParam(orgId) + ApiErrorResponses(401, 403, 404)
```

M4 thêm `@RequireChannelPermission('channel.member.add')` theo cùng mẫu. Không làm một `@Require` + `PermissionGuard` chung trong `common/`: bản chung buộc `common/` import policy của từng module (phụ thuộc ngược), và để ngỏ khả năng quên gắn guard thành viên.

- **Guard** trả lời câu hỏi "vai trò này có được làm _loại_ hành động này không". Guard chạy nhanh, không cần biết đối tượng.
- **Service** trả lời câu hỏi "có được làm hành động này trên _đối tượng cụ thể_ này không", vd Admin không được gỡ Owner. Kiểm tra này phải chạy **sau khi khoá dòng**, vì dữ liệu đọc ở guard có thể đã cũ.
- **Policy** là hàm thuần trong `*.policy.ts`. Cả guard và service đều gọi. Unit test bằng bảng `it.each(role × action)`.

```ts
// Phác thảo — sẽ viết ở M2
export const channelPolicy = {
  'channel.member.add': (ctx) => isChannelRoleAtLeast(ctx.channelRole, 'admin'),
  'channel.transfer': (ctx) =>
    ctx.channelRole === 'owner' || isOrgRoleAtLeast(ctx.orgRole, 'admin'),
} satisfies Record<ChannelPermission, (ctx: ChannelAccessContext) => boolean>;
```

> **Bẫy:**
>
> 1. Thứ tự guard: guard global (`APP_GUARD`) luôn chạy trước guard của controller/route.
> 2. Guard không đọc được body đã validate, vì pipe chạy sau guard. Quyền chỉ nên phụ thuộc vào param trên path.
> 3. Đừng cache membership quá lâu. Đổi quyền phải có hiệu lực gần như ngay lập tức. Nếu cache thì xoá cache trong cùng luồng với việc đổi quyền.
