import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Test KIẾN TRÚC: thư mục theo vai trò (07-conventions §1, 02-architecture §3).
 *
 * Trong một thư mục, từ 2 file cùng vai trò trở lên thì gom vào thư mục vai trò:
 * `*.service.ts` → `services/`, `*.repository.ts` → `repositories/`,
 * `*.controller.ts` → `controllers/`, `*.types.ts` → `types/`. Thư mục vai trò chỉ chứa đúng vai trò đó.
 * Áp dụng cho cả `src/` lẫn cây test mô phỏng nó (`*.service.spec.ts`, `*.service.int-spec.ts`…).
 */
const ROLES = {
  service: 'services',
  repository: 'repositories',
  controller: 'controllers',
  types: 'types',
} as const;
type Role = keyof typeof ROLES;

const ROLE_OF = /\.(service|repository|controller|types)(?:\.spec|\.int-spec)?\.ts$/;

function filesUnder(root: string): string[] {
  return readdirSync(join(import.meta.dirname, '../../..', root), {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `${root}/${file.split('\\').join('/')}`);
}

const roots = ['src', 'test/unit', 'test/integration'];

describe('Thư mục theo vai trò', () => {
  it('không thư mục nào có từ 2 file cùng vai trò nằm lẫn (phải gom vào thư mục vai trò)', () => {
    const groups = new Map<string, string[]>();
    for (const file of roots.flatMap(filesUnder)) {
      const role = ROLE_OF.exec(file)?.[1] as Role | undefined;
      const dir = dirname(file);
      if (!role || basename(dir) === ROLES[role]) continue;
      const key = `${dir} → cần ${ROLES[role]}/`;
      groups.set(key, [...(groups.get(key) ?? []), basename(file)]);
    }
    const offenders = [...groups].filter(([, files]) => files.length > 1).map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('thư mục vai trò chỉ chứa đúng vai trò đó', () => {
    const roleDirs = Object.entries(ROLES) as Array<[Role, string]>;
    const offenders = roots.flatMap(filesUnder).filter((file) => {
      const entry = roleDirs.find(([, dir]) => basename(dirname(file)) === dir);
      return entry !== undefined && ROLE_OF.exec(file)?.[1] !== entry[0];
    });
    expect(offenders).toEqual([]);
  });

  it('quét thật sự thấy thư mục vai trò', () => {
    expect(filesUnder('src').some((file) => file.includes('/services/'))).toBe(true);
  });
});
