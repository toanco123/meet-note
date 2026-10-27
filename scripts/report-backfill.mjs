// Chạy BÙ báo cáo tuần (M9 B5): xếp một job `weekly-report.tick` cho tuần chỉ định. Dùng khi tick theo
// lịch bị lỡ (Redis sập đúng 08:00 Thứ Hai, worker không chạy…). Idempotent — chạy thừa an toàn:
// báo cáo đã có không bị tạo lại, job trùng bị BullMQ bỏ qua.
//
// Chạy: `pnpm report:backfill --week 2026-10-05`   (Thứ Hai của tuần cần chạy bù, giờ VN)
// Biến môi trường như worker: REDIS_URL (bắt buộc), QUEUE_PREFIX (mặc định `meetnote`).
// File .mjs chạy trên `dist/` (code đã build), không qua typecheck: công cụ vận hành.
import { Queue } from 'bullmq';
import { isWeekStart } from '../dist/modules/reports/report-week.js';

const flag = process.argv.indexOf('--week');
const week = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!week || !isWeekStart(week)) {
  console.error('Dùng: pnpm report:backfill --week YYYY-MM-DD   (phải là Thứ Hai, giờ VN)');
  process.exit(1);
}
if (!process.env.REDIS_URL) {
  console.error('Thiếu REDIS_URL');
  process.exit(1);
}

// Công cụ vận hành phải THẤT BẠI NHANH: ioredis mặc định thử kết nối lại vô hạn (đúng cho server,
// sai cho một lệnh chạy tay — lần đầu thử với Redis tắt: treo mãi và in lỗi liên tục).
const queue = new Queue('default', {
  connection: {
    url: process.env.REDIS_URL,
    retryStrategy: () => null, // không kết nối lại
    connectTimeout: 5_000,
    enableOfflineQueue: false, // lệnh gửi khi chưa kết nối lỗi ngay, không xếp hàng chờ
  },
  prefix: process.env.QUEUE_PREFIX ?? 'meetnote',
});
queue.on('error', () => undefined); // lỗi kết nối được báo qua `add()` bên dưới, không in hai lần
try {
  // jobId theo tuần + lần chạy: chạy bù LẠI cùng tuần (vd tick đầu lỗi giữa chừng) phải ra job mới —
  // jobId cố định thì job đã completed còn giữ 24 giờ sẽ nuốt lần sau.
  const job = await queue.add(
    'weekly-report.tick',
    { weekStart: week, requestId: `backfill-${Date.now()}` },
    {
      jobId: `weekly-report.backfill.${week}.${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    },
  );
  console.log(
    `Đã xếp tick bù cho tuần ${week} (job ${job.id}). Worker sẽ tạo báo cáo cho các kênh chưa có.`,
  );
} catch (error) {
  // AggregateError (ECONNREFUSED…) có `message` rỗng → in cả tên và mã lỗi.
  const detail =
    error instanceof Error
      ? [error.name, error.code, error.message].filter(Boolean).join(' ')
      : String(error);
  console.error(`Không xếp được tick bù: ${detail}`);
  console.error('Kiểm tra REDIS_URL và Redis đang chạy.');
  process.exitCode = 1;
} finally {
  await queue.close().catch(() => undefined);
}
