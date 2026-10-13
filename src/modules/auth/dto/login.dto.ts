import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../password-hasher.js';

export class LoginDto {
  /** @example "an.nguyen@example.com" */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  /**
   * Không kiểm tra độ dài tối thiểu ở đây (tài khoản cũ có thể có quy tắc khác),
   * nhưng vẫn chặn chuỗi quá dài trước khi tới argon2.
   * @example "mot-cau-mat-khau-dai"
   */
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}
