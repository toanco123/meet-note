/** Payload job dùng chung cho producer (api) và consumer (worker). CHỈ chứa ID — worker tự đọc DB. */

/** `meeting.preprocess` / `meeting.transcribe` / `meeting.summarize` (M6). */
export interface MeetingJobData {
  meetingId: string;
  /** Nối log của request đã tạo job với log của worker. */
  requestId: string | null;
}
