/** Tên job: `domain.action`. Một queue có nhiều tên job; processor (M6) `switch (job.name)`. */
export const JobName = {
  MeetingPreprocess: 'meeting.preprocess',
  NotificationFanout: 'notification.fanout',
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
 * `notification.fanout.<dedupe_key>.<lần share tính bằng ms>`. Có mốc share: share → gỡ → share lại
 * trong lúc job cũ còn được giữ (24h) vẫn ra job MỚI (người mới vào kênh được báo); còn người đã
 * nhận thì `dedupe_key` trong DB chặn trùng. Gọi lại share (cùng dòng, cùng mốc) → cùng jobId → bỏ qua.
 */
export function notificationFanoutJobId(dedupeKey: string, at: Date): string {
  return `${JobName.NotificationFanout}.${dedupeKey}.${at.getTime()}`;
}
