import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { FakeSpeechToText } from './fake.speech-to-text.js';
import type { SpeechToText } from './speech.types.js';
import { WhisperCppSpeechToText } from './whisper-cpp.speech-to-text.js';

/** Inject bằng `@Inject(SPEECH_TO_TEXT) private readonly speech: SpeechToText`. */
export const SPEECH_TO_TEXT = Symbol('SPEECH_TO_TEXT');

/** Bộ nhận dạng giọng nói cho worker (M6): whisper.cpp thật, hoặc giả (`SPEECH_PROVIDER=fake`). */
@Module({
  providers: [
    {
      provide: SPEECH_TO_TEXT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): SpeechToText =>
        config.get('SPEECH_PROVIDER', { infer: true }) === 'fake'
          ? new FakeSpeechToText()
          : new WhisperCppSpeechToText({
              cliPath: config.get('WHISPER_CLI_PATH', { infer: true }),
              modelPath: config.get('WHISPER_MODEL_PATH', { infer: true }),
              threads: config.get('WHISPER_THREADS', { infer: true }),
            }),
    },
  ],
  exports: [SPEECH_TO_TEXT],
})
export class SpeechModule {}
