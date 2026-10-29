import { Injectable } from '@nestjs/common';
import { decodeCursor, toPage } from '../../../common/pagination/cursor.js';
import { expectDateKey, expectUuidKey } from '../../../common/pagination/keys.js';
import type { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import { MeetingsService, viewerOf } from '../../meetings/services/meetings.service.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import { localDate } from '../../reports/report-week.js';
import { ActionItemsRepository } from '../action-items.repository.js';
import { ActionItemResponseDto } from '../dto/action-item-response.dto.js';
import type { ListActionItemsQueryDto } from '../dto/list-action-items-query.dto.js';

/** Khoá cursor của việc KHÔNG hạn: chuỗi rỗng (cursor chỉ chứa chuỗi / số). */
const NO_DUE = '';

@Injectable()
export class ActionItemsService {
  constructor(
    private readonly repo: ActionItemsRepository,
    private readonly meetings: MeetingsService,
  ) {}

  /**
   * Việc của MỘT meeting, theo thứ tự tạo. Quyền = quyền XEM meeting (không xem được → 404, như chi tiết
   * và transcript). Meeting chưa `completed` chưa có việc → trang rỗng, không phải 409: danh sách rỗng
   * là câu trả lời đúng và client không cần xử lý riêng.
   */
  async listForMeeting(
    membership: OrgMembershipContext,
    userId: string,
    meetingId: string,
    query: CursorQueryDto,
  ): Promise<Page<ActionItemResponseDto>> {
    await this.meetings.assertVisible(membership, userId, meetingId);
    const after = query.cursor ? decodeCursor(query.cursor, 1) : undefined;
    const rows = await this.repo.listForMeeting(
      meetingId,
      after && expectUuidKey(after[0]),
      query.limit,
    );
    const page = toPage(rows, query.limit, (row) => [row.item.id]);
    return {
      data: page.data.map((row) => ActionItemResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Việc xuyên meeting trong tổ chức, chỉ của meeting người gọi XEM ĐƯỢC. `assignee=me` là "việc của
   * tôi". Mặc định chỉ việc `open`. "Quá hạn" tính theo NGÀY LỊCH giờ VN (cùng cách tính tuần báo cáo,
   * M9): việc hạn hôm nay chưa quá hạn.
   */
  async listVisible(
    membership: OrgMembershipContext,
    userId: string,
    query: ListActionItemsQueryDto,
  ): Promise<Page<ActionItemResponseDto>> {
    if (query.channelId) {
      await this.meetings.assertChannelContentReadable(membership, userId, query.channelId);
    }
    const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
    const rows = await this.repo.listVisible({
      orgId: membership.orgId,
      viewer: viewerOf(membership, userId),
      assignedToViewer: query.assignee === 'me',
      status: query.status ?? 'open',
      overdueBefore: query.overdue ? localDate(new Date()) : undefined,
      channelId: query.channelId,
      after: after && {
        dueDate: after[0] === NO_DUE ? null : expectDateKey(after[0]),
        id: expectUuidKey(after[1]),
      },
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.item.dueDate ?? NO_DUE, row.item.id]);
    return {
      data: page.data.map((row) => ActionItemResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }
}
