import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  safeFileBase,
} from '../../../../src/modules/transcripts/transcript-filename.js';
import { coalesce } from '../../../../src/modules/transcripts/transcript-formats.js';

const ID = '01a16185-7123-7052-b52a-dfddd7dfb0db';

describe('safeFileBase', () => {
  it.each([
    ['Họp kế hoạch quý ba', 'Họp kế hoạch quý ba'],
    ['  nhiều   khoảng\ttrắng ', 'nhiều khoảng trắng'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j'],
    ['dòng 1\r\nSet-Cookie: x=1', 'dòng 1 Set-Cookie x=1'], // CR LF không lọt
    ['..', `meeting-${ID}`],
    ['.ẩn.', 'ẩn'],
    ['', `meeting-${ID}`],
    ['   ', `meeting-${ID}`],
    ['\u0000\u0007', `meeting-${ID}`],
  ])('%j → %j', (title, expected) => {
    expect(safeFileBase(title, ID)).toBe(expected);
  });

  it('cắt 80 ký tự Unicode, không cắt giữa cặp thay thế (emoji)', () => {
    const out = safeFileBase('😀'.repeat(100), ID);
    expect([...out]).toHaveLength(80);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // không có nửa cặp mồ côi
  });
});

describe('contentDisposition', () => {
  it('có bản ASCII (bỏ dấu, đ → d) và bản UTF-8 mã hoá phần trăm', () => {
    expect(contentDisposition('Họp Đà Nẵng', ID, 'srt')).toBe(
      `attachment; filename="Hop Da Nang.srt"; filename*=UTF-8''H%E1%BB%8Dp%20%C4%90%C3%A0%20N%E1%BA%B5ng.srt`,
    );
  });

  it('tiêu đề độc: không tạo thêm header, không thoát khỏi dấu nháy', () => {
    const header = contentDisposition('x"; filename="evil.exe\r\nX-Injected: 1', ID, 'vtt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2); // đúng một cặp nháy quanh filename
    // `;` `=` còn lại nhưng nằm TRONG dấu nháy (bản ASCII đổi thành `_`), nháy kép đã bị bỏ.
    expect(header).toContain('filename="x _ filename_ evil.exe X-Injected 1.vtt"');
  });

  it("mã hoá cả ' ( ) theo RFC 5987 (encodeURIComponent để nguyên); `*` đã bị lọc từ tên", () => {
    expect(contentDisposition("it's (a) b*", ID, 'srt')).toContain(
      "UTF-8''it%27s%20%28a%29%20b.srt",
    );
  });

  it('ký tự ngoài ASCII không có dạng bỏ dấu → `_` ở bản ASCII, giữ nguyên ở bản UTF-8', () => {
    const header = contentDisposition('会议', ID, 'srt');
    expect(header).toContain('filename="__.srt"');
    expect(header).toContain("filename*=UTF-8''%E4%BC%9A%E8%AE%AE.srt");
  });
});

describe('coalesce', () => {
  async function* source(parts: string[]) {
    yield* parts;
  }
  const collect = async (gen: AsyncGenerator<string>) => {
    const out: string[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  };

  it('gộp tới khi đủ ngưỡng, ghi nốt phần dư, không mất / đổi thứ tự byte', async () => {
    const chunks = await collect(coalesce(source(['aa', 'bb', 'cc', 'dd', 'e']), 5));
    expect(chunks).toEqual(['aabbcc', 'dde']);
    expect(chunks.join('')).toBe('aabbccdde');
  });

  it('nguồn rỗng → không có khối nào (không ghi chuỗi rỗng)', async () => {
    expect(await collect(coalesce(source([]), 5))).toEqual([]);
  });
});
