/** uuid dạng chuẩn 8-4-4-4-12 (mọi version). Dùng ở chỗ pipe chưa chạy kịp (guard, cursor). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
