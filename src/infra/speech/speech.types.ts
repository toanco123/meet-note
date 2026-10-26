/** Chuyển giọng nói thành transcript (M6). Module domain chỉ biết interface này, không biết whisper. */
export interface SpeechToText {
  transcribe(wavPath: string, options: TranscribeOptions): Promise<Transcript>;
}

export interface TranscribeOptions {
  /** Mã ngôn ngữ (`vi`, `en`…) hoặc `auto` để tự nhận dạng. */
  language: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 0–100, gọi mỗi khi bộ nhận dạng báo tiến độ (caller tự giãn tần suất phát realtime). */
  onProgress?: (percent: number) => void;
}

export interface Transcript {
  /** Ngôn ngữ bộ nhận dạng xác định được; `null` nếu không báo. */
  language: string | null;
  segments: TranscriptSegmentInput[];
}

export interface TranscriptSegmentInput {
  startMs: number;
  endMs: number;
  text: string;
}

export interface WhisperCppOptions {
  cliPath: string;
  modelPath: string;
  /** Số luồng CPU; không đặt → mặc định của whisper.cpp. */
  threads?: number;
}

/** Hành vi của `FakeSpeechToText` trong test. */
export interface FakeSpeechToTextOptions {
  segments?: TranscriptSegmentInput[];
  language?: string;
  /** Ném lỗi TẠM ở N lần gọi đầu (thử retry). */
  failTimes?: number;
}
