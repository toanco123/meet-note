/** Danh tính đã xác thực, do `JwtAuthGuard` gắn vào `req.user`. */
export interface AuthUser {
  id: string;
  /** Phiên đăng nhập hiện tại (`sid` trong JWT) — dùng cho logout và cờ `current` ở `/me/sessions`. */
  sessionId: string;
}

// Declaration merging: thêm `user` vào kiểu Request của Express để `req.user` có kiểu ở mọi nơi.
declare global {
  // oxlint-disable-next-line typescript/no-namespace -- cú pháp bắt buộc để mở rộng namespace Express
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
