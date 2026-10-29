import { describe, expect, it } from 'vitest';
import { AppException } from '../../../../src/common/errors/app.exception.js';
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
