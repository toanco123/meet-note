import { describe, expect, it } from 'vitest';
import { AppException } from '../../../../src/common/errors/app.exception.js';
import {
  canonicalJson,
  decideExisting,
  parseIdempotencyKey,
  requestHash,
} from '../../../../src/modules/idempotency/idempotency-key.js';

describe('parseIdempotencyKey', () => {
  it.each([
    ['UUID', '0192b7e1-2f9a-7c3e-9a51-3c1f0b7d2e4a'],
    ['1 ký tự', 'a'],
    ['255 ký tự', 'k'.repeat(255)],
    ['ký tự đặc biệt in được', 'init:2026-10-19/#1'],
  ])('%s → hợp lệ', (_label, key) => {
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it('không có header → undefined (route chạy bình thường)', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it.each([
    ['rỗng', ''],
    ['256 ký tự', 'k'.repeat(256)],
    ['có khoảng trắng', 'init 1'],
    ['có dấu tiếng Việt', 'tải-lên'],
    ['ký tự điều khiển', 'a\tb'],
    ['header lặp (mảng)', ['a', 'b']],
  ])('%s → 400 VALIDATION_FAILED, không im lặng bỏ qua', (_label, header) => {
    const codeOf = () => {
      try {
        parseIdempotencyKey(header);
        return 'OK';
      } catch (error) {
        return error instanceof AppException ? `${error.getStatus()} ${error.code}` : 'lỗi khác';
      }
    };
    expect(codeOf()).toBe('400 VALIDATION_FAILED');
  });
});

describe('canonicalJson', () => {
  it('thứ tự field của object không quan trọng, kể cả object lồng nhau', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  it('thứ tự phần tử MẢNG có nghĩa → khác nhau', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('không có body → "null"', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('requestHash', () => {
  const body = { title: 'Họp', sizeBytes: 1024 };

  it('cùng method + path + nội dung (khác thứ tự field) → cùng hash', () => {
    expect(requestHash('POST', '/v1/a', body)).toBe(
      requestHash('POST', '/v1/a', { sizeBytes: 1024, title: 'Họp' }),
    );
  });

  it.each([
    ['khác body', 'POST', '/v1/a', { ...body, sizeBytes: 2048 }],
    ['khác path (tổ chức khác)', 'POST', '/v1/b', body],
    ['khác method', 'PUT', '/v1/a', body],
    ['chuỗi khác khoảng trắng', 'POST', '/v1/a', { ...body, title: 'Họp ' }],
  ])('%s → khác hash', (_label, method, path, other) => {
    expect(requestHash(method, path, other)).not.toBe(requestHash('POST', '/v1/a', body));
  });
});

describe('decideExisting', () => {
  const row = (over: Partial<Parameters<typeof decideExisting>[0]> = {}) => ({
    requestHash: 'h1',
    status: 'completed' as const,
    responseStatus: 201,
    responseBody: { id: 'u1' },
    ...over,
  });

  it.each([
    [
      'đã xong, cùng nội dung → replay',
      row(),
      'h1',
      { kind: 'replay', status: 201, body: { id: 'u1' } },
    ],
    [
      'đang chạy, cùng nội dung → in-progress',
      row({ status: 'processing', responseStatus: null }),
      'h1',
      { kind: 'in-progress' },
    ],
    ['đã xong, nội dung khác → reused', row(), 'h2', { kind: 'reused' }],
    // Dùng sai key là lỗi của client, báo ngay dù request đầu chưa xong.
    [
      'đang chạy, nội dung khác → reused',
      row({ status: 'processing', responseStatus: null }),
      'h2',
      { kind: 'reused' },
    ],
  ] as const)('%s', (_label, existing, hash, expected) => {
    expect(decideExisting(existing, hash)).toEqual(expected);
  });
});
