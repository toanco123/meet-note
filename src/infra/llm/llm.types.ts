/** Tóm tắt transcript bằng LLM (M6). Module domain chỉ biết interface này, không biết SDK. */
export interface Summarizer {
  summarize(input: SummaryInput, options?: SummarizeOptions): Promise<SummaryResult>;
}

export interface SummaryInput {
  meetingTitle: string;
  segments: Array<{ startMs: number; text: string }>;
}

export interface SummarizeOptions {
  signal?: AbortSignal;
}

/** Nội dung lưu ở `meeting_summaries.content` (03 §4). */
export interface MeetingSummaryContent {
  overview: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: Array<{ owner: string | null; task: string; due: string | null }>;
}

export interface SummaryResult {
  content: MeetingSummaryContent;
  /** Model THỰC SỰ trả lời (có thể là model dự phòng khi model chính từ chối). */
  model: string;
  promptVersion: string;
  /** Cộng dồn mọi lượt gọi (map + reduce). */
  inputTokens: number;
  outputTokens: number;
}

export interface AnthropicSummarizerOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Không đặt → SDK tự tìm (`ANTHROPIC_API_KEY`, `ant auth login`…). */
  apiKey?: string;
  /** Test: trỏ vào HTTP stub. */
  baseURL?: string;
  /** Retry NGẮN của SDK (429 / 5xx / mạng, tôn trọng `retry-after`); retry dài là của BullMQ. */
  maxRetries: number;
  timeoutMs: number;
  /** Transcript dài hơn ngần này ký tự → map-reduce. */
  chunkChars: number;
}

/** Hành vi của `FakeSummarizer` trong test. */
export interface FakeSummarizerOptions {
  /** Ném lỗi TẠM ở N lần gọi đầu. */
  failTimes?: number;
  /** Luôn ném lỗi VĨNH VIỄN. */
  permanentFailure?: boolean;
}
