import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Test KIẾN TRÚC: mọi lỗi trả về client được tạo trong catalog `src/common/errors/errors.ts`,
 * để thông điệp nằm một chỗ, cùng ý thì cùng câu, và đổi câu chữ / đa ngôn ngữ chỉ sửa một file.
 *
 * Kiểu dữ liệu không chặn được `new AppException(...)` ở file khác, nên test này quét mã nguồn.
 */
const SRC = join(import.meta.dirname, '../../../src');
const CATALOG = 'common/errors/errors.ts';

/** Bỏ comment trước khi quét: tài liệu được phép nhắc tới `new AppException(...)`. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.split('\\').join('/'));
}

/** `new AppException(` hoặc ném thẳng exception có sẵn của Nest (`throw new NotFoundException(`…). */
const FORBIDDEN_OUTSIDE_CATALOG =
  /new AppException\(|throw new (BadRequest|Unauthorized|Forbidden|NotFound|Conflict|Gone|InternalServerError)Exception\(/;

describe('Catalog lỗi', () => {
  it('không file nào ngoài errors.ts tự tạo lỗi trả về client', () => {
    const offenders = sourceFiles()
      .filter((file) => file !== CATALOG)
      .filter((file) =>
        FORBIDDEN_OUTSIDE_CATALOG.test(stripComments(readFileSync(join(SRC, file), 'utf8'))),
      )
      .map((file) => relative(process.cwd(), join(SRC, file)));

    expect(
      offenders,
      'Dùng `Errors.<domain>.<tình huống>()` trong src/common/errors/errors.ts',
    ).toEqual([]);
  });

  it('quét thật sự có file (đường dẫn SRC đúng) và catalog có mặt', () => {
    expect(sourceFiles()).toContain(CATALOG);
  });
});
