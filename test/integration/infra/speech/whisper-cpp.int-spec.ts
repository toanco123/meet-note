import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessTimeoutError } from '../../../../src/infra/process/process.errors.js';
import {
  SpeechModelMissingError,
  TranscribeFailedError,
} from '../../../../src/infra/speech/speech.errors.js';
import { WhisperCppSpeechToText } from '../../../../src/infra/speech/whisper-cpp.speech-to-text.js';

/** Adapter whisper.cpp với "whisper giả" (process con thật, định dạng như whisper-cli 1.9.5). */
describe('WhisperCppSpeechToText', () => {
  const cliPath = join(import.meta.dirname, '../../../support/fake-whisper.mjs');
  let dir: string;
  const whisper = (mode: string) =>
    new WhisperCppSpeechToText({ cliPath, modelPath: join(dir, `${mode}.bin`) });
  const leftovers = async () =>
    (await readdir(tmpdir())).filter((n) => n.startsWith('meetnote-whisper-')).length;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meetnote-whisper-test-'));
    for (const mode of ['ok', 'fail', 'hang', 'badjson'])
      await writeFile(join(dir, `${mode}.bin`), '');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('đọc JSON `-oj`: ms từ `offsets`, bỏ dấu cách đầu + đoạn rỗng, ngôn ngữ nhận dạng, tiến độ từ stderr', async () => {
    const progress: number[] = [];
    const transcript = await whisper('ok').transcribe('/khong/can/that.wav', {
      language: 'auto',
      timeoutMs: 10_000,
      onProgress: (p) => progress.push(p),
    });
    expect(transcript).toEqual({
      language: 'vi',
      segments: [
        { startMs: 0, endMs: 2_500, text: 'Chào mọi người.' },
        { startMs: 2_600, endMs: 5_000, text: 'Họp về kế hoạch quý ba.' },
      ],
    });
    expect(progress).toEqual([0, 30, 60, 100]);
  });

  it('truyền đúng ngôn ngữ cấu hình xuống `-l`', async () => {
    const transcript = await whisper('ok').transcribe('/x.wav', {
      language: 'en',
      timeoutMs: 10_000,
    });
    expect(transcript.language).toBe('en');
  });

  it.each([
    ['fail', 'thoát mã ≠ 0'],
    ['badjson', 'JSON hỏng'],
  ])('%s (%s) → TranscribeFailedError', async (mode) => {
    const error = await whisper(mode)
      .transcribe('/x.wav', { language: 'vi', timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscribeFailedError);
  });

  it('treo → ProcessTimeoutError (pipeline quyết định retry)', async () => {
    const error = await whisper('hang')
      .transcribe('/x.wav', { language: 'vi', timeoutMs: 300 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProcessTimeoutError);
  });

  it('không có file model → SpeechModelMissingError, không chạy whisper', async () => {
    const error = await new WhisperCppSpeechToText({
      cliPath,
      modelPath: join(dir, 'khong-co.bin'),
    })
      .transcribe('/x.wav', { language: 'vi', timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechModelMissingError);
  });

  // Đột biến: bỏ `rm` trong finally → thư mục tạm của mỗi lần chạy (cả khi lỗi) còn lại.
  it('thư mục tạm luôn được dọn — kể cả khi whisper lỗi / treo', async () => {
    const before = await leftovers();
    for (const mode of ['ok', 'fail', 'badjson', 'hang']) {
      await whisper(mode)
        .transcribe('/x.wav', { language: 'vi', timeoutMs: 300 })
        .catch(() => undefined);
    }
    expect(await leftovers()).toBe(before);
  });
});
