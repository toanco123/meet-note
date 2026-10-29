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

/** Độ chi tiết của chuỗi thời gian: từng ngày VN, hoặc từng tuần bắt đầu Thứ Hai (cùng quy ước báo cáo tuần). */
export type DashboardGranularity = 'day' | 'week';

/** Khoảng đã chuẩn hoá: ngày VN `YYYY-MM-DD`, gồm cả hai đầu. */
export interface DashboardRange {
  from: string;
  to: string;
}

/** Một điểm của chuỗi thời gian (số cộng được). `period` là ngày, hoặc Thứ Hai của tuần. */
export interface DashboardPoint {
  period: string;
  meetings: number;
  completed: number;
  failed: number;
  recordedMinutes: number;
  transcribedMinutes: number;
}

export interface DashboardTotals {
  meetings: number;
  completed: number;
  failed: number;
  /** `failed / (completed + failed)` trong 0..1; `null` khi chưa có meeting nào kết thúc (không chia cho 0). */
  failureRate: number | null;
  recordedMinutes: number;
  transcribedMinutes: number;
}

/** Toàn bộ số liệu dashboard của một tổ chức (M17). KHÔNG có tiêu đề / nội dung / tên người. */
export interface DashboardOverview {
  range: DashboardRange;
  granularity: DashboardGranularity;
  totals: DashboardTotals;
  series: DashboardPoint[];
  members: MemberCounts;
  storage: StorageUsage;
  topChannels: TopChannel[];
  actionItems: ActionItemCounts;
  /** Lần tính rollup gần nhất của các ngày trong khoảng; `null` nếu chưa ngày nào được tính. */
  computedAt: string | null;
}
