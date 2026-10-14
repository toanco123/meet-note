import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Test KIẾN TRÚC: interface / type viết tay nằm trong `<module>.types.ts` (07-conventions §1).
 *
 * - Ngoài `*.types.ts`: không `export interface`; `export type` chỉ khi là kiểu SUY RA từ một giá
 *   trị — vế phải có `typeof` (`(typeof X)[number]`, `typeof t.$inferSelect`, `keyof typeof policy`),
 *   hoặc là cặp const/type cùng tên (`export const OrgRole = {…}` + `export type OrgRole`). Tách
 *   những kiểu này khỏi giá trị gốc thì hai thứ "là một" bị chia đôi, sửa một bên dễ quên bên kia.
 * - Trong `*.types.ts`: chỉ có kiểu, không có giá trị runtime.
 * - Kiểu KHÔNG export (chi tiết nội bộ một file) được để tại chỗ.
 */
const SRC = join(import.meta.dirname, '../../../src');

function sourceFiles(): Array<{ file: string; code: string }> {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({
      file: file.split('\\').join('/'),
      code: readFileSync(join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    }));
}

const isTypesFile = (file: string) => file.endsWith('.types.ts');

describe('Vị trí interface / type', () => {
  it('ngoài *.types.ts không có `export interface`', () => {
    const offenders = sourceFiles()
      .filter(({ file }) => !isTypesFile(file))
      .flatMap(({ file, code }) =>
        [...code.matchAll(/^export interface (\w+)/gm)].map((m) => `${file}: ${m[1]}`),
      );
    expect(offenders, 'Chuyển vào <module>.types.ts').toEqual([]);
  });

  it('ngoài *.types.ts chỉ có `export type` SUY RA từ giá trị', () => {
    const offenders = sourceFiles()
      .filter(({ file }) => !isTypesFile(file))
      .flatMap(({ file, code }) =>
        [...code.matchAll(/^export type (\w+)(?:<[^=]*>)?\s*=([^;]*);/gm)]
          .filter(([, name, rhs]) => {
            const derived = rhs?.includes('typeof') ?? false;
            const pairedWithConst = new RegExp(`^export const ${name}\\b`, 'm').test(code);
            return !derived && !pairedWithConst;
          })
          .map(([, name]) => `${file}: ${name}`),
      );
    expect(offenders, 'Kiểu viết tay → <module>.types.ts').toEqual([]);
  });

  it('*.types.ts không chứa giá trị runtime', () => {
    const offenders = sourceFiles()
      .filter(({ file }) => isTypesFile(file))
      .flatMap(({ file, code }) =>
        [
          ...code.matchAll(
            /^export (?:const|let|var|function|async function|class|abstract class|enum|default)\b\s*(\w*)/gm,
          ),
        ].map((m) => `${file}: ${m[1]}`),
      );
    expect(offenders, 'Giá trị runtime không thuộc file types').toEqual([]);
  });

  it('quét thật sự có file types', () => {
    expect(sourceFiles().filter(({ file }) => isTypesFile(file)).length).toBeGreaterThan(5);
  });
});
