import { Injectable } from '@nestjs/common';
import { OrgContext } from '../../infra/database/org-context.js';
import type { AccessScope } from '../../infra/realtime/realtime.types.js';
import { MeetingsRepository } from '../meetings/repositories/meetings.repository.js';
import { OrganizationsRepository } from '../organizations/repositories/organizations.repository.js';

/**
 * Ai được ở trong room `meeting:{id}`: đúng điều kiện xem của REST (`meetingVisibleTo`, M6b) — một
 * nguồn sự thật cho cả hai đường.
 *
 * Socket không có org trên path như REST, và bảng meeting có RLS (M11 B7): ngoài ngữ cảnh tổ chức
 * thì không đọc được meeting để biết nó thuộc org nào. Nên đi ngược: các tổ chức người gọi ĐANG
 * thuộc (`organization_members` không có RLS; loại org đã xoá như `OrgMemberGuard`) → thử trong
 * ngữ cảnh từng tổ chức. Tiền điều kiện "người xem thuộc org" (M6b bài học 1) đúng theo cách dựng;
 * vừa bị gỡ khỏi org → org đó không còn trong danh sách → không thấy nữa.
 */
@Injectable()
export class RealtimeSubscriptionsService {
  constructor(
    private readonly meetings: MeetingsRepository,
    private readonly orgs: OrganizationsRepository,
  ) {}

  async canView(userId: string, meetingId: string): Promise<boolean> {
    for (const org of await this.orgs.listForUser(userId)) {
      const visible = await OrgContext.runInOrg(org.id, () =>
        this.meetings.findVisible(org.id, { userId, orgRole: org.role }, meetingId),
      );
      if (visible) return true;
    }
    return false;
  }

  /**
   * Trong các meeting đang có subscriber ở instance này, những cái bị phạm vi `scope` (kênh / org)
   * đụng tới. Chỉ hỏi DB về đúng các id đó — không quét mọi meeting của kênh / org.
   */
  async meetingsInScope(
    scope: Extract<AccessScope, { kind: 'channel' | 'org' }>,
    subscribed: string[],
  ): Promise<string[]> {
    return OrgContext.runInOrg(scope.orgId, () =>
      scope.kind === 'channel'
        ? this.meetings.filterSharedInChannel(scope.channelId, subscribed)
        : this.meetings.filterInOrg(scope.orgId, subscribed),
    );
  }
}
