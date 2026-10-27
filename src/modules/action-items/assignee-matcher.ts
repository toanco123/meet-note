import type { OrgMemberName } from './action-items.types.js';

/**
 * Xưng hô đứng đầu tên người ("anh Bình", "chị Lan"). Chỉ bỏ khi SAU ĐÓ còn chữ, và chỉ ở bước khớp
 * thứ hai — nên thành viên tên thật là "Anh Tuấn" vẫn khớp nguyên văn ở bước một.
 */
const HONORIFICS = new Set([
  'anh',
  'chi',
  'em',
  'co',
  'chu',
  'bac',
  'thay',
  'ong',
  'ba',
  'mr',
  'ms',
]);

/** Tên gọi ngắn hơn ngần này ký tự (vd "A", "B") quá mơ hồ để dùng làm khoá khớp. */
const MIN_GIVEN_NAME_LENGTH = 2;

/**
 * Chuẩn hoá để so tên: bỏ dấu (kể cả đ → d), chữ thường, bỏ dấu câu, gộp khoảng trắng. Độc lập với
 * Postgres (`f_unaccent`) — hàm thuần, test bằng bảng.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHonorific(normalized: string): string {
  const [first, ...rest] = normalized.split(' ');
  return first !== undefined && HONORIFICS.has(first) && rest.length > 0
    ? rest.join(' ')
    : normalized;
}

/**
 * Map tên người phụ trách model nêu ("Bình", "anh Bình", "Nguyễn Văn Bình") sang MỘT thành viên org,
 * hoặc `null` (M12 Q4). Nguyên tắc: **không bao giờ đoán** — giao nhầm việc tệ hơn để trống, vì người
 * dùng giao tay chỉ mất vài giây còn việc nằm sai người thì không ai biết.
 *
 * Hai bậc, dừng ở bậc đầu có ứng viên:
 * 1. trùng CẢ tên (sau chuẩn hoá; thử cả bản có và không có xưng hô);
 * 2. trùng TÊN GỌI — từ cuối của họ tên, kiểu "Bình" ↔ "Nguyễn Văn Bình" — khi tên model nêu là một từ.
 * Mỗi bậc phải ra **đúng một** người. Nhiều người → `null`, và KHÔNG tụt xuống bậc dưới (hai "Bình"
 * thì vẫn là hai "Bình", dù một người có thể khớp cả tên ở bậc khác).
 */
export function matchAssignee(
  ownerName: string | null,
  members: readonly OrgMemberName[],
): string | null {
  if (ownerName === null) return null;
  const full = normalizeName(ownerName);
  if (full === '') return null;
  const stripped = stripHonorific(full);
  const keys = new Set([full, stripped]);

  const normalized = members.map((m) => ({ id: m.userId, name: normalizeName(m.displayName) }));

  const byFullName = normalized.filter((m) => keys.has(m.name));
  if (byFullName.length > 0) return byFullName.length === 1 ? byFullName[0]!.id : null;

  // Bậc 2 chỉ có nghĩa khi tên model nêu là MỘT từ: so một từ với chuỗi nhiều từ thì không bao giờ bằng
  // nhau nên không cần kiểm riêng. Tên gọi 1 ký tự ("A", "B") quá mơ hồ để làm khoá.
  if (stripped.length < MIN_GIVEN_NAME_LENGTH) return null;
  const byGivenName = normalized.filter((m) => m.name.split(' ').at(-1) === stripped);
  return byGivenName.length === 1 ? byGivenName[0]!.id : null;
}
