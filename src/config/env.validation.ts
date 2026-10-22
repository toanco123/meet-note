import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Toàn bộ biến môi trường mà ứng dụng đọc. Đây là nơi DUY NHẤT được đọc `process.env`;
 * phần còn lại của code dùng `ConfigService<EnvironmentVariables, true>`.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';

  // Không dùng @Type(() => Boolean): Boolean('false') === true.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  @IsBoolean()
  LOG_PRETTY = false;

  @Matches(/^postgres(ql)?:\/\//, { message: 'DATABASE_URL phải bắt đầu bằng postgres://' })
  DATABASE_URL: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_POOL_MAX = 10;

  /**
   * Timeout phía Postgres cho MỌI connection của tiến trình (M11 Q1, M3 bài học 5) — request lỗi
   * 503 thay vì treo. Worker đặt `DATABASE_STATEMENT_TIMEOUT_MS` dài hơn (job theo lô). Migration
   * dùng connection riêng, không bị giới hạn.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATABASE_LOCK_TIMEOUT_MS = 3_000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATABASE_STATEMENT_TIMEOUT_MS = 15_000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATABASE_IDLE_TX_TIMEOUT_MS = 30_000;

  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL phải bắt đầu bằng redis:// hoặc rediss://' })
  REDIS_URL: string;

  /** Khoá ký access JWT (HS256). HS256 với khoá ngắn bị dò được bằng brute-force offline. */
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET phải dài ít nhất 32 ký tự' })
  JWT_ACCESS_SECRET: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(24 * 3600)
  JWT_ACCESS_TTL_SECONDS = 900;

  /** Trượt: mỗi lần refresh, token mới có hạn N ngày kể từ lúc đó. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS = 30;

  /** Token vừa bị xoay mà được dùng lại trong khoảng này → không coi là bị đánh cắp (2 tab cùng refresh). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  REFRESH_REUSE_GRACE_SECONDS = 10;

  // ── Object storage S3 (M5) ──────────────────────────────────────────────────

  /** Endpoint S3 tương thích (RustFS local: http://localhost:9000). Bỏ trống khi dùng AWS S3 thật. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  S3_ENDPOINT?: string;

  @IsString()
  S3_REGION = 'us-east-1';

  @IsString()
  @MinLength(3)
  S3_BUCKET: string;

  @IsString()
  @MinLength(3)
  S3_ACCESS_KEY_ID: string;

  @IsString()
  @MinLength(8)
  S3_SECRET_ACCESS_KEY: string;

  /** RustFS / MinIO cần path-style (`endpoint/bucket/key`); AWS dùng virtual-host style. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  @IsBoolean()
  S3_FORCE_PATH_STYLE = false;

  /** Dev / test: tạo bucket lúc khởi động nếu chưa có. Production: hạ tầng tạo sẵn, để false. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  @IsBoolean()
  S3_CREATE_BUCKET = false;

  /**
   * Origin của trang web được mở socket `/realtime` (M7), cách nhau bằng dấu phẩy, vd
   * `http://localhost:3000,https://app.example.com`. Rỗng = không trang web nào (client không phải
   * trình duyệt — không gửi `Origin` — vẫn kết nối được).
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsUrl(
    { require_tld: false, protocols: ['http', 'https'], require_protocol: true },
    { each: true },
  )
  REALTIME_CORS_ORIGINS: string[] = [];

  /**
   * Kênh Redis của Socket.IO adapter + emitter. Hai môi trường (hoặc hai file test chạy song song)
   * dùng chung một Redis thì PHẢI khác key — không thì thấy event của nhau, và `fetchSockets` xuyên
   * instance chờ phản hồi của server bên kia (M7 bài học 12).
   */
  @IsString()
  @MinLength(1)
  REALTIME_REDIS_KEY = 'meetnote:socket.io';

  /**
   * Tiền tố key BullMQ trong Redis. Như `REALTIME_REDIS_KEY`: hai môi trường / hai file test dùng chung
   * một Redis thì PHẢI khác — không thì worker của bên này lấy job của bên kia (đọc nhầm database).
   */
  @IsString()
  @MinLength(1)
  QUEUE_PREFIX = 'meetnote';

  /** Binary của ffmpeg / ffprobe (M6) — mặc định tìm trong PATH (Homebrew / apt / apk). */
  @IsString()
  @MinLength(1)
  FFMPEG_PATH = 'ffmpeg';

  @IsString()
  @MinLength(1)
  FFPROBE_PATH = 'ffprobe';

  /**
   * Queue mà worker này nghe (M6): `default` (ngắn) và / hoặc `transcription` (whisper, nặng).
   * `WorkerModule` đọc thẳng `process.env` lúc import (danh sách processor là metadata tĩnh) — khai
   * báo ở đây để có tài liệu + kiểm định dạng.
   */
  @Matches(/^(default|transcription)(,(default|transcription))*$/, {
    message: 'WORKER_QUEUES: danh sách cách nhau bằng dấu phẩy, gồm default / transcription',
  })
  WORKER_QUEUES = 'default,transcription';

  /** Nhận dạng giọng nói của worker (M6): `whisper` (whisper.cpp) hoặc `fake` (dev / test). */
  @IsIn(['whisper', 'fake'])
  SPEECH_PROVIDER: 'whisper' | 'fake' = 'whisper';

  @IsString()
  @MinLength(1)
  WHISPER_CLI_PATH = 'whisper-cli';

  /**
   * File model ggml (vd `ggml-large-v3-turbo-q5_0.bin`). KHÔNG bắt buộc ở đây: api dùng chung bộ
   * validate mà không cần model — worker thiếu model thì báo lỗi cấu hình khi chạy (M6 B3).
   */
  @IsString()
  WHISPER_MODEL_PATH = '';

  /** `auto` = tự nhận dạng ngôn ngữ (30 giây đầu), hoặc mã cố định như `vi`. */
  @IsString()
  @MinLength(2)
  WHISPER_LANGUAGE = 'auto';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  WHISPER_THREADS?: number;

  /** Hạn chạy whisper = thời lượng audio × hệ số này + 2 phút. */
  @Type(() => Number)
  @Min(0.1)
  WHISPER_TIMEOUT_FACTOR = 3;

  /** Tóm tắt (M6 Q2): mặc định `fake` → không gửi transcript ra ngoài khi chưa bật rõ ràng. */
  @IsIn(['fake', 'anthropic'])
  LLM_PROVIDER: 'fake' | 'anthropic' = 'fake';

  @IsString()
  @MinLength(1)
  LLM_MODEL = 'claude-opus-5-5';

  @IsIn(['low', 'medium', 'high', 'xhigh', 'max'])
  LLM_EFFORT: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium';

  /** Tắt được để test e2e (đăng ký hàng loạt user từ 127.0.0.1) không vướng giới hạn (M11 B3). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  @IsBoolean()
  RATE_LIMIT_ENABLED = true;

  /** Tiền tố khoá rate limit trong Redis — tách môi trường / file test như `QUEUE_PREFIX`. */
  @IsString()
  @MinLength(1)
  RATE_LIMIT_PREFIX = 'meetnote:rate-limit';

  /**
   * Số tầng reverse proxy đứng trước api (Express `trust proxy`). 0 = không tin `X-Forwarded-For`
   * (client tự gửi được header này → giả IP để thoát rate limit). Đặt ĐÚNG số tầng: thừa một tầng
   * là lại tin giá trị do client gửi.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS = 0;
}

/** Dùng cho `ConfigModule.forRoot({ validate })`. Ném lỗi → tiến trình dừng ngay khi khởi động. */
export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });

  if (errors.length > 0) {
    const lines = errors.map(
      (e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
    );
    throw new Error(`Biến môi trường không hợp lệ:\n${lines.join('\n')}`);
  }
  return env;
}

export function isSwaggerEnabled(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== NodeEnv.Production;
}
