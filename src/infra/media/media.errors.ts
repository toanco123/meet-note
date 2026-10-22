/** ffprobe không đọc được file (hỏng, không phải media). Lỗi VĨNH VIỄN: chạy lại vẫn vậy. */
export class MediaUnreadableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Không đọc được file media', options);
    this.name = 'MediaUnreadableError';
  }
}

/** ffmpeg chuyển đổi lỗi SAU khi probe đã đọc được — pipeline quyết định tạm / vĩnh viễn. */
export class MediaConversionError extends Error {
  constructor(options?: ErrorOptions) {
    super('Chuyển đổi audio thất bại', options);
    this.name = 'MediaConversionError';
  }
}
