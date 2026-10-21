import { Injectable } from '@nestjs/common';
import type { AccessScope } from '../../infra/realtime/realtime.types.js';
import { MeetingsRepository } from '../meetings/repositories/meetings.repository.js';
import { OrganizationsRepository } from '../organizations/repositories/organizations.repository.js';

/**
 * Ai được ở trong room `meeting:{id}`: đúng điều kiện xem của REST (`meetingVisibleTo`, M6b) — một
 * nguồn sự thật cho cả hai đường. Socket không có org trên path như REST → tự tìm org của meeting,
 * rồi membership của người gọi trong org đó bằng CHÍNH hàm `OrgMemberGuard` dùng (`findMembership`:
 * loại org đã xoá) — biểu thức xem có tiền điều kiện "người xem thuộc org" (M6b bài học 1).
 */
@Injectable()
export class RealtimeSubscriptionsService {
  constructor(
    private readonly meetings: MeetingsRepository,
    private readonly orgs: OrganizationsRepository,
  ) {}

  async canView(userId: string, meetingId: string): Promise<boolean> {
    const meeting = await this.meetings.findById(meetingId);
    if (!meeting) return false;
    const membership = await this.orgs.findMembership(meeting.orgId, userId);
    if (!membership) return false;
    const visible = await this.meetings.findVisible(
      meeting.orgId,
      { userId, orgRole: membership.role },
      meetingId,
    );
    return visible !== undefined;
  }

  /**
   * Trong các meeting đang có subscriber ở instance này, những cái bị phạm vi `scope` (kênh / org)
   * đụng tới. Chỉ hỏi DB về đúng các id đó — không quét mọi meeting của kênh / org.
   */
  async meetingsInScope(
    scope: Extract<AccessScope, { kind: 'channel' | 'org' }>,
    subscribed: string[],
  ): Promise<string[]> {
    return scope.kind === 'channel'
      ? this.meetings.filterSharedInChannel(scope.channelId, subscribed)
      : this.meetings.filterInOrg(scope.orgId, subscribed);
  }
}
