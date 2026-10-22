import { and, desc, eq, exists, gte, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../../infra/database/database.types.js';
import { meetings, meetingShares } from '../../infra/database/schema/index.js';
import { isOrgRoleAtLeast, OrgRole } from '../organizations/organization.policy.js';
import type { ListVisibleMeetingsParams, VisibleChannels } from './meetings.types.js';

/**
 * ỨNG VIÊN cho một trang danh sách meeting (M11 B5) — id của tối đa `n` meeting từ mỗi LUỒNG có
 * trần, cùng khoá sắp `(recorded_at DESC, id DESC)`:
 * 1. meeting CỦA người xem (điều 1 của 04 §3) — `meetings_org_owner_recorded_idx`;
 * 2. meeting share vào kênh người xem THẤY (điều 2 / 3) — hai hình dạng, xem dưới;
 * 3. meeting KHÔNG CHỦ nếu là Owner / Admin org (điều 4) — `meetings_org_ownerless_recorded_idx`.
 *
 * `n` dòng đầu của tập hợp chắc chắn nằm trong hợp `n` dòng đầu của từng luồng — với điều kiện mỗi
 * luồng TỰ áp đủ bộ lọc (chưa xoá, status, from / to, cursor). Lọc ở ngoài sau khi cắt `n` thì trang
 * có thể thiếu dòng và `nextCursor` null trong khi còn dữ liệu — phân trang dừng sớm âm thầm.
 *
 * Luồng 2 — chọn theo số kênh thấy được `k` trên tổng `K` kênh của org; `s` = tỉ lệ meeting qua bộ
 * lọc (status…). Theo TỪNG kênh (`LATERAL`, `meeting_shares_channel_recorded_idx`) đọc ≈ k·n/s dòng;
 * đi MỘT lượt theo thời gian trên cả org rồi kiểm "có share vào kênh thấy được" đọc ≈ n/(s·k/K)
 * dòng. Cái đầu rẻ hơn khi k·n/s < n·K/(s·k) ⇔ **k² < K**. Đo (M11 bài học 12): dày 150/200 kênh
 * + lọc status — theo từng kênh 59 ms, một lượt ≈ 1 ms; thưa 7 kênh thì ngược lại.
 */
export function visibleMeetingCandidates(
  db: Database,
  p: ListVisibleMeetingsParams,
  n: number,
  visible: VisibleChannels,
): SQL | undefined {
  const m = alias(meetings, 'm');
  const ms = alias(meetingShares, 'ms');

  /** Bộ lọc của request trên một luồng; `recordedAt` / `id` là cột luồng đó sắp theo. */
  const filters = (recordedAt: PgColumn, id: PgColumn): Array<SQL | undefined> => [
    isNull(m.deletedAt),
    p.status ? eq(m.status, p.status) : undefined,
    p.from ? gte(recordedAt, p.from) : undefined,
    p.to ? lt(recordedAt, p.to) : undefined,
    p.after
      ? sql`(${recordedAt}, ${id}) < (${p.after.recordedAt}::timestamptz, ${p.after.id}::uuid)`
      : undefined,
  ];
  const orgWalk = (...where: Array<SQL | undefined>) =>
    db
      .select({ id: m.id })
      .from(m)
      .where(and(eq(m.orgId, p.orgId), ...where, ...filters(m.recordedAt, m.id)))
      .orderBy(desc(m.recordedAt), desc(m.id))
      .limit(n)
      .getSQL();

  const streams: SQL[] = [];
  // Lọc theo kênh: service đã kiểm người xem đọc được nội dung kênh đó → mọi meeting (chưa xoá)
  // của kênh đều xem được (điều 2 / 3) — chỉ cần luồng 2.
  if (!p.channelId) {
    streams.push(orgWalk(eq(m.ownerId, p.viewer.userId)));
    if (isOrgRoleAtLeast(p.viewer.orgRole, OrgRole.Admin)) streams.push(orgWalk(isNull(m.ownerId)));
  }
  const ids = sql`${sql.param(visible.ids)}::uuid[]`; // MỘT tham số mảng — không trải thành ($1, $2, …)
  if (visible.ids.length > 0 && visible.ids.length ** 2 < visible.total) {
    const perChannel = db
      // BẪY: khoá `id` trong `select({ id: ms.meetingId })` chỉ là tên field phía JS — SQL vẫn ra
      // `"ms"."meeting_id"` → `s.id` không tồn tại. Đặt alias SQL tường minh.
      .select({ id: sql<string>`${ms.meetingId}`.as('id') })
      .from(ms)
      .innerJoin(m, eq(m.id, ms.meetingId))
      .where(and(sql`${ms.channelId} = vc.id`, ...filters(ms.recordedAt, ms.meetingId)))
      .orderBy(desc(ms.recordedAt), desc(ms.meetingId))
      .limit(n);
    streams.push(
      sql`select s.id from unnest(${ids}) as vc(id) cross join lateral (${perChannel}) s`,
    );
  } else if (visible.ids.length > 0) {
    streams.push(
      orgWalk(
        exists(
          db
            .select({ one: sql`1` })
            .from(ms)
            .where(and(eq(ms.meetingId, m.id), sql`${ms.channelId} = any(${ids})`)),
        ),
      ),
    );
  }
  if (streams.length === 0) return undefined; // không thấy kênh nào, không có luồng nào → trang rỗng
  return sql.join(
    streams.map((s) => sql`(${s})`),
    sql` union all `,
  );
}
