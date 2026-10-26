/**
 * Lỗi VĨNH VIỄN của việc tạo báo cáo (LLM từ chối / 4xx…): chạy lại vẫn vậy → processor (B5) đánh
 * `failed` ngay và không retry. Lỗi tạm thì ném nguyên (BullMQ retry theo backoff).
 */
export class PermanentReportError extends Error {
  constructor(
    /** Câu ngắn lưu ở `weekly_reports.last_error` — KHÔNG chứa chi tiết nội bộ. */
    readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(userMessage, options);
    this.name = 'PermanentReportError';
  }
}
