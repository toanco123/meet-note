import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

/** Chỉ đổi được tên hiển thị. Gửi kèm field khác (vd `email`) → 400 nhờ `forbidNonWhitelisted`. */
export class UpdateMeDto {
  /** @example "Nguyễn Văn An" */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  displayName: string;
}
