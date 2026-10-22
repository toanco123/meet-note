/** Không có file model — lỗi cấu hình, chạy lại không giúp (vĩnh viễn). */
export class SpeechModelMissingError extends Error {
  constructor(readonly modelPath: string) {
    super(`Không tìm thấy model nhận dạng giọng nói: ${modelPath || '(chưa cấu hình)'}`);
    this.name = 'SpeechModelMissingError';
  }
}

/** Bộ nhận dạng chạy lỗi / ra kết quả không đọc được. Tạm hay vĩnh viễn do pipeline quyết định. */
export class TranscribeFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranscribeFailedError';
  }
}
