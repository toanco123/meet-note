import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { REDIS } from '../../infra/redis/redis.module.js';
import type { HealthReadyResponseDto } from './dto/health-response.dto.js';

const CHECK_TIMEOUT_MS = 1_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async checkReadiness(): Promise<HealthReadyResponseDto> {
    const [database, redis] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      probe(() => this.redis.ping()),
    ]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
      checks: { database, redis },
    };
  }
}

/** Chạy một kiểm tra với timeout — health check không được treo khi phụ thuộc bị treo. */
async function probe(check: () => Promise<unknown>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
