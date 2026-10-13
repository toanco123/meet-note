import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateOrganizationDto {
  /**
   * Tên tổ chức (1–100 ký tự). Không cần duy nhất.
   * @example "Công ty TNHH Bình Minh"
   */
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name: string;
}

export class UpdateOrganizationDto {
  /** @example "Bình Minh Group" */
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name: string;
}
