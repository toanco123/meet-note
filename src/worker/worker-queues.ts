import { QueueName } from '../infra/queue/queue.module.js';

/**
 * Queue mà tiến trình worker này nghe (env `WORKER_QUEUES`, mặc định cả hai) — đọc lúc import
 * `WorkerModule` vì danh sách processor là metadata tĩnh của module. Giá trị lạ → dừng khởi động.
 */
export function workerQueues(raw = process.env.WORKER_QUEUES): Set<string> {
  const names = (raw ?? `${QueueName.Default},${QueueName.Transcription}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set<string>(Object.values(QueueName));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length || names.length === 0) {
    throw new Error(`WORKER_QUEUES không hợp lệ: "${raw}" (cho phép: ${[...known].join(', ')})`);
  }
  return new Set(names);
}
