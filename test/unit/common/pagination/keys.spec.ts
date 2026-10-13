import { describe, expect, it } from 'vitest';
import {
  escapeLike,
  expectTimestampKey,
  expectUuidKey,
} from '../../../../src/common/pagination/keys.js';

describe('escapeLike', () => {
  it.each([
    ['nguyen', 'nguyen'],
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['c:\\path', 'c:\\\\path'],
    ['%_\\', '\\%\\_\\\\'],
  ])('%s → %s', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });
});

describe('khoá cursor do client gửi lại', () => {
  it('timestamp đúng định dạng micro giây → nhận', () => {
    expect(expectTimestampKey('2026-10-13T09:19:14.279123Z')).toBe('2026-10-13T09:19:14.279123Z');
  });

  it.each([
    ['mili giây (thiếu độ chính xác)', '2026-10-13T09:19:14.279Z'],
    ['không phải thời gian', "'); drop table users; --"],
    ['số', 1_791_883_154],
    ['thiếu', undefined],
  ])('timestamp %s → INVALID_CURSOR', (_label, value) => {
    expect(() => expectTimestampKey(value)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });

  it('uuid hợp lệ → nhận; rác → INVALID_CURSOR', () => {
    expect(expectUuidKey('01a1348f-62e3-7e0b-a09a-7f6f8cd88117')).toBe(
      '01a1348f-62e3-7e0b-a09a-7f6f8cd88117',
    );
    expect(() => expectUuidKey('not-a-uuid')).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });
});
