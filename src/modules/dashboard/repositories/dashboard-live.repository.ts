import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import { REPORT_TIME_ZONE } from '../../reports/report-week.js';
import type {
  ActionItemCounts,
  MemberCounts,
  StorageUsage,
  TopChannel,
} from '../dashboard.types.js';

/** Đầu khoảng: 00:00 giờ VN của ngày lịch `day` (đổi NGÀY LỊCH → thời điểm, không phụ thuộc TimeZone session). */
const startOf = (day: string): SQL =>
  sql`(${day}::date)::timestamp at time zone ${REPORT_TIME_ZONE}`;
/** Cuối khoảng (loại trừ): 00:00 VN của NGÀY SAU `day`. Cộng 1 ngày trên ngày lịch rồi mới đổi múi giờ. */
const endOf = (day: string): SQL =>
  sql`((${day}::date + 1))::timestamp at time zone ${REPORT_TIME_ZONE}`;

/**
 * Số liệu dashboard KHÔNG cộng dồn được (người hoạt động khác nhau giữa các ngày, dung lượng là ảnh
 * chụp hiện tại…) nên tính trực tiếp từ bảng nguồn, không qua rollup (M17 Q-live). Mọi hàm lọc
 * `org_id` TƯỜNG MINH, không trông cậy vào RLS; khoảng ngày là ngày lịch giờ VN, gồm cả hai đầu.
 * Chỉ trả số đếm, không trả tiêu đề / nội dung / tên người.
 */
@Injectable()
export class DashboardLiveRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * `total` = số dòng `organization_members`. `active` = số chủ meeting KHÁC NHAU có meeting (chưa xoá)
   * ghi trong khoảng — chưa có lịch sử đăng nhập nên "hoạt động" = đã sở hữu một cuộc họp trong kỳ.
   * `owner_id` NULL (chủ đã rời org) không bao giờ được đếm.
   */
  async memberCounts(
    orgId: string,
    from: string,
    to: string,
    executor: DbExecutor = this.db,
  ): Promise<MemberCounts> {
    const result = await executor.execute<{ total: number; active: number }>(sql`
      select
        (select count(*)::int from organization_members where org_id = ${orgId}::uuid) as total,
        (select count(distinct owner_id)::int
           from meetings
          where org_id = ${orgId}::uuid
            and deleted_at is null
            and owner_id is not null
            and recorded_at >= ${startOf(from)}
            and recorded_at < ${endOf(to)}) as active
    `);
    const row = result.rows[0];
    return { total: row?.total ?? 0, active: row?.active ?? 0 };
  }

  /**
   * Dung lượng hiện tại: tổng `uploads.size_bytes` của upload `completed` (file đã được ghép xong
   * trên S3; `initiated` còn dở, `aborted` / `expired` đã bị huỷ phần) gắn với meeting chưa xoá.
   * Schema ép `completed ⇔ meeting_id not null` và mỗi meeting đúng một upload.
   *
   * `sum(bigint)` là `numeric` → `pg` trả chuỗi; đổi sang number. Số chính xác tới 2^53 - 1 byte
   * (~8 PiB), dư xa so với một tổ chức; vượt thì ném lỗi chứ không làm tròn lặng lẽ.
   */
  async storage(orgId: string, executor: DbExecutor = this.db): Promise<StorageUsage> {
    const result = await executor.execute<{ bytes: string; meetings: number }>(sql`
      select coalesce(sum(u.size_bytes), 0)::text as bytes,
             count(distinct u.meeting_id)::int as meetings
        from uploads u
        join meetings m on m.id = u.meeting_id and m.org_id = u.org_id
       where u.org_id = ${orgId}::uuid
         and u.status = 'completed'
         and u.meeting_id is not null
         and m.deleted_at is null
    `);
    const row = result.rows[0];
    const bytes = Number(row?.bytes ?? 0);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Tổng dung lượng vượt 2^53 - 1 byte');
    return { bytes, meetings: row?.meetings ?? 0 };
  }

  /**
   * Top kênh theo số meeting (chưa xoá) được chia sẻ vào kênh có `recorded_at` trong khoảng (dùng bản
   * chép `meeting_shares.recorded_at`). Kênh riêng tư / lưu trữ vẫn tính (Owner / Admin đã thấy mọi
   * metadata kênh), kênh đã xoá thì không; kênh 0 meeting không xuất hiện. Thứ tự: số meeting giảm,
   * tên tăng, id tăng. Một meeting chia sẻ vào hai kênh được đếm một lần ở mỗi kênh.
   */
  async topChannels(
    orgId: string,
    from: string,
    to: string,
    limit: number,
    executor: DbExecutor = this.db,
  ): Promise<TopChannel[]> {
    const result = await executor.execute<{
      channel_id: string;
      name: string;
      meetings: number;
    }>(sql`
      select c.id as channel_id, c.name, count(distinct ms.meeting_id)::int as meetings
        from meeting_shares ms
        join meetings m on m.id = ms.meeting_id and m.org_id = ms.org_id
        join channels c on c.id = ms.channel_id and c.org_id = ms.org_id
       where ms.org_id = ${orgId}::uuid
         and m.deleted_at is null
         and c.deleted_at is null
         and ms.recorded_at >= ${startOf(from)}
         and ms.recorded_at < ${endOf(to)}
       group by c.id, c.name
       order by meetings desc, c.name asc, c.id asc
       limit ${limit}
    `);
    return result.rows.map((r) => ({
      channelId: r.channel_id,
      name: r.name,
      meetings: r.meetings,
    }));
  }

  /**
   * Số việc của meeting chưa xoá. `open` = đang mở; `overdue` = đang mở và hạn < `today` (hạn đúng
   * hôm nay CHƯA quá hạn — cùng quy ước M12; `today` là 'YYYY-MM-DD' giờ VN do người gọi truyền);
   * `doneInRange` = đã xong với `completed_at` trong khoảng. `dismissed` không nằm trong số nào.
   */
  async actionItemCounts(
    orgId: string,
    today: string,
    from: string,
    to: string,
    executor: DbExecutor = this.db,
  ): Promise<ActionItemCounts> {
    const result = await executor.execute<{
      open: number;
      overdue: number;
      done_in_range: number;
    }>(sql`
      select
        count(*) filter (where a.status = 'open')::int as open,
        count(*) filter (where a.status = 'open' and a.due_date < ${today}::date)::int as overdue,
        count(*) filter (
          where a.status = 'done'
            and a.completed_at >= ${startOf(from)}
            and a.completed_at < ${endOf(to)}
        )::int as done_in_range
        from action_items a
        join meetings m on m.id = a.meeting_id and m.org_id = a.org_id
       where a.org_id = ${orgId}::uuid
         and m.deleted_at is null
    `);
    const row = result.rows[0];
    return {
      open: row?.open ?? 0,
      overdue: row?.overdue ?? 0,
      doneInRange: row?.done_in_range ?? 0,
    };
  }
}
