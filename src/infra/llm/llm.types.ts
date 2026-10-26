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

/** Hành vi của `FakeSummarizer` / `FakeReportWriter` trong test. */
export interface FakeSummarizerOptions {
  /** Ném lỗi TẠM ở N lần gọi đầu. */
  failTimes?: number;
  /** Luôn ném lỗi VĨNH VIỄN. */
  permanentFailure?: boolean;
}

/** Viết báo cáo tuần của một kênh từ TÓM TẮT các meeting trong tuần (M9). */
export interface ReportWriter {
  write(input: ReportInput, options?: SummarizeOptions): Promise<ReportResult>;
}

export interface ReportInput {
  channelName: string;
  /** Thứ Hai của tuần, 'YYYY-MM-DD' (giờ VN). */
  weekStart: string;
  /** Chủ nhật của tuần, 'YYYY-MM-DD'. */
  weekEnd: string;
  /** Cũ nhất trước. Đã cắt theo giới hạn ở caller. */
  meetings: Array<{
    id: string;
    title: string;
    /** ISO 8601. */
    recordedAt: string;
    summary: MeetingSummaryContent;
  }>;
}

/** Phần do model viết; danh sách meeting do server điền (id do model trả không đáng tin). */
export interface WeeklyReportBody {
  overview: string;
  highlights: string[];
  decisions: string[];
  actionItems: Array<{ owner: string | null; task: string; due: string | null }>;
}

export interface ReportResult {
  content: WeeklyReportBody;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnthropicReportWriterOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  apiKey?: string;
  baseURL?: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface AnthropicClientOptions {
  /** Không đặt → SDK tự tìm (`ANTHROPIC_API_KEY`, `ant auth login`…). */
  apiKey?: string;
  /** Test: trỏ vào HTTP stub. */
  baseURL?: string;
  /** Retry NGẮN của SDK (429 / 5xx / mạng, tôn trọng `retry-after`); retry dài là của BullMQ. */
  maxRetries: number;
  timeoutMs: number;
}

export interface StructuredRequest {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  system: string;
  prompt: string;
  /** JSON Schema cho `output_config.format` (xem giới hạn ở `summary-format.ts`). */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface StructuredResponse {
  /** Văn bản JSON model trả về — CHƯA validate; caller kiểm lại bằng parser của mình. */
  text: string;
  /** Model THỰC SỰ trả lời (có thể là model dự phòng khi model chính từ chối). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}
