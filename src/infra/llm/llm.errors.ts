/**
 * Lỗi của tầng LLM, chia theo việc pipeline cần quyết định: chạy lại có ích không. Không lộ class
 * lỗi của SDK ra module domain.
 */

/** Chạy lại có thể thành công: 429, 5xx, mạng / timeout, kết quả sai schema. */
export class LlmTransientError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`LLM lỗi tạm thời: ${reason}`, options);
    this.name = 'LlmTransientError';
  }
}

/** Chạy lại vẫn vậy: 400 / 401 / 403 / 404 / 422, bị từ chối (refusal), vượt `max_tokens`. */
export class LlmPermanentError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`LLM lỗi vĩnh viễn: ${reason}`, options);
    this.name = 'LlmPermanentError';
  }
}
