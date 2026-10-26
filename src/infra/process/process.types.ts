export interface RunProcessOptions {
  /** Từng tham số là MỘT phần tử — không ghép chuỗi, không qua shell. */
  args: string[];
  timeoutMs: number;
  /** Huỷ từ bên ngoài (worker shutdown) → kill như timeout. */
  signal?: AbortSignal;
  /** Gọi với từng dòng stdout (tiến độ…). */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Giữ toàn bộ stdout để trả về (ffprobe JSON). Có trần, quá → lỗi. Mặc định không giữ. */
  captureStdout?: boolean;
}

export interface ProcessResult {
  /** Chỉ có khi `captureStdout`. */
  stdout: string;
}
