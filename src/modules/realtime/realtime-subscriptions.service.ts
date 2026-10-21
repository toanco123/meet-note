import { Injectable } from '@nestjs/common';
import { MeetingsRepository } from '../meetings/repositories/meetings.repository.js';
import { OrganizationMembersRepository } from '../organizations/repositories/organization-members.repository.js';

/**
 * Ai được vào room `meeting:{id}`: đúng điều kiện xem của REST (`meetingVisibleTo`, M6b) — một
 * nguồn sự thật cho cả hai đường. Socket không có org trên path như REST → tự tìm org của meeting,
 * rồi vai trò của người gọi trong org đó (thay cho `OrgMemberGuard`: biểu thức xem có TIỀN ĐIỀU KIỆN
 * là người xem thuộc org — M6b bài học 1).
 */
@Injectable()
export class RealtimeSubscriptionsService {
  constructor(
    private readonly meetings: MeetingsRepository,
    private readonly orgMembers: OrganizationMembersRepository,
  ) {}

  async canView(userId: string, meetingId: string): Promise<boolean> {
    const meeting = await this.meetings.findById(meetingId);
    if (!meeting) return false;
    const member = await this.orgMembers.findMember(meeting.orgId, userId);
    if (!member) return false;
    const visible = await this.meetings.findVisible(
      meeting.orgId,
      { userId, orgRole: member.role },
      meetingId,
    );
    return visible !== undefined;
  }
}
