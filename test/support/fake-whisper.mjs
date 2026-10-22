#!/usr/bin/env node
// "Whisper giả" (M6 Q3): CÙNG tham số và định dạng ra của whisper-cli 1.9.5 (quan sát bằng lần chạy
// thật, M6 B3) — JSON ở `<-of>.json`, tiến độ ra STDERR dạng `… progress = N%`. Chế độ chọn theo TÊN
// file model: ok / fail / hang / badjson. CI không chạy whisper thật.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const arg = (flag) => args[args.indexOf(flag) + 1];
const mode = basename(arg('-m')).replace(/\..*$/, '');

if (mode === 'hang') {
  setInterval(() => {}, 1_000);
} else if (mode === 'fail') {
  process.stderr.write('whisper_init_from_file_with_params_no_state: failed to load model\n');
  process.exit(3);
} else {
  for (const p of [0, 30, 60, 100]) {
    process.stderr.write(`whisper_print_progress_callback: progress = ${p}%\n`);
  }
  const language = arg('-l') === 'auto' ? 'vi' : arg('-l');
  const json = {
    systeminfo: 'fake',
    model: {},
    params: { language: arg('-l') },
    result: { language },
    transcription: [
      {
        timestamps: { from: '00:00:00,000', to: '00:00:02,500' },
        offsets: { from: 0, to: 2500 },
        text: ' Chào mọi người.',
      },
      {
        timestamps: { from: '00:00:02,500', to: '00:00:02,600' },
        offsets: { from: 2500, to: 2600 },
        text: '   ',
      },
      {
        timestamps: { from: '00:00:02,600', to: '00:00:05,000' },
        offsets: { from: 2600, to: 5000 },
        text: ' Họp về kế hoạch quý ba.',
      },
    ],
  };
  writeFileSync(
    `${arg('-of')}.json`,
    mode === 'badjson' ? '{không phải json' : JSON.stringify(json),
  );
}
