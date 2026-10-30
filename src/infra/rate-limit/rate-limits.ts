const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Ngoài `default`, hai throttler chỉ bật trên route gắn `@CredentialThrottle()` (đăng nhập). */
export const ThrottlerName = {
  Default: 'default',
  /** (IP, email): dò MỘT tài khoản từ MỘT IP — chặt. */
  Credential: 'credential',
  /** email: dò một tài khoản từ NHIỀU IP — lỏng, để kẻ xấu khó lợi dụng khoá tài khoản nạn nhân. */
  Account: 'account',
} as const;

/**
 * Giới hạn (M11 Q3). `ttl` tính ms; bị chặn trong `ttl` (blockDuration mặc định = ttl).
 * Route: `@Throttle(RateLimit.register)` ghi đè throttler `default` cho riêng route đó.
 */
export const RateLimit = {
  /** Mọi route: theo người dùng nếu đã đăng nhập, ngược lại theo IP. */
  default: { limit: 300, ttl: MINUTE },
  credential: { limit: 5, ttl: MINUTE },
  account: { limit: 20, ttl: HOUR },
  login: { default: { limit: 30, ttl: MINUTE } },
  register: { default: { limit: 10, ttl: HOUR } },
  refresh: { default: { limit: 30, ttl: MINUTE } },
  inviteAccept: { default: { limit: 20, ttl: MINUTE } },
  inviteCreate: { default: { limit: 60, ttl: HOUR } },
  uploadInit: { default: { limit: 60, ttl: HOUR } },
  /** Full-text search + stream file xuất: hai route đắt nhất app (M8 Q9). */
  transcriptSearch: { default: { limit: 60, ttl: MINUTE } },
  transcriptExport: { default: { limit: 30, ttl: MINUTE } },
  /** Sửa tay từng đoạn: nhiều lần liên tiếp là bình thường, nhưng vẫn có trần (M13 Q8). */
  transcriptEdit: { default: { limit: 120, ttl: MINUTE } },
  /** Tạo / sửa việc cần làm (M12): thao tác tay lẻ tẻ, trần rộng. */
  /** Dashboard (M17): mỗi lần gọi chạy vài truy vấn tổng hợp — trần vừa phải. */
  dashboard: { default: { limit: 60, ttl: MINUTE } },
  actionItemWrite: { default: { limit: 120, ttl: MINUTE } },
} as const;
