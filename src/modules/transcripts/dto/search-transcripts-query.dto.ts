import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';

export class SearchTranscriptsQueryDto extends CursorQueryDto {
  /**
   * Từ khoá, 2–200 ký tự. Không cần gõ dấu: "ke hoach" tìm ra "kế hoạch". Nhiều từ = đủ mọi từ;
   * `"cụm từ"` khớp nguyên cụm, `-từ` loại từ, `or` là hoặc.
   * @example "ngan sach marketing"
   */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;

  /** Chỉ meeting được chia sẻ vào kênh này. Phải đọc được nội dung kênh (không thì 403 / 404). */
  @IsOptional()
  @IsUUID()
  channelId?: string;
}
