import { describe, expect, it } from 'vitest';
import {
  matchAssignee,
  normalizeName,
} from '../../../../src/modules/action-items/assignee-matcher.js';

const member = (userId: string, displayName: string) => ({ userId, displayName });
const TEAM = [
  member('u-binh', 'Nguyễn Văn Bình'),
  member('u-lan', 'Trần Thị Lan'),
  member('u-an', 'An'),
  member('u-duc', 'Đặng Minh Đức'),
];

describe('normalizeName', () => {
  it.each([
    ['Nguyễn Văn Bình', 'nguyen van binh'],
    ['  Đặng   Minh  Đức ', 'dang minh duc'],
    ['ĐỖ ĐẠT', 'do dat'],
    ['Lan-Anh (QA)', 'lan anh qa'],
    ['Bình,', 'binh'],
    ['', ''],
    ['!!!', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('matchAssignee — chỉ gán khi ĐÚNG MỘT người khớp, không bao giờ đoán', () => {
  it.each([
    ['trùng cả tên', 'Nguyễn Văn Bình', 'u-binh'],
    ['trùng cả tên không dấu, khác hoa thường', 'nguyen van binh', 'u-binh'],
    ['tên gọi (từ cuối của họ tên)', 'Bình', 'u-binh'],
    ['tên gọi không dấu', 'binh', 'u-binh'],
    ['tên gọi kèm dấu câu', 'Lan.', 'u-lan'],
    ['xưng hô + tên gọi', 'anh Bình', 'u-binh'],
    ['xưng hô + tên gọi hoa thường', 'Chị Lan', 'u-lan'],
    ['xưng hô + cả tên', 'Anh Nguyễn Văn Bình', 'u-binh'],
    ['thành viên chỉ có một chữ trùng cả tên', 'An', 'u-an'],
    ['đ ↔ d', 'duc', 'u-duc'],
    ['khoảng trắng thừa', '  Bình  ', 'u-binh'],
  ])('%s: %j → %s', (_label, owner, expected) => {
    expect(matchAssignee(owner, TEAM)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['rỗng', ''],
    ['toàn khoảng trắng', '   '],
    ['chỉ dấu câu', '...'],
    ['không ai tên này', 'Hoàng'],
    ['nhóm, không phải một người', 'mọi người'],
    ['nhóm khác', 'cả team'],
    ['họ tên khác người có tên gọi giống', 'Lê Văn Bình'], // "Bình" trùng nhưng họ khác: nhiều từ thì không hạ xuống tên gọi
    ['chỉ xưng hô', 'anh'],
    ['tên gọi quá ngắn (1 ký tự) không dùng để khớp', 'A'],
  ])('KHÔNG gán: %s (%j)', (_label, owner) => {
    expect(matchAssignee(owner as string | null, TEAM)).toBeNull();
  });

  it('hai người cùng tên gọi → null (mơ hồ), kể cả khi tên model nêu có xưng hô', () => {
    const team = [member('u1', 'Nguyễn Văn Bình'), member('u2', 'Lê Thị Bình'), ...TEAM.slice(1)];
    expect(matchAssignee('Bình', team)).toBeNull();
    expect(matchAssignee('anh Bình', team)).toBeNull();
    // Nhưng cả tên thì phân biệt được.
    expect(matchAssignee('Lê Thị Bình', team)).toBe('u2');
  });

  it('hai người trùng CẢ tên → null; KHÔNG tụt xuống bậc tên gọi', () => {
    const team = [member('u1', 'Bình'), member('u2', 'Bình'), member('u3', 'Nguyễn Văn Bình')];
    expect(matchAssignee('Bình', team)).toBeNull(); // bậc 1 có hai ứng viên → dừng, không nhặt u3
  });

  it('khớp cả tên ở bậc 1 thắng tên gọi ở bậc 2 (một người tên "Bình" và một người họ tên có "Bình")', () => {
    const team = [member('u1', 'Bình'), member('u2', 'Nguyễn Văn Bình')];
    expect(matchAssignee('Bình', team)).toBe('u1');
  });

  it('thành viên tên thật bắt đầu bằng xưng hô vẫn khớp NGUYÊN VĂN trước khi bỏ xưng hô', () => {
    const team = [member('u1', 'Anh Tuấn'), member('u2', 'Phạm Tuấn')];
    expect(matchAssignee('Anh Tuấn', team)).toBe('u1'); // không bị đọc thành "Tuấn" (mơ hồ)
    expect(matchAssignee('Tuấn', team)).toBeNull(); // hai người có tên gọi Tuấn
  });

  it('tên gọi 1 ký tự không dùng để khớp dù có đúng một thành viên kết thúc bằng chữ đó', () => {
    const team = [member('u1', 'Nguyễn Văn A'), ...TEAM];
    expect(matchAssignee('A', team)).toBeNull();
    expect(matchAssignee('Nguyễn Văn A', team)).toBe('u1'); // cả tên thì vẫn khớp
  });

  it('danh sách thành viên rỗng → null', () => {
    expect(matchAssignee('Bình', [])).toBeNull();
  });

  it('thứ tự thành viên không ảnh hưởng kết quả', () => {
    const reversed = [...TEAM].reverse();
    for (const owner of ['Bình', 'anh Lan', 'Đức', 'hoàng']) {
      expect(matchAssignee(owner, reversed)).toBe(matchAssignee(owner, TEAM));
    }
  });
});
