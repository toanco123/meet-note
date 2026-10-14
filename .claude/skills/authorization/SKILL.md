---
name: authorization
description: Hiện thực và kiểm thử phân quyền nhiều tầng của MeetNote — JwtAuthGuard global với @Public, OrgMemberGuard, ChannelAccessGuard, decorator @Require gắn với hàm policy thuần, kiểm tra theo đối tượng trong service sau khi khoá dòng, trả 404 thay vì 403 cho tài nguyên ẩn, test ma trận quyền dạng bảng. Dùng khi thêm/sửa guard, decorator, policy, vai trò tổ chức (owner/admin/member) hoặc vai trò kênh (owner/admin/member/guest), khi một endpoint cần giới hạn ai được gọi, hoặc khi người dùng hỏi "ai được làm X", "phân quyền", "permission", "role", "sao bị 403/404". Use for any access-control logic in this repo.
---

# Phân quyền nhiều tầng

**Ma trận quyền là nguồn sự thật: `docs/design/04-authorization.md`.** Đổi quyền thì sửa ma trận, policy và bảng test e2e **cùng lúc**. Ba thứ này phải luôn khớp nhau.

## Các tầng và vị trí code

| Tầng                                                                                                                                                         | Trả lời câu hỏi                                                                                                               | File (mốc tạo)                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `JwtAuthGuard` (`APP_GUARD`) + `@Public()`                                                                                                                   | Có đăng nhập không? Kiểm tra phiên còn sống. Gắn `req.user = { id, sessionId }`                                               | guard: `src/modules/auth/guards/`; `@Public`, `@CurrentUser`, `AuthUser`: `src/common/auth/` (M1) |
| `@CurrentUser()`                                                                                                                                             | Lấy user trong controller                                                                                                     | `src/common/auth/current-user.decorator.ts` (M1)                                                  |
| `OrgMemberGuard`                                                                                                                                             | Có phải thành viên org `:orgId` không? Gắn `req.orgMembership`. Không phải thành viên → **404**                               | `src/modules/organizations/` (M2)                                                                 |
| `ChannelAccessGuard`                                                                                                                                         | Tải kênh + vai trò trong kênh, gắn `req.channelAccess = { channel, channelRole \| null, orgRole }`. Không thấy kênh → **404** | `src/modules/channels/` (M4)                                                                      |
| `@RequireOrgPermission('<org.*>')` (M2), sau này `@RequireChannelPermission` (M4): gộp `SetMetadata` + `UseGuards(member guard, permission guard)` + Swagger | Vai trò này có được làm **loại** hành động này không?                                                                         | `src/modules/organizations/guards/` (M2)                                                          |
| Policy `*.policy.ts`                                                                                                                                         | Hàm thuần `(ctx) → boolean`. Guard và service cùng gọi                                                                        | trong từng module                                                                                 |
| Service                                                                                                                                                      | Có được làm hành động này trên **đối tượng cụ thể** không? (Admin không gỡ được Owner, kênh đã lưu trữ…)                      | trong từng module, **sau khi khoá dòng**                                                          |

Thứ tự chạy: guard global → guard của controller → guard của method → pipe (validate) → handler.

## Mẫu policy

```ts
export const ChannelRole = {
  Owner: 'owner',
  Admin: 'admin',
  Member: 'member',
  Guest: 'guest',
} as const;
export type ChannelRole = (typeof ChannelRole)[keyof typeof ChannelRole];

const RANK: Record<ChannelRole, number> = { owner: 3, admin: 2, member: 1, guest: 0 };
export const atLeast = (role: ChannelRole | null, min: ChannelRole) =>
  role !== null && RANK[role] >= RANK[min];

export interface ChannelAccessContext {
  channelRole: ChannelRole | null; // null = không phải thành viên kênh
  orgRole: OrgRole;
  channel: { visibility: 'public' | 'private'; archivedAt: Date | null };
}

export const channelPolicy = {
  'channel.read': (c) => c.channelRole !== null || c.channel.visibility === 'public',
  'channel.member.add': (c) => atLeast(c.channelRole, 'admin'),
  'channel.ownership.transfer': (c) => c.channelRole === 'owner' || isOrgAdminOrOwner(c.orgRole),
  // ...
} satisfies Record<string, (ctx: ChannelAccessContext) => boolean>;

export type ChannelPermission = keyof typeof channelPolicy;
```

- `satisfies` giúp TS kiểm tra đủ chữ ký mà vẫn giữ union key cho `@RequireOrgPermission(...)`.
- Kiểm tra theo đối tượng (vai trò của _người bị tác động_) viết thành hàm riêng, ví dụ `canRemoveMember(actorRole, targetRole)`, và gọi trong service.

## Quy tắc

1. **Guard chỉ dựa vào param trên path** (`:orgId`, `:channelId`) và user. Guard chạy **trước** pipe nên không thấy body đã validate.
2. **Service kiểm tra lại sau khi khoá dòng** (skill `db-transactions`). Dữ liệu guard đọc có thể đã cũ khi transaction bắt đầu.
3. **404 vs 403:**
   - Người gọi **không được biết** tài nguyên tồn tại (kênh riêng tư, org không phải thành viên) → 404.
   - Thấy được nhưng không đủ quyền với hành động → 403.
   - Kênh đã lưu trữ mà gọi hành động ghi → 409 `CHANNEL_ARCHIVED`.
4. **Không nhét role vào JWT.** Membership được tải mỗi request, để đổi quyền có hiệu lực ngay. Muốn cache (Redis, vài giây) thì xoá cache trong cùng luồng đổi quyền.
5. **Quyền xem meeting** đi qua **một** điều kiện SQL dùng chung (`docs/design/04-authorization.md` §3) cho danh sách, chi tiết, search và báo cáo. Không được mỗi chỗ lọc một kiểu.
6. `@Public()` được `JwtAuthGuard` đọc bằng `reflector.getAllAndOverride(IS_PUBLIC, [context.getHandler(), context.getClass()])`.
7. Swagger: route cần đăng nhập có `@ApiBearerAuth()`, và khai báo 401/403/404 bằng `@ApiErrorResponses`.

## Test

- **Unit:** `it.each` trên **toàn bộ** ma trận của policy:
  ```ts
  it.each([
    ['owner', 'channel.member.add', true],
    ['admin', 'channel.member.add', true],
    ['member', 'channel.member.add', false],
    ['guest', 'channel.member.add', false],
  ] as const)('%s → %s → %s', (role, perm, expected) => {
    expect(channelPolicy[perm](ctx({ channelRole: role }))).toBe(expected);
  });
  ```
- **E2E:** bảng `[actor, method + path, expectedStatus]` chạy qua HTTP thật. Có ca "người ngoài + kênh riêng tư → 404" và "kênh lưu trữ → 409".
- **Concurrency:** đổi quyền song song với thao tác dùng quyền đó. Ví dụ gỡ Admin cùng lúc Admin đó gỡ người khác: kết quả phải nhất quán.

## Bẫy

- Guard đăng ký bằng `APP_GUARD` luôn chạy trước guard gắn bằng `@UseGuards`. Guard sau cần `req.user` thì phải chắc guard trước đã gắn.
- Inject `Reflector` hoặc service vào guard: guard phải nằm trong module có provider đó (hoặc module global).
- Lỗi phân quyền lấy từ catalog `Errors` (`Errors.org.forbidden()`, `Errors.channel.notFound()`…), không ném `ForbiddenException` trần. Policy chỉ trả quyết định; hàm `assert…Decision` của module đổi quyết định thành lỗi.
