/**
 * Tuần báo cáo = Thứ Hai → Chủ nhật theo giờ VIỆT NAM (D8), nhận dạng bằng ngày Thứ Hai dạng
 * `'YYYY-MM-DD'` (chuỗi, không phải `Date`). Toàn bộ phép tính là số học trên NGÀY LỊCH: không cộng
 * mili giây (ngày chuyển giờ mùa hè dài 23/25 giờ) và không phụ thuộc timezone của máy / session DB.
 */
export const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Ngày lịch (`YYYY-MM-DD`) của thời điểm `at` tại múi giờ `timeZone`. */
export function localDate(at: Date, timeZone: string = REPORT_TIME_ZONE): string {
  // 'en-CA' in ngày dạng ISO (YYYY-MM-DD); `timeZone` quyết định NGÀY nào.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** `YYYY-MM-DD` → mili giây UTC của nửa đêm ngày đó; `undefined` nếu không phải ngày thật (30/2…). */
function utcMillis(date: string): number | undefined {
  const m = DATE_RE.exec(date);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Date.UTC "cuốn" ngày vượt tháng (2026-02-30 → 03-02) → so lại để từ chối.
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d
    ? ms
    : undefined;
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Đúng định dạng `YYYY-MM-DD` và là ngày có thật (không phải 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  return utcMillis(value) !== undefined;
}

/** Số ngày từ `from` tới `to` (`to - from`; hai ngày liền kề = 1). Cả hai phải là ngày thật. */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [utcMillis(from), utcMillis(to)];
  if (a === undefined || b === undefined) throw new Error(`Ngày không hợp lệ: ${from} / ${to}`);
  return Math.round((b - a) / MS_PER_DAY);
}

export function addDays(date: string, days: number): string {
  const ms = utcMillis(date);
  if (ms === undefined) throw new Error(`Ngày không hợp lệ: ${date}`);
  return format(ms + days * MS_PER_DAY);
}

/** Thứ Hai của tuần chứa `date` (Thứ Hai là chính nó, Chủ nhật lùi 6 ngày). */
export function mondayOf(date: string): string {
  const ms = utcMillis(date);
  if (ms === undefined) throw new Error(`Ngày không hợp lệ: ${date}`);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7; // getUTCDay: CN = 0
  return format(ms - sinceMonday * MS_PER_DAY);
}

/** Đúng định dạng, là ngày thật và là Thứ Hai — điều kiện của `weekStart` nhận từ ngoài (API, CLI). */
export function isWeekStart(value: string): boolean {
  const ms = utcMillis(value);
  return ms !== undefined && new Date(ms).getUTCDay() === 1;
}

/**
 * Tuần báo cáo mà một lần tick đáng ra phải xử lý: TUẦN TRƯỚC tuần chứa thời điểm `firedAt` (giờ VN).
 * Tính từ `firedAt` của lịch (không phải `now()` lúc job chạy): tick bị trễ — worker sập, hàng đợi
 * dồn — vẫn ra đúng tuần. (Trễ quá sang Thứ Hai kế tiếp thì ra tuần khác: đó là việc của backfill.)
 */
export function previousWeekStart(firedAt: Date, timeZone: string = REPORT_TIME_ZONE): string {
  return addDays(mondayOf(localDate(firedAt, timeZone)), -7);
}
