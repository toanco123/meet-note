import { ProcessFailedError } from '../process/process.errors.js';
import { runProcess } from '../process/run-process.js';
import { MediaConversionError, MediaUnreadableError } from './media.errors.js';
import type { MediaProbe, MediaRunOptions, MediaToolsOptions } from './media.types.js';

/**
 * BẪY: tham số `-i` của ffmpeg / đường dẫn của ffprobe là URL-ish — `concat:a|b`, `http://…`,
 * `pipe:`, tên bắt đầu bằng `-` đều KHÔNG được hiểu là file. Luôn bọc `file:` (kể cả tên do worker
 * tự sinh) để chỉ có một nghĩa: file cục bộ.
 */
const asFile = (path: string) => `file:${path}`;

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; duration?: string }>;
}

/** ffprobe + ffmpeg qua process con (M6 B2). Không dùng thư viện bọc: gọi trực tiếp là nội dung học. */
export class MediaTools {
  constructor(private readonly options: MediaToolsOptions) {}

  async probe(path: string, run: MediaRunOptions): Promise<MediaProbe> {
    let stdout: string;
    try {
      ({ stdout } = await runProcess(this.options.ffprobePath, {
        args: [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          asFile(path),
        ],
        captureStdout: true,
        ...run,
      }));
    } catch (error) {
      // Thoát ≠ 0 = file không đọc được; timeout / huỷ / thiếu binary thì ném nguyên (không phải lỗi file).
      if (error instanceof ProcessFailedError) throw new MediaUnreadableError({ cause: error });
      throw error;
    }
    const output = JSON.parse(stdout) as FfprobeOutput;
    const streams = output.streams ?? [];
    const seconds = Number(
      output.format?.duration ?? streams.find((s) => s.duration !== undefined)?.duration,
    );
    if (!Number.isFinite(seconds)) throw new MediaUnreadableError();
    return {
      durationMs: Math.round(seconds * 1000),
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
    };
  }

  /**
   * Chuẩn hoá cho whisper: WAV PCM 16-bit, 16 kHz, mono, CHỈ luồng audio đầu tiên (`-map 0:a:0`,
   * `-vn`) — file video không phải giải mã hình. `-nostdin`: ffmpeg mặc định đọc stdin để nhận
   * phím `q`; chạy nền mà không tắt có thể treo / ăn mất input.
   */
  async toWav16kMono(input: string, output: string, run: MediaRunOptions): Promise<void> {
    try {
      await runProcess(this.options.ffmpegPath, {
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          asFile(input),
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          asFile(output),
        ],
        ...run,
      });
    } catch (error) {
      if (error instanceof ProcessFailedError) throw new MediaConversionError({ cause: error });
      throw error;
    }
  }
}
