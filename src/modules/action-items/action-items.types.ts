import type { ActionItemStatus } from '../../infra/database/schema/index.js';

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
