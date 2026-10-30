import { Errors } from '../../common/errors/errors.js';
import type { OrgDailyStatsRow } from '../../infra/database/schema/index.js';
import { addDays, daysBetween, isCalendarDate, mondayOf } from '../reports/report-week.js';
import type {
  DashboardGranularity,
  DashboardPoint,
  DashboardRange,
  DashboardTotals,
} from './dashboard.types.js';

/** Số ngày tối đa của MỘT khoảng, và cũng là cửa sổ "xem được" tính lùi từ hôm nay (job đêm phủ đủ cửa sổ này). */
export const MAX_RANGE_DAYS = 92;
/** Khoảng mặc định khi không truyền `from` / `to`: 30 ngày gần nhất tới hôm nay. */
export const DEFAULT_RANGE_DAYS = 30;

const MS_PER_MINUTE = 60_000;

/** Mili giây → phút nguyên (làm tròn). Tổng tính trên mili giây RỒI mới đổi, không cộng các số đã làm tròn. */
export const toMinutes = (ms: number): number => Math.round(ms / MS_PER_MINUTE);

/**
 * Chuẩn hoá khoảng người dùng gửi lên (`today` = hôm nay giờ VN). Mặc định: 30 ngày gần nhất. Từ chối
 * (400) khi: không phải ngày thật, `from > to`, quá 92 ngày, hoặc `from` nằm ngoài cửa sổ 92 ngày gần nhất
 * (rollup chỉ đảm bảo phủ cửa sổ đó). `to` ở tương lai được phép — chuỗi vẫn điền đủ 0.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
): DashboardRange {
  const end = to ?? today;
  const start = from ?? addDays(end, -(DEFAULT_RANGE_DAYS - 1));
  const problems: Array<{ field: string; message: string }> = [];
  if (!isCalendarDate(start))
    problems.push({ field: 'from', message: 'Phải là ngày thật dạng YYYY-MM-DD.' });
  if (!isCalendarDate(end))
    problems.push({ field: 'to', message: 'Phải là ngày thật dạng YYYY-MM-DD.' });
  if (problems.length > 0) throw Errors.common.validationFailed(problems);

  if (start > end) {
    throw Errors.common.validationFailed([
      { field: 'from', message: '`from` không được sau `to`.' },
    ]);
  }
  if (daysBetween(start, end) + 1 > MAX_RANGE_DAYS) {
    throw Errors.common.validationFailed([
      { field: 'to', message: `Khoảng xem tối đa ${MAX_RANGE_DAYS} ngày.` },
    ]);
  }
  if (daysBetween(start, today) >= MAX_RANGE_DAYS) {
    throw Errors.common.validationFailed([
      { field: 'from', message: `Chỉ xem được ${MAX_RANGE_DAYS} ngày gần nhất.` },
    ]);
  }
  return { from: start, to: end };
}

/** Mọi ngày trong khoảng (gồm hai đầu), tăng dần. */
export function enumerateDays(range: DashboardRange): string[] {
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * Chuỗi thời gian ĐIỀN ĐỦ NGÀY: ngày không có dòng rollup là 0 (không bỏ trống — biểu đồ cần trục liên
 * tục). `week` gom theo Thứ Hai; tuần đầu / cuối chỉ gồm phần nằm trong khoảng. Mili giây được CỘNG
 * trước, đổi sang phút sau, để tổng tuần khớp tổng ngày.
 */
export function buildSeries(
  rows: OrgDailyStatsRow[],
  range: DashboardRange,
  granularity: DashboardGranularity,
): DashboardPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const buckets = new Map<string, Bucket>();
  for (const day of enumerateDays(range)) {
    const key = granularity === 'week' ? mondayOf(day) : day;
    const bucket = buckets.get(key) ?? emptyBucket();
    const row = byDay.get(day);
    if (row) {
      bucket.meetings += row.meetingsTotal;
      bucket.completed += row.meetingsCompleted;
      bucket.failed += row.meetingsFailed;
      bucket.recordedMs += row.recordedMs;
      bucket.transcribedMs += row.transcribedMs;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([period, b]) => ({
    period,
    meetings: b.meetings,
    completed: b.completed,
    failed: b.failed,
    recordedMinutes: toMinutes(b.recordedMs),
    transcribedMinutes: toMinutes(b.transcribedMs),
  }));
}

/** Tổng cả khoảng, tính từ dòng rollup (không từ chuỗi đã làm tròn). */
export function buildTotals(rows: OrgDailyStatsRow[]): DashboardTotals {
  const sum = emptyBucket();
  for (const r of rows) {
    sum.meetings += r.meetingsTotal;
    sum.completed += r.meetingsCompleted;
    sum.failed += r.meetingsFailed;
    sum.recordedMs += r.recordedMs;
    sum.transcribedMs += r.transcribedMs;
  }
  return {
    meetings: sum.meetings,
    completed: sum.completed,
    failed: sum.failed,
    failureRate: failureRate(sum.completed, sum.failed),
    recordedMinutes: toMinutes(sum.recordedMs),
    transcribedMinutes: toMinutes(sum.transcribedMs),
  };
}

/**
 * Tỉ lệ pipeline lỗi = `failed / (completed + failed)`, làm tròn 4 chữ số. Chỉ tính meeting ĐÃ KẾT THÚC:
 * meeting đang xử lý không làm tỉ lệ nhảy. Chưa có meeting nào kết thúc → `null`, không phải 0 (0 nghĩa là
 * "không lỗi cái nào" — khác "chưa có gì để đo").
 */
export function failureRate(completed: number, failed: number): number | null {
  const ended = completed + failed;
  return ended === 0 ? null : Math.round((failed / ended) * 10_000) / 10_000;
}

interface Bucket {
  meetings: number;
  completed: number;
  failed: number;
  recordedMs: number;
  transcribedMs: number;
}
const emptyBucket = (): Bucket => ({
  meetings: 0,
  completed: 0,
  failed: 0,
  recordedMs: 0,
  transcribedMs: 0,
});
