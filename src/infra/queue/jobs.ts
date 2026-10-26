/** Tên job: `domain.action`. Một queue có nhiều tên job; processor (M6) `switch (job.name)`. */
export const JobName = {
  MeetingPreprocess: 'meeting.preprocess',
  MeetingTranscribe: 'meeting.transcribe',
  MeetingSummarize: 'meeting.summarize',
  NotificationFanout: 'notification.fanout',
  // Việc định kỳ (M6 B8) — Job Scheduler của worker tạo, payload rỗng.
  MeetingSweepStuck: 'meeting.sweep-stuck',
  UploadCleanup: 'upload.cleanup',
  IdempotencyCleanup: 'idempotency.cleanup',
  ChannelPurge: 'channel.purge',
  // Báo cáo tuần (M9): tick theo lịch fan-out ra một job `generate` cho mỗi kênh.
  WeeklyReportTick: 'weekly-report.tick',
  WeeklyReportGenerate: 'weekly-report.generate',
} as const;
export type JobName = (typeof JobName)[keyof typeof JobName];

/**
 * `jobId = <tên-job>.<id>.a<lần>`. BullMQ BỎ QUA `add()` nếu jobId đã tồn tại (kể cả job đã
 * completed / failed còn giữ lại) → enqueue lại an toàn. Có tên bước để các bước dùng chung queue
 * không nuốt nhau; có lần chạy để retry thủ công (M6) không bị nuốt. BullMQ cấm dấu `:` trong id.
 */
export function meetingJobId(job: JobName, meetingId: string, attempt: number): string {
  return `${job}.${meetingId}.a${attempt}`;
}

/**
 * Quét kẹt (M6 B8) enqueue LẠI một bước: KHÔNG dùng lại `…a<lần>` — job cũ đã completed / failed còn
 * được giữ (24 giờ / 7 ngày) nên `add()` cùng id bị NUỐT lặng lẽ (bài học B5). Hậu tố `.r<version>`
 * (`updated_at` của meeting, micro giây): meeting vẫn kẹt y nguyên → cùng id → các lần quét sau không
 * nhân đôi job còn đang chờ; meeting đã đổi (job đã nhận việc rồi lại kẹt) → id mới.
 */
export function meetingRequeueJobId(
  job: JobName,
  meetingId: string,
  attempt: number,
  version: string,
): string {
  return `${meetingJobId(job, meetingId, attempt)}.r${version}`;
}

/**
 * `notification.fanout.<dedupe_key>.<lần share tính bằng ms>`. Có mốc share: share → gỡ → share lại
 * trong lúc job cũ còn được giữ (24h) vẫn ra job MỚI (người mới vào kênh được báo); còn người đã
 * nhận thì `dedupe_key` trong DB chặn trùng. Gọi lại share (cùng dòng, cùng mốc) → cùng jobId → bỏ qua.
 */
export function notificationFanoutJobId(dedupeKey: string, at: Date): string {
  return `${JobName.NotificationFanout}.${dedupeKey}.${at.getTime()}`;
}

/**
 * `weekly-report.generate.<reportId>.g<generation>` (M9). `generation` = `regenerate_count` lúc enqueue:
 * tạo lại thủ công ra id MỚI (BullMQ bỏ qua `add()` trùng id, kể cả job đã completed còn được giữ).
 * Enqueue lại cùng lần tạo (tick chạy lại) → cùng id → không nhân đôi.
 */
export function reportJobId(reportId: string, generation: number): string {
  return `${JobName.WeeklyReportGenerate}.${reportId}.g${generation}`;
}
