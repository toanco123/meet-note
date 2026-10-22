import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { MediaTools } from './media-tools.js';

/** `MediaTools` cho tiến trình worker (pipeline M6). Api không cần — không import vào AppModule. */
@Module({
  providers: [
    {
      provide: MediaTools,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new MediaTools({
          ffmpegPath: config.get('FFMPEG_PATH', { infer: true }),
          ffprobePath: config.get('FFPROBE_PATH', { infer: true }),
        }),
    },
  ],
  exports: [MediaTools],
})
export class MediaModule {}
