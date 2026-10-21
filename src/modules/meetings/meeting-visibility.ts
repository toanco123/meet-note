import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import {
  channelMembers,
  channels,
  meetings,
  meetingShares,
} from '../../infra/database/schema/index.js';
import { isOrgRoleAtLeast, OrgRole } from '../organizations/organization.policy.js';
import type { MeetingViewer } from './meetings.types.js';

/**
 * ĐIỀU KIỆN XEM MEETING — một nơi duy nhất (04 §3). Chi tiết, danh sách, danh sách theo kênh,
 * và sau này search (M8), báo cáo (M9) đều ghép đúng biểu thức này; không chỗ nào tự lọc kiểu khác.
 *
 * Meeting chưa xoá, VÀ một trong:
 * 1. người xem là chủ;
 * 2. được share vào một kênh CHƯA XOÁ mà người xem là thành viên (mọi vai trò, kể cả khách);
 * 3. được share vào một kênh công khai chưa xoá (người xem là thành viên org — guard đã kiểm,
 *    caller lọc `org_id`). Kênh LƯU TRỮ vẫn tính: lưu trữ = chỉ đọc (M6b Q1);
 * 4. meeting KHÔNG CHỦ (chủ đã rời org) và người xem là Owner / Admin org (D16, M6b Q2).
 *
 * OrgAdm KHÔNG có quyền đọc nội dung kênh riêng tư mình không ở trong (D2) — nên điều 2 không có
 * nhánh "hoặc là OrgAdm".
 *
 * TIỀN ĐIỀU KIỆN: người xem LÀ thành viên org đang query và `orgRole` là vai trò thật — do
 * `OrgMemberGuard` bảo đảm. Biểu thức không tự kiểm membership (điều 3 / 4 sẽ mở cho người ngoài
 * nếu bỏ qua guard). Dùng ở chỗ không có guard (vd job của worker) thì phải tự kiểm trước.
 *
 * Tham chiếu `meetings.id` từ bên trong `EXISTS` (subquery tương quan) → caller phải query từ
 * bảng `meetings` không đặt alias.
 */
export function meetingVisibleTo(viewer: MeetingViewer): SQL {
  const sharedIntoVisibleChannel = sql`exists (
    select 1
    from ${meetingShares}
    join ${channels} on ${channels.id} = ${meetingShares.channelId}
    where ${meetingShares.meetingId} = ${meetings.id}
      and ${channels.deletedAt} is null
      and (
        ${channels.visibility} = 'public'
        or exists (
          select 1 from ${channelMembers}
          where ${channelMembers.channelId} = ${channels.id}
            and ${channelMembers.userId} = ${viewer.userId}
        )
      )
  )`;
  const ways: SQL[] = [eq(meetings.ownerId, viewer.userId), sharedIntoVisibleChannel];
  if (isOrgRoleAtLeast(viewer.orgRole, OrgRole.Admin)) ways.push(isNull(meetings.ownerId));
  return and(isNull(meetings.deletedAt), or(...ways)) as SQL;
}
