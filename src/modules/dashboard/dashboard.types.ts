/** Thành viên tổ chức: tổng và số người "hoạt động" trong khoảng (M17). */
export interface MemberCounts {
  total: number;
  active: number;
}

/** Dung lượng hiện tại (ảnh chụp lúc gọi, không phải chuỗi thời gian). */
export interface StorageUsage {
  bytes: number;
  meetings: number;
}

/** Một kênh trong top kênh: chỉ id, tên và số meeting — không có tiêu đề meeting. */
export interface TopChannel {
  channelId: string;
  name: string;
  meetings: number;
}

/** Số việc (chỉ số đếm, không có nội dung / tên người). */
export interface ActionItemCounts {
  open: number;
  overdue: number;
  doneInRange: number;
}
