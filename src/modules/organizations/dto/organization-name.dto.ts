import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

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

/** Sửa một phần: chỉ field gửi lên mới được đổi. Body rỗng → không đổi gì (200). */
export class UpdateOrganizationDto {
  /** @example "Bình Minh Group" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name?: string;

  /** Bật: chấp nhận link mời chỉ tạo yêu cầu tham gia, Owner/Admin phải duyệt. */
  @IsOptional()
  @IsBoolean()
  requireJoinApproval?: boolean;
}
