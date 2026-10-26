/**
 * Lỗi khi chạy process con. Mang theo PHẦN CUỐI stderr để log (không đưa nguyên văn cho người
 * dùng — có thể chứa đường dẫn / dữ liệu nội bộ).
 */
export class ProcessFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderrTail: string,
  ) {
    super(`${command} thoát với ${exitCode === null ? `tín hiệu ${signal}` : `mã ${exitCode}`}`);
    this.name = 'ProcessFailedError';
  }
}

/** Quá thời hạn → đã bị kill (SIGTERM, rồi SIGKILL nếu không chịu dừng). */
export class ProcessTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} chạy quá ${timeoutMs} ms, đã bị dừng`);
    this.name = 'ProcessTimeoutError';
  }
}

/** Không khởi động được (thường: binary không có — ENOENT). Lỗi cấu hình, retry không giúp. */
export class ProcessStartError extends Error {
  constructor(
    readonly command: string,
    options?: ErrorOptions,
  ) {
    super(`Không chạy được ${command}`, options);
    this.name = 'ProcessStartError';
  }
}
