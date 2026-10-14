# 04 — Phân quyền

## 1. Ma trận cấp tổ chức

O = Owner, A = Admin, M = Member. ✓ = được, ✗ = không, ghi chú = có điều kiện.

| Hành động                                              |                         O                          |       A       |                           M                           |
| ------------------------------------------------------ | :------------------------------------------------: | :-----------: | :---------------------------------------------------: |
| Xem thông tin org, danh sách thành viên                |                         ✓                          |       ✓       |                           ✓                           |
| Sửa thông tin org, bật/tắt `require_join_approval`     |                         ✓                          |       ✓       |                           ✗                           |
| Xoá org                                                |                         ✓                          |       ✗       |                           ✗                           |
| Tạo / thu hồi link mời (role member)                   |                         ✓                          |       ✓       |                           ✗                           |
| Tạo link mời với role admin                            |                         ✓                          |       ✗       |                           ✗                           |
| Duyệt / từ chối yêu cầu vào org                        |                         ✓                          |       ✓       |                           ✗                           |
| Đổi vai trò member ↔ admin                             |                         ✓                          |       ✗       |                           ✗                           |
| Gỡ thành viên                                          |                 ✓ (trừ chính mình)                 | chỉ gỡ Member |                           ✗                           |
| Chuyển quyền sở hữu                                    | ✓ (cho member/admin hiện có; owner cũ thành admin) |       ✗       |                           ✗                           |
| Rời org                                                |              phải chuyển sở hữu trước              |       ✓       |                           ✓                           |
| Tạo kênh                                               |                         ✓                          |       ✓       |                           ✓                           |
| Xem danh sách mọi kênh, kể cả riêng tư (chỉ metadata)  |                         ✓                          |       ✓       | chỉ kênh công khai + kênh riêng tư mình là thành viên |
| Quản trị bất kỳ kênh (lưu trữ, xoá, chỉ định chủ kênh) |                         ✓                          |       ✓       |                           ✗                           |
| Xem audit log                                          |                         ✓                          |       ✓       |                           ✗                           |

Quy tắc chung: **không ai được tác động lên người có vai trò ≥ mình**, trừ Owner.

Cấp vai trò (tạo link mời, duyệt yêu cầu tham gia) theo `canGrantRole(actor, role)` (M3): Owner cấp được admin/member, Admin chỉ cấp được member. Tức **không ai cấp được vai trò ngang hoặc cao hơn mình**, trừ Owner. Đây là kiểm tra theo _đối tượng_, nên nằm trong service/policy chứ không chỉ ở guard.

## 2. Ma trận cấp kênh

CO = Chủ kênh, CA = QTV kênh, CM = Thành viên kênh, G = Khách.
**Ngoài (pub)** = thành viên org chưa join kênh công khai.
**OrgAdm** = Org Owner/Admin không phải thành viên kênh.

| Hành động                                    |          CO           |        CA        |          CM          |  G  | Ngoài (pub) |              OrgAdm               |
| -------------------------------------------- | :-------------------: | :--------------: | :------------------: | :-: | :---------: | :-------------------------------: |
| Xem metadata kênh                            |           ✓           |        ✓         |          ✓           |  ✓  |      ✓      |                 ✓                 |
| Xem meeting / transcript / tóm tắt / báo cáo |           ✓           |        ✓         |          ✓           |  ✓  |      ✓      |      chỉ khi kênh công khai       |
| Xem danh sách thành viên                     |           ✓           |        ✓         |          ✓           |  ✗  |      ✓      |                 ✓                 |
| Tự join                                      |           –           |        –         |          –           |  –  |      ✓      |       ✓ nếu kênh công khai        |
| Rời kênh                                     | phải chuyển chủ trước |        ✓         |          ✓           |  ✓  |      –      |                 –                 |
| Chia sẻ meeting (của chính mình) vào kênh    |           ✓           |        ✓         |          ✓           |  ✗  |      ✗      |                 ✗                 |
| Gỡ meeting khỏi kênh                         |           ✓           |        ✓         | chỉ meeting của mình |  ✗  |      ✗      |                 ✗                 |
| Thêm thành viên (role member/guest)          |           ✓           |        ✓         |          ✗           |  ✗  |      ✗      |                 ✗                 |
| Thêm/nâng lên admin                          |           ✓           |        ✗         |          ✗           |  ✗  |      ✗      |                 ✗                 |
| Đổi vai trò member ↔ guest                   |           ✓           |        ✓         |          ✗           |  ✗  |      ✗      |                 ✗                 |
| Gỡ thành viên                                |     ✓ (trừ mình)      | chỉ member/guest |          ✗           |  ✗  |      ✗      |                 ✗                 |
| Chuyển chủ kênh                              |           ✓           |        ✗         |          ✗           |  ✗  |      ✗      | ✓ (override, vd chủ kênh rời org) |
| Sửa tên/mô tả/visibility, bật/tắt báo cáo    |           ✓           |        ✓         |          ✗           |  ✗  |      ✗      |                 ✗                 |
| Lưu trữ / bỏ lưu trữ                         |           ✓           |        ✗         |          ✗           |  ✗  |      ✗      |                 ✓                 |
| Xoá kênh                                     |           ✓           |        ✗         |          ✗           |  ✗  |      ✗      |                 ✓                 |
| Tạo lại báo cáo tuần                         |           ✓           |        ✓         |          ✗           |  ✗  |      ✗      |                 ✗                 |
| Nhận thông báo báo cáo tuần                  |           ✓           |        ✓         |          ✓           |  ✗  |      ✗      |                 ✗                 |

**Kênh đã lưu trữ:** mọi hành động ghi đều trả `409 CHANNEL_ARCHIVED`, trừ bỏ lưu trữ và xoá.
**Kênh riêng tư mà người gọi không có quyền thấy:** trả `404`, không trả `403`, để không lộ việc kênh tồn tại.

## 3. Quyền xem meeting

User được xem meeting M khi thoả **một** trong các điều kiện:

1. User là `owner_id` của M.
2. M được share vào kênh C, và user là thành viên C (bất kỳ vai trò).
3. M được share vào kênh **công khai**, chưa lưu trữ/xoá, và user là thành viên org.

Viết thành một hàm SQL dùng lại được (`visible_meetings(user_id, org_id)` hoặc một subquery `EXISTS` dùng chung trong repository). Danh sách, search và báo cáo đều đi qua cùng một điều kiện, để không có chỗ nào lọc quyền khác chỗ nào.

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
