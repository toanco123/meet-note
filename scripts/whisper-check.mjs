// Kiểm tay adapter whisper.cpp với whisper-cli THẬT (M6 Q3) — không chạy trên CI.
// Chạy: `pnpm test:whisper` (cần `brew install ffmpeg whisper-cpp`, macOS có giọng "Linh").
// WHISPER_MODEL_PATH: file model ggml (mặc định ~/.cache/meetnote/whisper/ggml-base.bin).
// File .mjs chạy trên `dist/` (code đã build), không qua typecheck: công cụ dev.
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaTools } from '../dist/infra/media/media-tools.js';
import { runProcess } from '../dist/infra/process/run-process.js';
import { WhisperCppSpeechToText } from '../dist/infra/speech/whisper-cpp.speech-to-text.js';

const modelPath =
  process.env.WHISPER_MODEL_PATH || join(homedir(), '.cache/meetnote/whisper/ggml-base.bin');
const text =
  'Chào mọi người. Hôm nay chúng ta họp về kế hoạch quý ba. Anh Bình sẽ chuẩn bị ngân sách marketing trước thứ sáu. Chị An phụ trách tuyển dụng hai kỹ sư.';

const dir = await mkdtemp(join(tmpdir(), 'meetnote-whisper-check-'));
try {
  await runProcess('say', {
    args: ['-v', 'Linh', '-o', join(dir, 'hop.aiff'), text],
    timeoutMs: 60_000,
  });
  const media = new MediaTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  const probe = await media.probe(join(dir, 'hop.aiff'), { timeoutMs: 30_000 });
  await media.toWav16kMono(join(dir, 'hop.aiff'), join(dir, 'hop.wav'), { timeoutMs: 60_000 });
  const whisper = new WhisperCppSpeechToText({ cliPath: 'whisper-cli', modelPath });
  const started = Date.now();
  const progress = [];
  const transcript = await whisper.transcribe(join(dir, 'hop.wav'), {
    language: process.env.WHISPER_LANGUAGE || 'auto',
    timeoutMs: 10 * 60_000,
    onProgress: (p) => progress.push(p),
  });
  console.log(`Model: ${modelPath}`);
  console.log(
    `Audio ${probe.durationMs} ms → nhận dạng ${Date.now() - started} ms; tiến độ: ${progress.join(', ')}`,
  );
  console.log(`Ngôn ngữ: ${transcript.language}`);
  for (const s of transcript.segments) console.log(`[${s.startMs}–${s.endMs}] ${s.text}`);
  console.log(`\nCâu gốc: ${text}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
