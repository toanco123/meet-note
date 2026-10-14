/**
 * `{ before, after }` cho audit, CHỈ gồm field thực sự đổi. Field không gửi (`undefined`) bị bỏ qua;
 * `null` là giá trị thật (vd xoá mô tả). Rỗng → caller không ghi gì, không log.
 */
export function diffForAudit<T extends object>(
  current: T,
  patch: Partial<T>,
): { before: Partial<T>; after: Partial<T> } {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (patch[key] !== undefined && patch[key] !== current[key]) {
      before[key] = current[key];
      after[key] = patch[key];
    }
  }
  return { before, after };
}

export function isEmptyDiff(diff: { after: object }): boolean {
  return Object.keys(diff.after).length === 0;
}
