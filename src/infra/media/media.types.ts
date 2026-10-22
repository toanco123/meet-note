export interface MediaToolsOptions {
  ffmpegPath: string;
  ffprobePath: string;
}

export interface MediaProbe {
  /** Thời lượng theo container (ms) — dùng để chặn file > 4 giờ trước khi chuyển đổi. */
  durationMs: number;
  hasAudio: boolean;
}

export interface MediaRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}
