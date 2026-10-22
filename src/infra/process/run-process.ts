import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProcessFailedError, ProcessStartError, ProcessTimeoutError } from './process.errors.js';
import type { ProcessResult, RunProcessOptions } from './process.types.js';

/** SIGTERM rồi chờ ngần này; còn sống → SIGKILL (không bỏ được, nhưng process không kịp dọn dẹp). */
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_LINES = 40;
const MAX_CAPTURED_STDOUT = 10 * 1024 * 1024;

/**
 * Chạy MỘT process con và chờ nó kết thúc (M6 B2) — dùng chung cho ffmpeg, ffprobe, whisper.
 *
 * - `spawn(command, args)` KHÔNG qua shell: tên file chứa `;`, `$(…)`, khoảng trắng chỉ là dữ liệu.
 *   `exec('ffmpeg -i ' + file)` thì chính shell sẽ chạy phần `$(…)`.
 * - stdout / stderr đọc theo DÒNG (readline) và luôn được đọc: không đọc thì pipe đầy (~64 KB) →
 *   process con bị chặn khi ghi → treo, trông như "chạy mãi".
 * - Chỉ giữ phần CUỐI stderr: ffmpeg / whisper có thể in hàng MB log.
 * - Timeout / huỷ: SIGTERM → sau `KILL_GRACE_MS` còn sống thì SIGKILL. Promise chỉ kết thúc khi
 *   process THẬT SỰ thoát (`close`) — không để lại process mồ côi chạy tiếp sau khi hàm đã trả.
 */
export function runProcess(command: string, options: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, options.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stderrTail: string[] = [];
    let stdout = '';
    let stopReason: 'timeout' | 'aborted' | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = (reason: 'timeout' | 'aborted') => {
      if (stopReason || child.exitCode !== null) return;
      stopReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = () => stop('aborted');
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout }).on('line', (line) => {
      options.onStdoutLine?.(line);
      if (options.captureStdout && stdout.length < MAX_CAPTURED_STDOUT) stdout += `${line}\n`;
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      options.onStderrLine?.(line);
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    // ENOENT (binary không có) → 'error' và KHÔNG có 'close' của process chạy được.
    child.once('error', (error) => {
      cleanup();
      reject(new ProcessStartError(command, { cause: error }));
    });
    // 'close' (không phải 'exit'): đợi cả stdio đóng → đã đọc hết dòng cuối.
    child.once('close', (exitCode, signal) => {
      cleanup();
      if (stopReason === 'timeout')
        return reject(new ProcessTimeoutError(command, options.timeoutMs));
      if (stopReason === 'aborted') {
        return reject(options.signal?.reason ?? new Error(`${command} bị huỷ`));
      }
      if (exitCode !== 0) {
        return reject(new ProcessFailedError(command, exitCode, signal, stderrTail.join('\n')));
      }
      if (options.captureStdout && stdout.length >= MAX_CAPTURED_STDOUT) {
        return reject(new Error(`${command}: stdout vượt ${MAX_CAPTURED_STDOUT} byte`));
      }
      resolve({ stdout });
    });
  });
}
