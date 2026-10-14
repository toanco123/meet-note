/** Kiểu viết tay của module kênh. */

import type {
  ChannelRoleValue,
  ChannelVisibility,
  OrgRoleValue,
} from '../../infra/database/schema/index.js';

// ── Policy + guard ────────────────────────────────────────────────────────────

/** Đầu vào của policy kênh (hàm thuần): ai đang gọi, với kênh nào. */
export interface ChannelAccessContext {
  /** null = KHÔNG phải thành viên kênh (thành viên org xem kênh công khai, hoặc OrgAdm). */
  channelRole: ChannelRoleValue | null;
  orgRole: OrgRoleValue;
  channel: { visibility: ChannelVisibility };
}

/** Quyết định của policy; `channel-decisions.ts` đổi thành lỗi HTTP. */
export type ChannelDecision = 'ok' | 'forbidden' | 'archived';

/** Vai trò cấp được khi THÊM người vào kênh. Chủ kênh không bao giờ cấp qua đây. */
export type GrantableChannelRole = Exclude<ChannelRoleValue, 'owner'>;

/** Do `ChannelAccessGuard` gắn vào `req.channelAccess`. Đủ để gọi policy, KHÔNG đủ để hiển thị. */
export interface ChannelAccess extends ChannelAccessContext {
  orgId: string;
  userId: string;
  channel: { id: string; visibility: ChannelVisibility; archivedAt: Date | null };
}

// `req.channelAccess` có kiểu ở mọi nơi (declaration merging).
declare global {
  // oxlint-disable-next-line typescript/no-namespace -- cú pháp bắt buộc để mở rộng namespace Express
  namespace Express {
    interface Request {
      channelAccess?: ChannelAccess;
    }
  }
}

// ── Repository: kênh ──────────────────────────────────────────────────────────

/** Những gì guard cần để quyết định quyền — đọc ở MỌI request có `:channelId`, nên giữ gọn. */
export interface ChannelAccessRow {
  id: string;
  visibility: ChannelVisibility;
  archivedAt: Date | null;
  /** null = người gọi không phải thành viên kênh. */
  channelRole: ChannelRoleValue | null;
}

export interface ChannelDetailRow {
  id: string;
  name: string;
  description: string | null;
  visibility: ChannelVisibility;
  weeklyReportEnabled: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  memberCount: number;
  myRole: ChannelRoleValue | null;
  /** Khoá cursor = `lower(name)` do POSTGRES tính (xem `ChannelsRepository.list`). */
  nameKey: string;
}

/** Các field sửa được qua `PATCH .../channels/:channelId`. */
export interface ChannelPatch {
  name?: string;
  description?: string | null;
  visibility?: ChannelVisibility;
  weeklyReportEnabled?: boolean;
}

/** Trạng thái kênh đọc được SAU khi khoá — đủ cho audit `before` và cho policy. */
export interface LockedChannel {
  name: string;
  description: string | null;
  visibility: ChannelVisibility;
  weeklyReportEnabled: boolean;
  archivedAt: Date | null;
}

export interface ListChannelsParams {
  orgId: string;
  userId: string;
  /** OrgAdm thấy mọi kênh (metadata); thành viên thường chỉ thấy kênh công khai + kênh mình tham gia. */
  seeAll: boolean;
  q?: string;
  visibility?: ChannelVisibility;
  archived: boolean;
  /** `lower(name)` của dòng cuối trang trước. */
  after?: string;
  limit: number;
}

// ── Repository: thành viên kênh ───────────────────────────────────────────────

export interface ChannelMemberListRow {
  userId: string;
  displayName: string;
  email: string;
  role: ChannelRoleValue;
  joinedAt: Date;
  /** Khoá cursor (ISO micro giây do DB sinh). */
  joinedAtKey: string;
}

export interface ListChannelMembersParams {
  channelId: string;
  q?: string;
  role?: ChannelRoleValue;
  /** [joinedAtKey, userId] của dòng cuối trang trước. */
  after?: [string, string];
  limit: number;
}
