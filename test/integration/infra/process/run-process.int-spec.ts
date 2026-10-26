import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProcessFailedError,
  ProcessStartError,
  ProcessTimeoutError,
} from '../../../../src/infra/process/process.errors.js';
import { runProcess } from '../../../../src/infra/process/run-process.js';

/** Process con là chính `node -e …` → điều khiển chính xác: in dòng, thoát lỗi, treo, phớt lờ SIGTERM. */
const node = (script: string, extraArgs: string[] = []) => ['-e', script, '--', ...extraArgs];
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runProcess (process con thật)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meetnote-process-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('đọc stdout theo dòng + giữ stdout khi cần; thoát 0 → xong', async () => {
    const lines: string[] = [];
    const result = await runProcess(process.execPath, {
      args: node(`for (let i = 1; i <= 3; i++) console.log('dòng ' + i)`),
      timeoutMs: 5_000,
      captureStdout: true,
      onStdoutLine: (line) => lines.push(line),
    });
    expect([lines, result.stdout]).toEqual([
      ['dòng 1', 'dòng 2', 'dòng 3'],
      'dòng 1\ndòng 2\ndòng 3\n',
    ]);
  });

  it('thoát mã ≠ 0 → ProcessFailedError chỉ giữ PHẦN CUỐI stderr', async () => {
    const error = await runProcess(process.execPath, {
      args: node(`for (let i = 1; i <= 100; i++) console.error('lỗi ' + i); process.exit(3)`),
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    const failed = error as ProcessFailedError;
    expect([failed instanceof ProcessFailedError, failed.exitCode]).toEqual([true, 3]);
    expect(failed.stderrTail.split('\n')).toHaveLength(40);
    expect(failed.stderrTail.split('\n').at(-1)).toBe('lỗi 100');
  });

  // Đột biến: không đọc stdout khi không captureStdout → pipe đầy, process con treo tới timeout.
  it('in hàng chục MB ra stdout mà không ai cần vẫn chạy xong (pipe luôn được đọc)', async () => {
    const started = Date.now();
    await runProcess(process.execPath, {
      args: node(
        `const s = 'x'.repeat(1024) + '\\n'; for (let i = 0; i < 20_000; i++) process.stdout.write(s)`,
      ),
      timeoutMs: 10_000,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  // Đột biến: resolve/reject ngay khi hết giờ thay vì chờ 'close' → process con còn sống sau khi hàm trả.
  it('quá timeout → ProcessTimeoutError và process con ĐÃ CHẾT khi hàm trả về', async () => {
    let pid = 0;
    const error = await runProcess(process.execPath, {
      args: node(`console.log(process.pid); setInterval(() => {}, 1000)`),
      timeoutMs: 300,
      onStdoutLine: (line) => (pid = Number(line)),
    }).catch((e: unknown) => e);
    expect([error instanceof ProcessTimeoutError, pid > 0, isAlive(pid)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  // Đột biến: bỏ bước SIGKILL → process phớt lờ SIGTERM sống mãi, test treo tới testTimeout.
  it('phớt lờ SIGTERM → bị SIGKILL sau thời gian ân hạn', async () => {
    let pid = 0;
    const started = Date.now();
    const error = await runProcess(process.execPath, {
      args: node(
        `process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)`,
      ),
      timeoutMs: 300,
      onStdoutLine: (line) => (pid = Number(line)),
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect([error instanceof ProcessTimeoutError, isAlive(pid)]).toEqual([true, false]);
    expect(elapsed).toBeGreaterThanOrEqual(2_000); // 300 ms + ân hạn 2 s
    expect(elapsed).toBeLessThan(5_000);
  });

  it('huỷ bằng AbortSignal (worker tắt) → reject bằng lý do huỷ, process con chết', async () => {
    let pid = 0;
    const controller = new AbortController();
    const running = runProcess(process.execPath, {
      args: node(`console.log(process.pid); setInterval(() => {}, 1000)`),
      timeoutMs: 10_000,
      signal: controller.signal,
      onStdoutLine: (line) => {
        pid = Number(line);
        controller.abort(new Error('worker đang tắt'));
      },
    });
    await expect(running).rejects.toThrow('worker đang tắt');
    expect(isAlive(pid)).toBe(false);
  });

  it('binary không tồn tại → ProcessStartError (lỗi cấu hình)', async () => {
    const error = await runProcess('/khong/co/ffmpeg', { args: [], timeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProcessStartError);
  });

  // Đột biến: `shell: true` → shell chạy phần `$(…)` / `;` và tạo file.
  it('tham số chứa `$(…)`, `;`, khoảng trắng chỉ là DỮ LIỆU — không qua shell', async () => {
    const marker = join(dir, 'bi-tiem');
    const evil = [`$(touch ${marker})`, `x; touch ${marker}`, 'tên có khoảng trắng'];
    const { stdout } = await runProcess(process.execPath, {
      args: node(`console.log(JSON.stringify(process.argv.slice(1)))`, evil),
      timeoutMs: 5_000,
      captureStdout: true,
    });
    expect([JSON.parse(stdout), existsSync(marker)]).toEqual([evil, false]);
  });
});
