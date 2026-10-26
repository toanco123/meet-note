import type { MeetingRow } from '../../infra/database/schema/index.js';
import { RealtimeRoom } from '../../infra/realtime/realtime-rooms.js';
import type { RealtimePublisher } from '../../infra/realtime/realtime.types.js';

/**
 * `meeting.status` (05-api Realtime) — MỘT chỗ cho api (complete upload, M7) và worker (pipeline,
 * M6). Tới room của meeting (người đang xem) + room của chủ (danh sách "meeting của tôi"). Gọi SAU
 * commit; event chỉ là gợi ý, client đọc lại qua REST khi cần.
 */
export function publishMeetingStatus(
  realtime: RealtimePublisher,
  meeting: Pick<MeetingRow, 'id' | 'ownerId' | 'status' | 'failureCode'>,
): void {
  const rooms = [RealtimeRoom.meeting(meeting.id)];
  if (meeting.ownerId) rooms.push(RealtimeRoom.user(meeting.ownerId));
  realtime.emit(rooms, 'meeting.status', {
    meetingId: meeting.id,
    status: meeting.status,
    failureCode: meeting.failureCode,
  });
}
