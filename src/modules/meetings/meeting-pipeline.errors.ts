import type { MeetingFailureCode } from '../../infra/database/schema/index.js';

/**
 * Lỗi VĨNH VIỄN của pipeline (chạy lại vẫn vậy): file hỏng, sai checksum, quá dài, LLM từ chối…
 * Processor (B5) đổi thành `UnrecoverableError` của BullMQ → fail ngay, `failure_code` = `code`.
 * Lỗi khác ném ra = TẠM → BullMQ retry theo backoff.
 */
export class PermanentPipelineError extends Error {
  constructor(
    readonly code: MeetingFailureCode,
    /** Câu ngắn cho người dùng (`failure_message`) — không chứa stderr / đường dẫn nội bộ. */
    readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${userMessage}`, options);
    this.name = 'PermanentPipelineError';
  }
}
