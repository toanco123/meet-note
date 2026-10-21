/**
 * Tên room — một nơi duy nhất. Không có `:` lạ trong id (uuid) nên ghép chuỗi an toàn.
 * - `user:{id}`: mọi socket của một người (event cá nhân, thông báo — M10);
 * - `session:{sid}`: mọi socket của MỘT phiên đăng nhập — để ngắt đúng phiên khi logout (M7 Q1);
 * - `meeting:{id}`: socket đang theo dõi một meeting (vào bằng `subscribe`, có kiểm quyền — B3).
 */
export const RealtimeRoom = {
  user: (userId: string) => `user:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  meeting: (meetingId: string) => `meeting:${meetingId}`,
} as const;
