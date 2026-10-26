import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { SUBTITLE_FORMATS, type SubtitleFormat } from '../transcript-formats.js';

export class ExportTranscriptQueryDto {
  /** Định dạng phụ đề: `srt` (SubRip) hoặc `vtt` (WebVTT). */
  @IsIn(SUBTITLE_FORMATS)
  @ApiProperty({ enum: SUBTITLE_FORMATS, enumName: 'SubtitleFormat' })
  format: SubtitleFormat;
}
