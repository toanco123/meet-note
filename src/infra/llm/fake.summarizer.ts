import { LlmPermanentError, LlmTransientError } from './llm.errors.js';
import type {
  FakeSummarizerOptions,
  Summarizer,
  SummaryInput,
  SummaryResult,
} from './llm.types.js';
import { PROMPT_VERSION } from './summary-format.js';

/** Tóm tắt giả (mặc định `LLM_PROVIDER=fake`, M6 Q2): không gọi mạng, kết quả suy ra từ transcript. */
export class FakeSummarizer implements Summarizer {
  calls = 0;

  constructor(private readonly options: FakeSummarizerOptions = {}) {}

  async summarize(input: SummaryInput): Promise<SummaryResult> {
    this.calls++;
    if (this.options.permanentFailure) throw new LlmPermanentError('lỗi giả vĩnh viễn');
    if (this.calls <= (this.options.failTimes ?? 0)) {
      throw new LlmTransientError(`lỗi giả lần ${this.calls}`);
    }
    return {
      content: {
        overview: `Cuộc họp "${input.meetingTitle}" (${input.segments.length} đoạn).`,
        keyPoints: input.segments.slice(0, 3).map((s) => s.text),
        decisions: [],
        actionItems: [],
      },
      model: 'fake',
      promptVersion: PROMPT_VERSION,
      inputTokens: input.segments.reduce((sum, s) => sum + s.text.length, 0),
      outputTokens: 0,
    };
  }
}
