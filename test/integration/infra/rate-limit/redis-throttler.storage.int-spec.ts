import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisThrottlerStorage } from '../../../../src/infra/rate-limit/redis-throttler.storage.js';

/** Storage rate limit trên Redis THẬT (M11 B2). Mỗi ca dùng khoá riêng. */
describe('RedisThrottlerStorage', () => {
  const prefix = `rl-test-${randomBytes(4).toString('hex')}`;
  let a: Redis;
  let b: Redis;
  let storage: RedisThrottlerStorage;

  beforeAll(() => {
    a = new Redis(process.env.REDIS_URL!);
    b = new Redis(process.env.REDIS_URL!);
    storage = new RedisThrottlerStorage(a, prefix);
  });

  afterAll(async () => {
    await a.quit();
    await b.quit();
  });

  const key = () => randomBytes(6).toString('hex');

  // Đột biến: tách script thành các lệnh rời (ZADD rồi ZCARD ở hai round-trip) → request chen
  // giữa thấy số đếm của request khác → ít hơn 10 lần được qua.
  it('50 lần SONG SONG, giới hạn 10 → đúng 10 lần được qua', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.increment(k, 5_000, 10, 5_000)),
    );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(10);
  });

  // Đột biến: storage trong bộ nhớ (mỗi instance một bản đếm) → instance B cho qua thêm 10 lần.
  it('hai "instance" (hai kết nối Redis) dùng CHUNG một bộ đếm', async () => {
    const other = new RedisThrottlerStorage(b, prefix);
    const k = key();
    const hit = (s: RedisThrottlerStorage) => s.increment(k, 5_000, 10, 5_000);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await hit(storage), await hit(other));
    expect(results.map((r) => r.isBlocked)).toEqual([...Array(10).fill(false), true, true]);
  });

  it('bị chặn → `timeToBlockExpire` theo blockDuration; hết chặn → đếm lại từ đầu', async () => {
    const k = key();
    for (let i = 0; i < 3; i++) await storage.increment(k, 10_000, 3, 600);
    const blocked = await storage.increment(k, 10_000, 3, 600);
    const stillBlocked = await storage.increment(k, 10_000, 3, 600);
    await sleep(700);
    const fresh = await storage.increment(k, 10_000, 3, 600);

    expect([blocked.isBlocked, blocked.timeToBlockExpire, stillBlocked.isBlocked]).toEqual([
      true,
      1,
      true,
    ]);
    expect([fresh.isBlocked, fresh.totalHits]).toEqual([false, 1]);
  });

  // Cửa sổ TRƯỢT: hit cũ rơi khỏi cửa sổ thì có chỗ cho hit mới — không chờ hết một "cửa sổ cố định".
  it('cửa sổ trượt: hit cũ hết hạn thì được thêm đúng bấy nhiêu', async () => {
    const k = key();
    await storage.increment(k, 800, 3, 800); // t ≈ 0
    await sleep(500);
    await storage.increment(k, 800, 3, 800); // t ≈ 500
    await storage.increment(k, 800, 3, 800);
    await sleep(400); // t ≈ 900: hit đầu đã rơi khỏi cửa sổ 800 ms, hai hit sau còn
    const fourth = await storage.increment(k, 800, 3, 800);

    expect([fourth.isBlocked, fourth.totalHits]).toEqual([false, 3]);
  });

  it('Redis không kết nối được → cho qua (fail-open), không ném', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const result = await new RedisThrottlerStorage(dead, prefix).increment(key(), 1_000, 1, 1_000);
    dead.disconnect();
    expect(result.isBlocked).toBe(false);
  });
});
