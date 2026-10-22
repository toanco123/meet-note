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
} as const;
