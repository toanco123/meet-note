import { LlmPermanentError, LlmTransientError } from './llm.errors.js';
import type {
  FakeSummarizerOptions,
  ReportInput,
  ReportResult,
  ReportWriter,
} from './llm.types.js';
import { REPORT_PROMPT_VERSION } from './report-format.js';

/** Báo cáo giả (mặc định `LLM_PROVIDER=fake`, M9): không gọi mạng, nội dung suy ra từ các tóm tắt. */
export class FakeReportWriter implements ReportWriter {
  calls = 0;
  /** Đầu vào của lần gọi gần nhất — test kiểm "đã đưa đúng meeting vào". */
  lastInput: ReportInput | undefined;

  constructor(private readonly options: FakeSummarizerOptions = {}) {}

  async write(input: ReportInput): Promise<ReportResult> {
    this.calls++;
    this.lastInput = input;
    if (this.options.permanentFailure) throw new LlmPermanentError('lỗi giả vĩnh viễn');
    if (this.calls <= (this.options.failTimes ?? 0)) {
      throw new LlmTransientError(`lỗi giả lần ${this.calls}`);
    }
    const summaries = input.meetings.map((m) => m.summary);
    return {
      content: {
        overview: `Tuần ${input.weekStart} của kênh "${input.channelName}": ${input.meetings.length} cuộc họp.`,
        highlights: summaries.map((s) => s.overview),
        decisions: summaries.flatMap((s) => s.decisions),
        actionItems: summaries.flatMap((s) => s.actionItems),
      },
      model: 'fake',
      promptVersion: REPORT_PROMPT_VERSION,
      inputTokens: input.meetings.length,
      outputTokens: 0,
    };
  }
}
