import { SetMetadata } from '@nestjs/common';

export const CREDENTIAL_ROUTE = 'meetnote:rate-limit:credential';

/** Bật thêm throttler `credential` (IP, email) và `account` (email) — route nhận mật khẩu. */
export const CredentialThrottle = (): MethodDecorator => SetMetadata(CREDENTIAL_ROUTE, true);
