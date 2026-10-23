// Chạy THỬ pipeline qua HTTP trên một api đang chạy (compose hoặc `pnpm start:dev` + worker) — M6 B9.
// Chạy: `pnpm smoke:pipeline [đường-dẫn-audio]` (API_URL mặc định http://localhost:3000).
// Không có file → macOS: `say -v Linh` đọc một đoạn họp tiếng Việt; máy khác: 3 giây tiếng bíp (ffmpeg).
// Đăng ký một user mới mỗi lần (email ngẫu nhiên) → upload → chờ completed / failed → in transcript + tóm tắt.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:3000';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15 * 60_000);
const TEXT =
  'Chào mọi người. Hôm nay chúng ta họp về kế hoạch quý ba. Anh Bình sẽ chuẩn bị ngân sách marketing trước thứ sáu. Chị An phụ trách tuyển dụng hai kỹ sư. Cả nhóm thống nhất ra mắt sản phẩm vào tháng mười một.';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} lỗi: ${r.stderr?.toString() ?? r.error}`);
}

function sampleAudio() {
  const dir = mkdtempSync(join(tmpdir(), 'meetnote-smoke-'));
  try {
    const out = join(dir, 'hop.m4a');
    if (process.platform === 'darwin') {
      run('say', ['-v', 'Linh', '-o', join(dir, 'hop.aiff'), TEXT]);
      run('ffmpeg', [
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        join(dir, 'hop.aiff'),
        '-c:a',
        'aac',
        out,
      ]);
    } else {
      run('ffmpeg', [
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-c:a',
        'aac',
        out,
      ]);
    }
    return { name: 'hop.m4a', bytes: readFileSync(out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(method, path, { token, json, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(json && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload.error)}`);
  return payload.data;
}

const file = process.argv[2];
const audio = file ? { name: basename(file), bytes: readFileSync(file) } : sampleAudio();
const MiB = 1024 * 1024;

const { accessToken: token } = await call('POST', '/v1/auth/register', {
  json: {
    email: `smoke-${randomBytes(4).toString('hex')}@meetnote.test`,
    password: 'Smoke-test-123',
    displayName: 'Chạy thử',
  },
});
const org = await call('POST', '/v1/orgs', { token, json: { name: 'Chạy thử pipeline' } });
const upload = await call('POST', `/v1/orgs/${org.id}/uploads`, {
  token,
  json: {
    filename: audio.name,
    mimeType: audio.name.endsWith('.wav') ? 'audio/wav' : 'audio/mp4',
    sizeBytes: audio.bytes.length,
    sha256: createHash('sha256').update(audio.bytes).digest('hex'),
    title: 'Chạy thử pipeline',
    recordedAt: new Date().toISOString(),
  },
});
for (let part = 1; part <= upload.totalParts; part++) {
  const start = (part - 1) * upload.chunkSize;
  await call('PUT', `/v1/orgs/${org.id}/uploads/${upload.id}/parts/${part}`, {
    token,
    headers: { 'content-type': 'application/octet-stream' },
    body: audio.bytes.subarray(start, Math.min(start + upload.chunkSize, audio.bytes.length)),
  });
}
const meeting = await call('POST', `/v1/orgs/${org.id}/uploads/${upload.id}/complete`, { token });
console.log(
  `Meeting ${meeting.id} (${(audio.bytes.length / MiB).toFixed(2)} MiB) → ${meeting.status}`,
);

const started = Date.now();
let last = meeting.status;
let current = meeting;
while (!['completed', 'failed'].includes(current.status)) {
  if (Date.now() - started > TIMEOUT_MS)
    throw new Error(`Quá ${TIMEOUT_MS} ms, đang ở ${current.status}`);
  await new Promise((r) => setTimeout(r, 1_000));
  current = await call('GET', `/v1/orgs/${org.id}/meetings/${meeting.id}`, { token });
  if (current.status !== last) {
    console.log(`  +${((Date.now() - started) / 1000).toFixed(1)} s → ${current.status}`);
    last = current.status;
  }
}
if (current.status === 'failed') {
  console.error(`Lỗi: ${current.failureCode} — ${current.failureMessage}`);
  process.exit(1);
}
const segments = await call(
  'GET',
  `/v1/orgs/${org.id}/meetings/${meeting.id}/transcript?limit=100`,
  { token },
);
const summary = await call('GET', `/v1/orgs/${org.id}/meetings/${meeting.id}/summary`, { token });
console.log(`\nNgôn ngữ: ${current.language}; ${segments.length} đoạn (tối đa 100 đoạn đầu):`);
for (const s of segments) console.log(`  [${s.startMs}–${s.endMs}] ${s.text}`);
console.log(`\nTóm tắt (${summary.model}, ${summary.promptVersion}):`);
console.log(
  JSON.stringify(
    {
      overview: summary.overview,
      keyPoints: summary.keyPoints,
      decisions: summary.decisions,
      actionItems: summary.actionItems,
    },
    null,
    2,
  ),
);
