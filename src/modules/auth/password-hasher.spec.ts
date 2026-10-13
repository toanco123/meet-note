import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS, PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('băm bằng argon2id với tham số OWASP, mỗi lần một salt khác', async () => {
    const a = await hasher.hash('mat-khau-dai-du');
    const b = await hasher.hash('mat-khau-dai-du');

    // Chuỗi PHC: $argon2id$v=19$<tham số>$<salt>$<hash>. Thứ tự tham số do thư viện quyết định.
    const params = a.split('$')[3]?.split(',').sort();
    expect(a.startsWith('$argon2id$v=19$')).toBe(true);
    expect(params).toEqual(['m=19456', 'p=1', 't=2']);
    expect(a).not.toBe(b); // salt ngẫu nhiên
  });

  it('verify đúng/sai mật khẩu', async () => {
    const hash = await hasher.hash('Đúng-mật-khẩu-123');

    await expect(hasher.verify(hash, 'Đúng-mật-khẩu-123')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'đúng-mật-khẩu-123')).resolves.toBe(false);
  });

  it('hash hỏng định dạng → false, không ném lỗi', async () => {
    await expect(hasher.verify('not-a-phc-string', 'x')).resolves.toBe(false);
  });

  it('needsRehash: hash cũ với tham số yếu hơn → true; hash hiện tại → false', async () => {
    const weak = await argon2.hash('x', { ...ARGON2_OPTIONS, memoryCost: 8192, timeCost: 1 });
    const current = await hasher.hash('x');

    expect(hasher.needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(current)).toBe(false);
  });

  it('verifyDummy chạy argon2 thật (tốn thời gian tương đương verify) và không ném lỗi', async () => {
    const hash = await hasher.hash('abc12345');
    await hasher.verifyDummy('khoi-dong'); // lần đầu tạo dummy hash

    const t0 = performance.now();
    await hasher.verify(hash, 'sai-mat-khau');
    const real = performance.now() - t0;

    const t1 = performance.now();
    await hasher.verifyDummy('sai-mat-khau');
    const dummy = performance.now() - t1;

    // Không so sát nút (đo thời gian dễ dao động) — chỉ chắc chắn dummy KHÔNG trả về tức thì.
    expect(dummy).toBeGreaterThan(real * 0.3);
  });
});
