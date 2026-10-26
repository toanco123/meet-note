import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessFailedError } from '../process/process.errors.js';
import { runProcess } from '../process/run-process.js';
import { SpeechModelMissingError, TranscribeFailedError } from './speech.errors.js';
import type {
  SpeechToText,
  Transcript,
  TranscribeOptions,
  WhisperCppOptions,
} from './speech.types.js';

/** `-pp` in tiến độ ra STDERR dạng `whisper_print_progress_callback: progress = 42%`. */
const PROGRESS = /progress\s*=\s*(\d+)%/;

/** Định dạng `-oj` của whisper-cli 1.9.5 (quan sát bằng lần chạy thật, M6 B3) — chỉ phần dùng tới. */
interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
}

/**
 * whisper.cpp qua `whisper-cli` (process con, M6 B3). Kết quả đọc từ file JSON (`-oj -of`), KHÔNG
 * từ stdout: stdout là bản in cho người đọc (`[00:00:00.000 --> …]`), đổi định dạng giữa các bản.
 */
export class WhisperCppSpeechToText implements SpeechToText {
  constructor(private readonly options: WhisperCppOptions) {}

  async transcribe(wavPath: string, options: TranscribeOptions): Promise<Transcript> {
    // Thiếu model: whisper-cli vẫn khởi động rồi mới báo lỗi; kiểm trước để phân loại đúng (cấu hình).
    await access(this.options.modelPath).catch(() => {
      throw new SpeechModelMissingError(this.options.modelPath);
    });
    const dir = await mkdtemp(join(tmpdir(), 'meetnote-whisper-'));
    try {
      const outBase = join(dir, 'out');
      try {
        await runProcess(this.options.cliPath, {
          args: [
            '-m',
            this.options.modelPath,
            '-f',
            wavPath,
            '-l',
            options.language,
            ...(this.options.threads ? ['-t', String(this.options.threads)] : []),
            '-oj',
            '-of',
            outBase,
            '-pp',
            '-np',
          ],
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          onStderrLine: (line) => {
            const match = PROGRESS.exec(line);
            if (match) options.onProgress?.(Number(match[1]));
          },
        });
      } catch (error) {
        if (error instanceof ProcessFailedError) {
          throw new TranscribeFailedError('whisper-cli lỗi', { cause: error });
        }
        throw error; // timeout / huỷ / thiếu binary: để pipeline phân loại
      }
      return parseWhisperJson(await readFile(`${outBase}.json`, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function parseWhisperJson(raw: string): Transcript {
  let json: WhisperJson;
  try {
    json = JSON.parse(raw) as WhisperJson;
  } catch (error) {
    throw new TranscribeFailedError('JSON của whisper-cli không đọc được', { cause: error });
  }
  if (!Array.isArray(json.transcription)) {
    throw new TranscribeFailedError('JSON của whisper-cli thiếu `transcription`');
  }
  const segments = json.transcription
    .map((s) => ({
      startMs: Math.max(0, Math.round(s.offsets?.from ?? 0)),
      endMs: Math.round(s.offsets?.to ?? 0),
      // whisper để một dấu cách đầu đoạn; đoạn rỗng (im lặng) bỏ đi.
      text: (s.text ?? '').trim(),
    }))
    .filter((s) => s.text.length > 0)
    .map((s) => ({ ...s, endMs: Math.max(s.endMs, s.startMs) }));
  return { language: json.result?.language ?? null, segments };
}
