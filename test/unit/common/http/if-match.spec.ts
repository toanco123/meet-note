import { describe, expect, it } from 'vitest';
import { AppException } from '../../../../src/common/errors/app.exception.js';
import { Errors } from '../../../../src/common/errors/errors.js';
import { parseIfMatchVersion } from '../../../../src/common/http/if-match.js';

const parse = (header: string | undefined) =>
  parseIfMatchVersion(header, Errors.actionItem.ifMatchRequired);

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
    expect(parse(header)).toBe(expected);
  });

  it('thiếu header → 428 (không cho ghi mù)', () => {
    expect(statusOf(() => parse(undefined))).toBe(428);
  });

  // Đột biến: hằng mã lỗi transcript trong hàm dùng chung → action item báo nhầm mã.
  it('mã lỗi 428 do CALLER chọn, không phải mã cố định của một tài nguyên', () => {
    const codeOf = (fn: () => AppException) => {
      try {
        parseIfMatchVersion(undefined, fn);
      } catch (e) {
        return (e as AppException).code;
      }
      return undefined;
    };
    expect(codeOf(Errors.actionItem.ifMatchRequired)).toBe('ACTION_ITEM_IF_MATCH_REQUIRED');
    expect(codeOf(Errors.transcript.ifMatchRequired)).toBe('TRANSCRIPT_IF_MATCH_REQUIRED');
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
    expect(statusOf(() => parse(header))).toBe(400);
  });
});
