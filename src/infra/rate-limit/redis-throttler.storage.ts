import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/**
 * Sliding log trong MỘT script (nguyên tử — không request nào chen giữa "đếm" và "ghi"):
 * KEYS[1] = ZSET thời điểm từng hit (ms), KEYS[2] = khoá "đang bị chặn" có hạn.
 * ARGV = ttl (ms), limit, blockDuration (ms), member duy nhất của hit này.
 * Trả `{ số hit, ms tới khi hit cũ nhất ra khỏi cửa sổ (hoặc hết chặn), bị chặn 0|1, ms còn chặn }`.
 *
 * Giờ lấy bằng `TIME` của Redis, không phải `Date.now()` của app: nhiều instance api lệch đồng hồ
 * vẫn đếm trên cùng một trục thời gian.
 */
const HIT_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl, limit, blockMs = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])

local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  return {limit + 1, blockLeft, 1, blockLeft}
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], ttl)
local hits = redis.call('ZCARD', KEYS[1])
local oldest = tonumber(redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2])
local expireIn = oldest + ttl - now
if hits <= limit then
  return {hits, expireIn, 0, 0}
end
if blockMs > 0 then
  redis.call('DEL', KEYS[1])
  redis.call('SET', KEYS[2], '1', 'PX', blockMs)
  return {hits, blockMs, 1, blockMs}
end
return {hits, expireIn, 1, expireIn}
`;

/** Thư viện không export `ThrottlerStorageRecord` ở entry chính → suy từ interface, không import sâu `dist/`. */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const COMMAND = 'meetnoteRateLimitHit';
type ScriptedRedis = Redis & {
  [COMMAND](
    hitsKey: string,
    blockKey: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    member: string,
  ): Promise<[number, number, number, number]>;
};

/**
 * Storage của `@nestjs/throttler` trên Redis (M11 B2): đếm dùng chung giữa MỌI instance api —
 * storage mặc định của thư viện nằm trong bộ nhớ từng tiến trình, N instance = giới hạn × N.
 *
 * Redis lỗi → CHO QUA (fail-open, log cảnh báo): mất Redis không được làm sập cả đăng nhập.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: ScriptedRedis;

  constructor(
    redis: Redis,
    /** Tách môi trường / file test dùng chung một Redis (như `QUEUE_PREFIX`). */
    private readonly prefix: string,
  ) {
    // `defineCommand`: gửi EVALSHA (chỉ băm của script), Redis chưa có script (NOSCRIPT — vừa
    // restart / failover) thì ioredis tự gửi lại EVAL đầy đủ.
    if (!(COMMAND in redis)) redis.defineCommand(COMMAND, { numberOfKeys: 2, lua: HIT_SCRIPT });
    this.redis = redis as ScriptedRedis;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    // Hash tag `{…}`: hai khoá của cùng tracker nằm cùng slot → script chạy được trên Redis Cluster.
    const base = `${this.prefix}:{${key}}`;
    try {
      const [totalHits, expireMs, blocked, blockMs] = await this.redis[COMMAND](
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
        randomUUID(), // hai hit cùng mili giây vẫn là hai phần tử khác nhau trong ZSET
      );
      return {
        totalHits,
        timeToExpire: Math.ceil(expireMs / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(blockMs / 1000),
      };
    } catch (error) {
      this.logger.warn(`Rate limit bỏ qua (Redis lỗi): ${(error as Error).message}`);
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
