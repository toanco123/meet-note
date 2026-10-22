import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaUnreadableError } from '../../../../src/infra/media/media.errors.js';
import { MediaTools } from '../../../../src/infra/media/media-tools.js';
import { ProcessTimeoutError } from '../../../../src/infra/process/process.errors.js';
import { runProcess } from '../../../../src/infra/process/run-process.js';

/** ffmpeg / ffprobe THẬT (Homebrew ở máy dev, apt trên CI) — bắt được lỗi tham số thật (M6 Q3). */
describe('MediaTools (ffmpeg thật)', () => {
  const tools = new MediaTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  const run = { timeoutMs: 30_000 };
  let dir: string;
  const file = (name: string) => join(dir, name);
  /** Sinh fixture bằng `lavfi` (nguồn tổng hợp của ffmpeg) — không commit file media vào repo. */
  const ffmpeg = (...args: string[]) =>
    runProcess('ffmpeg', {
      args: ['-nostdin', '-loglevel', 'error', '-y', ...args],
      timeoutMs: 30_000,
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meetnote-media-'));
    // 3 s tiếng bíp, stereo 44.1 kHz AAC — khác hẳn đích 16 kHz mono để thấy chuyển đổi thật.
    await ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'aac',
      file('tone.m4a'),
    );
    await ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=64x64:rate=10',
      '-c:v',
      'mpeg4',
      file('video-only.mp4'),
    );
    await writeFile(file('garbage.m4a'), randomBytes(64 * 1024));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const streamInfo = async (path: string) => {
    const { stdout } = await runProcess('ffprobe', {
      args: ['-v', 'error', '-print_format', 'json', '-show_streams', `file:${path}`],
      captureStdout: true,
      timeoutMs: 10_000,
    });
    const [audio] = (JSON.parse(stdout) as { streams: Array<Record<string, unknown>> }).streams;
    return { codec: audio?.codec_name, sampleRate: audio?.sample_rate, channels: audio?.channels };
  };

  it('probe: thời lượng + có audio; video không audio → hasAudio false; file rác → MediaUnreadableError', async () => {
    const tone = await tools.probe(file('tone.m4a'), run);
    const video = await tools.probe(file('video-only.mp4'), run);
    const garbage = await tools.probe(file('garbage.m4a'), run).catch((e: unknown) => e);

    expect(Math.abs(tone.durationMs - 3_000)).toBeLessThan(100);
    expect([tone.hasAudio, video.hasAudio, garbage instanceof MediaUnreadableError]).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('toWav16kMono: ra PCM 16-bit, 16 kHz, MỘT kênh, giữ thời lượng', async () => {
    await tools.toWav16kMono(file('tone.m4a'), file('tone.wav'), run);
    const [info, probe] = [
      await streamInfo(file('tone.wav')),
      await tools.probe(file('tone.wav'), run),
    ];
    expect(info).toEqual({ codec: 'pcm_s16le', sampleRate: '16000', channels: 1 });
    expect(Math.abs(probe.durationMs - 3_000)).toBeLessThan(100);
  });

  // Không qua shell nên `;` / `$(…)` vô hại. Lưu ý (đột biến LỌT, M6 bài học 3): bỏ tiền tố `file:` test
  // vẫn xanh — đường dẫn worker luôn TUYỆT ĐỐI (`/…`), ffmpeg không hiểu nhầm; `file:` là phòng thủ
  // dự phòng cho đường dẫn tương đối / lấy từ dữ liệu người dùng sau này.
  it('tên file "độc" (`;`, `$(…)`, khoảng trắng, bắt đầu bằng `-`) chỉ là tên file', async () => {
    // Không có `/` (không được nằm trong tên file); bị shell chạy thì marker ra ở thư mục hiện hành.
    const evil = '-x a;$(touch MEETNOTE_BI_TIEM) b.m4a';
    await copyFile(file('tone.m4a'), file(evil));
    await tools.toWav16kMono(file(evil), file('-ra.wav'), run);
    const probe = await tools.probe(file('-ra.wav'), run);
    const injected = [...(await readdir(dir)), ...(await readdir(process.cwd()))].includes(
      'MEETNOTE_BI_TIEM',
    );
    expect([probe.hasAudio, injected]).toEqual([true, false]);
  });

  it('quá timeout → ProcessTimeoutError (process ffmpeg bị dừng, không treo worker)', async () => {
    const error = await tools
      .toWav16kMono(file('tone.m4a'), file('timeout.wav'), { timeoutMs: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProcessTimeoutError);
  });
});
