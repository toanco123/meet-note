import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../infra/redis/redis.module.js';

const INTERVAL_MS = 15_000;
const TTL_SECONDS = 45;
export const WORKER_HEARTBEAT_PREFIX = 'meetnote:workers:';

/**
 * Mỗi 15 giây ghi `meetnote:workers:<host>:<pid>` (TTL 45s) vào Redis.
 * - Xem worker nào đang sống: `redis-cli --scan --pattern 'meetnote:workers:*'`.
 * - Giữ event loop: application context của Nest KHÔNG tự giữ tiến trình sống; khi chưa có
 *   BullMQ Worker nào (trước M6), thiếu timer này worker sẽ tự thoát với exit code 0.
 */
@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private readonly key = `${WORKER_HEARTBEAT_PREFIX}${hostname()}:${process.pid}`;
  private readonly startedAt = new Date().toISOString();
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationBootstrap(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), INTERVAL_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    if (this.redis.status === 'ready') {
      await this.redis.del(this.key).catch(() => undefined);
    }
  }

  private async beat(): Promise<void> {
    try {
      const value = JSON.stringify({ pid: process.pid, startedAt: this.startedAt, at: new Date() });
      await this.redis.set(this.key, value, 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Không ghi được heartbeat: ${(error as Error).message}`);
    }
  }
}
