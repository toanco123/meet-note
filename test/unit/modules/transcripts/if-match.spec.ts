import { describe, expect, it } from 'vitest';
import { AppException } from '../../../../src/common/errors/app.exception.js';
import { parseIfMatchVersion } from '../../../../src/modules/transcripts/if-match.js';
import { ParseSegmentSeqPipe } from '../../../../src/modules/transcripts/segment-seq.pipe.js';

const statusOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppException) return e.getStatus();
    throw e;
  }
  return 200;
};

describe('parseIfMatchVersion', () => {
  it.each([
    ['"3"', 3],
    ['3', 3],
    ['  "12"  ', 12],
    ['"1"', 1],
    ['"2147483647"', 2_147_483_647],
  ])('%j → %i', (header, expected) => {
    expect(parseIfMatchVersion(header)).toBe(expected);
  });

  it('thiếu header → 428 (không cho ghi mù)', () => {
    expect(statusOf(() => parseIfMatchVersion(undefined))).toBe(428);
  });

  it.each([
    ['', 'rỗng'],
    ['*', 'chữ "bất kỳ"'],
    ['W/"3"', 'weak validator'],
    ['"1", "2"', 'danh sách'],
    ['"0"', 'version 0 (bắt đầu từ 1)'],
    ['"-1"', 'số âm'],
    ['"abc"', 'không phải số'],
    ['"3', 'thiếu nháy đóng'],
    ['3"', 'thiếu nháy mở'],
    ['"1.5"', 'số thực'],
    ['"2147483648"', 'vượt int32'],
    ['"99999999999"', 'quá dài'],
    ['"3" ; DROP', 'rác phía sau'],
  ])('%j (%s) → 400', (header) => {
    expect(statusOf(() => parseIfMatchVersion(header))).toBe(400);
  });
});

describe('ParseSegmentSeqPipe', () => {
  const pipe = new ParseSegmentSeqPipe();
  it.each([
    ['0', 0],
    ['41', 41],
    ['2147483647', 2_147_483_647],
  ])('%s → %i', (v, expected) => {
    expect(pipe.transform(v)).toBe(expected);
  });
  it.each(['-1', '1.5', 'abc', '', '2147483648', '1e3', ' 1', '99999999999'])('%j → 400', (v) => {
    expect(statusOf(() => pipe.transform(v))).toBe(400);
  });
});
