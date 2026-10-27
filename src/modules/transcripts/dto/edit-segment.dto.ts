import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Nội dung mới của một đoạn transcript. Mốc thời gian và thứ tự không sửa được. */
export class EditSegmentDto {
  /**
   * Nội dung thay thế (1–5000 ký tự sau khi bỏ khoảng trắng hai đầu).
   * @example "Chào mọi người, hôm nay họp về kế toán quý ba."
   */
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  text: string;
}
