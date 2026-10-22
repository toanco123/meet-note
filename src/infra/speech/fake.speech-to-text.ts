import { TranscribeFailedError } from './speech.errors.js';
import type {
  FakeSpeechToTextOptions,
  SpeechToText,
  Transcript,
  TranscribeOptions,
} from './speech.types.js';

/** Bộ nhận dạng giả cho dev / test (M6 Q3): trả transcript cố định, báo tiến độ, lỗi N lần đầu. */
export class FakeSpeechToText implements SpeechToText {
  calls = 0;

  constructor(private readonly options: FakeSpeechToTextOptions = {}) {}

  async transcribe(_wavPath: string, options: TranscribeOptions): Promise<Transcript> {
    this.calls++;
    if (this.calls <= (this.options.failTimes ?? 0)) {
      throw new TranscribeFailedError(`lỗi giả lần ${this.calls}`);
    }
    for (const percent of [25, 50, 75, 100]) options.onProgress?.(percent);
    return {
      language: this.options.language ?? 'vi',
      segments: this.options.segments ?? [
        { startMs: 0, endMs: 4_000, text: 'Chào mọi người, hôm nay họp về kế hoạch quý ba.' },
        {
          startMs: 4_000,
          endMs: 9_000,
          text: 'Anh Bình chuẩn bị ngân sách marketing trước thứ sáu.',
        },
      ],
    };
  }
}
