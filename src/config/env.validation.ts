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
