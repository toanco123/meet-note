/**
 * Mã lỗi máy đọc được. Client dựa vào `code`, không dựa vào `message`.
 * Mỗi mốc thêm mã của domain mình vào đây (tiền tố theo domain: AUTH_, ORG_, CHANNEL_…).
 */
export const ErrorCode = {
  ValidationFailed: 'VALIDATION_FAILED',
  InvalidCursor: 'INVALID_CURSOR',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  RateLimited: 'RATE_LIMITED',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  InternalError: 'INTERNAL_ERROR',

  // M1 — Auth
  AuthEmailTaken: 'AUTH_EMAIL_TAKEN',
  AuthInvalidCredentials: 'AUTH_INVALID_CREDENTIALS',
  AuthTokenMissing: 'AUTH_TOKEN_MISSING',
  AuthTokenInvalid: 'AUTH_TOKEN_INVALID',
  AuthTokenExpired: 'AUTH_TOKEN_EXPIRED',
  AuthSessionRevoked: 'AUTH_SESSION_REVOKED',
  AuthRefreshTokenInvalid: 'AUTH_REFRESH_TOKEN_INVALID',
  AuthRefreshTokenRotated: 'AUTH_REFRESH_TOKEN_ROTATED',
  AuthRefreshTokenReused: 'AUTH_REFRESH_TOKEN_REUSED',

  // M2 — Tổ chức
  OrgOwnerImmutable: 'ORG_OWNER_IMMUTABLE',

  // M3 — Mời, duyệt, chuyển sở hữu
  Gone: 'GONE',
  InviteNotFound: 'INVITE_NOT_FOUND',
  InviteExpired: 'INVITE_EXPIRED',
  InviteExhausted: 'INVITE_EXHAUSTED',
  OrgAlreadyMember: 'ORG_ALREADY_MEMBER',
  OrgJoinRequestPending: 'ORG_JOIN_REQUEST_PENDING',
  JoinRequestNotPending: 'JOIN_REQUEST_NOT_PENDING',
  OrgOwnerMustTransfer: 'ORG_OWNER_MUST_TRANSFER',
  OrgTransferInvalidTarget: 'ORG_TRANSFER_INVALID_TARGET',

  // M4 — Kênh
  ChannelNameTaken: 'CHANNEL_NAME_TAKEN',
  ChannelArchived: 'CHANNEL_ARCHIVED',
  ChannelAlreadyMember: 'CHANNEL_ALREADY_MEMBER',
  ChannelOwnerImmutable: 'CHANNEL_OWNER_IMMUTABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Mã mặc định khi lỗi không mang mã riêng (vd NotFoundException của Nest khi sai route). */
export function defaultCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.ValidationFailed;
    case 401:
      return ErrorCode.Unauthenticated;
    case 403:
      return ErrorCode.Forbidden;
    case 404:
      return ErrorCode.NotFound;
    case 409:
      return ErrorCode.Conflict;
    case 410:
      return ErrorCode.Gone;
    case 413:
      return ErrorCode.PayloadTooLarge;
    case 429:
      return ErrorCode.RateLimited;
    case 503:
      return ErrorCode.ServiceUnavailable;
    default:
      return status >= 500 ? ErrorCode.InternalError : ErrorCode.ValidationFailed;
  }
}
