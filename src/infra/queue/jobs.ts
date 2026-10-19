/** Tên job: `domain.action`. Một queue có nhiều tên job; processor (M6) `switch (job.name)`. */
export const JobName = {
  MeetingPreprocess: 'meeting.preprocess',
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
