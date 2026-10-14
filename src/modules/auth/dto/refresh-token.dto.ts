import { IsString, Matches } from 'class-validator';
import { REFRESH_TOKEN_PATTERN } from '../services/token.service.js';

export class RefreshTokenDto {
  /**
   * Refresh token nhận từ lần đăng nhập / refresh gần nhất. Mỗi token chỉ dùng được MỘT lần.
   * @example "q3Jt0b6Q2l3Zc0p9QpXb5m1q8D0yJ4dA7m2N5r1sT6w"
   */
  @IsString()
  // Từ chối chuỗi sai định dạng ngay ở tầng validate, không tốn một lần tra DB.
  @Matches(REFRESH_TOKEN_PATTERN, { message: 'refreshToken không đúng định dạng' })
  refreshToken: string;
}
