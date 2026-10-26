/**
 * Token DI của pipeline (M6), tách khỏi file service: api chỉ cần `PIPELINE_SCHEDULER` để enqueue —
 * import từ file service sẽ kéo cả whisper / ffmpeg / Anthropic SDK vào tiến trình api.
 */
export const PIPELINE_SCHEDULER = Symbol('PIPELINE_SCHEDULER');
export const PIPELINE_OPTIONS = Symbol('PIPELINE_OPTIONS');
