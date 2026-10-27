import type { ActionItemRow, ActionItemStatus } from '../../infra/database/schema/index.js';
import type { MeetingViewer } from '../meetings/meetings.types.js';

/** Thành viên org (id + tên hiển thị) — ứng viên để map tên người phụ trách. */
export interface OrgMemberName {
  userId: string;
  displayName: string;
}

/** Việc AI trích ra, đã map người phụ trách (nếu map được) — đầu vào của `insertAiIfAbsent`. */
export interface NewAiActionItem {
  /** Vị trí trong `actionItems` của tóm tắt: khoá tự nhiên, cùng meeting + cùng vị trí = cùng việc. */
  sourceIndex: number;
  task: string;
  ownerName: string | null;
  assigneeId: string | null;
  dueText: string | null;
  dueDate: string | null;
}

/** Sửa một phần. Field không có mặt = không đổi; `null` ở `assigneeId` / `dueDate` = bỏ giá trị. */
export interface ActionItemPatch {
  task?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  status?: ActionItemStatus;
}

/** Kết quả sửa bằng khoá lạc quan — cùng hình dạng với `EditSegmentOutcome` (M13). */
export type UpdateActionItemOutcome<Row> =
  | { kind: 'updated'; item: Row }
  | { kind: 'not_found' }
  | { kind: 'version_mismatch'; currentVersion: number };

/** Một việc kèm tên người được giao và tiêu đề meeting — thứ API trả ra, không phải row thô. */
export interface ActionItemListRow {
  item: ActionItemRow;
  assigneeName: string | null;
  meetingTitle: string;
}

/** Tham số danh sách "việc xuyên meeting" (Q8). */
export interface ListVisibleActionItemsParams {
  orgId: string;
  viewer: MeetingViewer;
  /** Chỉ việc được giao cho `viewer.userId`. */
  assignedToViewer: boolean;
  status: ActionItemStatus;
  /**
   * Ngày hôm nay theo giờ VN ('YYYY-MM-DD'); có mặt ⇒ chỉ việc `open` có `due_date` TRƯỚC ngày này
   * (kết hợp với `status` khác `open` thì rỗng).
   */
  overdueBefore?: string;
  channelId?: string;
  /** Khoá cursor: `dueDate` null = việc không hạn (xếp cuối). */
  after?: { dueDate: string | null; id: string };
  limit: number;
}
