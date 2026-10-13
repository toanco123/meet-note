import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-hasher.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  /**
   * Email đăng nhập. Không phân biệt hoa thường khi so trùng.
   * @example "an.nguyen@example.com"
   */
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email: string;

  /**
   * Mật khẩu 8–128 ký tự. Không ép quy tắc "phải có số/ký tự đặc biệt" (theo NIST SP 800-63B):
   * độ dài quan trọng hơn độ phức tạp. Không trim — khoảng trắng là một phần của mật khẩu.
   * @example "mot-cau-mat-khau-dai"
   */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  /**
   * Tên hiển thị.
   * @example "Nguyễn Văn An"
   */
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  displayName: string;
}
