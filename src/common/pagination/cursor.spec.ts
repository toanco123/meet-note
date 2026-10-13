import { describe, expect, it } from 'vitest';
import { AppException } from '../errors/app.exception.js';
import { decodeCursor, encodeCursor, toPage } from './cursor.js';

describe('cursor codec', () => {
  it('round-trip giữ nguyên khoá, kể cả timestamp micro giây dạng string', () => {
    const keys = ['2026-10-13 08:00:00.123456+07', '0199d7a2-6a8b-7c3d-9e0f-112233445566'];
    expect(decodeCursor(encodeCursor(keys), 2)).toEqual(keys);
  });

  it('cursor là chuỗi an toàn cho URL', () => {
    expect(encodeCursor(['a/b+c=='])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['không phải base64 JSON', 'not-a-cursor'],
    ['JSON nhưng sai cấu trúc', Buffer.from('{"x":1}').toString('base64url')],
    ['sai version', Buffer.from('{"v":2,"k":["a"]}').toString('base64url')],
    ['khoá không phải string/number', Buffer.from('{"v":1,"k":[{"a":1}]}').toString('base64url')],
  ])('từ chối %s', (_label, cursor) => {
    expect(() => decodeCursor(cursor, 1)).toThrow(AppException);
  });

  it('từ chối cursor có số khoá khác danh sách đang gọi', () => {
    const cursor = encodeCursor(['a', 'b']);
    expect(() => decodeCursor(cursor, 3)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
    );
  });
});

describe('toPage', () => {
  const rows = [1, 2, 3, 4].map((n) => ({ id: `id-${n}`, n }));

  it('có dòng thừa → cắt về đúng limit, nextCursor trỏ vào dòng cuối của trang', () => {
    const page = toPage(rows, 3, (r) => [r.n, r.id]);

    expect(page.data.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '', 2)).toEqual([3, 'id-3']);
  });

  it('không có dòng thừa → trang cuối, nextCursor = null', () => {
    const page = toPage(rows, 4, (r) => [r.id]);
    expect(page.data).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
  });

  it('danh sách rỗng', () => {
    expect(toPage([], 20, () => [])).toEqual({ data: [], nextCursor: null });
  });
});
