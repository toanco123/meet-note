import { describe, expect, it } from 'vitest';
import { isSwaggerEnabled, NodeEnv, validateEnv } from './env.validation.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('áp giá trị mặc định khi chỉ có biến bắt buộc', () => {
    const env = validateEnv({ ...REQUIRED });

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.REFRESH_REUSE_GRACE_SECONDS).toBe(10);
  });

  it('ép kiểu chuỗi từ process.env sang number/boolean', () => {
    const env = validateEnv({ ...REQUIRED, PORT: '8080', LOG_PRETTY: 'true' });

    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
  });

  it('"false" phải thành false (bẫy Boolean("false") === true)', () => {
    expect(validateEnv({ ...REQUIRED, LOG_PRETTY: 'false' }).LOG_PRETTY).toBe(false);
  });

  it('báo lỗi rõ ràng khi thiếu biến bắt buộc', () => {
    expect(() => validateEnv({ REDIS_URL: REQUIRED.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('JWT_ACCESS_SECRET ngắn hơn 32 ký tự bị từ chối', () => {
    expect(() => validateEnv({ ...REQUIRED, JWT_ACCESS_SECRET: 'short-secret' })).toThrow(
      /JWT_ACCESS_SECRET phải dài ít nhất 32 ký tự/,
    );
  });

  it('thiếu JWT_ACCESS_SECRET bị từ chối', () => {
    const { JWT_ACCESS_SECRET: _omit, ...withoutSecret } = REQUIRED;
    expect(() => validateEnv(withoutSecret)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('báo lỗi khi giá trị sai định dạng', () => {
    expect(() => validateEnv({ ...REQUIRED, PORT: 'abc', NODE_ENV: 'prod' })).toThrow(
      /PORT[\s\S]*NODE_ENV|NODE_ENV[\s\S]*PORT/,
    );
  });
});

describe('isSwaggerEnabled', () => {
  it.each([
    [NodeEnv.Development, true],
    [NodeEnv.Test, true],
    [NodeEnv.Staging, true],
    [NodeEnv.Production, false],
  ])('%s → %s', (nodeEnv, expected) => {
    expect(isSwaggerEnabled(nodeEnv)).toBe(expected);
  });
});
