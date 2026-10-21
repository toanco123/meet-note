import type {
  ChannelRoleValue,
  MeetingRow,
  MeetingStatus,
  OrgRoleValue,
} from '../../infra/database/schema/index.js';

/** Người đang xem meeting: đủ để quyết định quyền xem (04 §3) mà không cần đọc thêm gì. */
export interface MeetingViewer {
  userId: string;
  /** Vai trò trong org trên path (OrgMemberGuard đã tải) — Owner / Admin quản lý meeting không chủ. */
  orgRole: OrgRoleValue;
}

export interface ListVisibleMeetingsParams {
  orgId: string;
  viewer: MeetingViewer;
  /** Chỉ meeting share vào kênh này — service đã kiểm người xem đọc được nội dung kênh. */
  channelId?: string;
  status?: MeetingStatus;
  /** `recorded_at >= from`. */
  from?: Date;
  /** `recorded_at < to`. */
  to?: Date;
  /** Khoá cursor của dòng cuối trang trước: `(recorded_at, id)`, thời gian dạng text đủ micro giây. */
  after?: { recordedAt: string; id: string };
  limit: number;
}

/** Dòng danh sách: kèm khoá cursor `recorded_at` do Postgres in (không qua JS `Date`). */
export type MeetingListRow = MeetingRow & { recordedAtKey: string };

/** Kênh chứa meeting mà người xem thấy được (metadata). */
export interface MeetingChannelRef {
  id: string;
  name: string;
}

/** Đủ để quyết định ai gỡ được meeting khỏi kênh — đọc từ các dòng VỪA KHOÁ. */
export interface UnshareContext {
  channelRole: ChannelRoleValue | null;
  orgRole: OrgRoleValue;
  channelArchived: boolean;
  isMeetingOwner: boolean;
  meetingOwnerless: boolean;
}
