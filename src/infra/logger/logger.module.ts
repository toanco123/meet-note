import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { EnvironmentVariables } from '../../config/env.validation.js';

export const REQUEST_ID_HEADER = 'x-request-id';

// Nhận request id từ client/proxy để nối log xuyên hệ thống, nhưng chỉ khi trông hợp lệ —
// tránh log injection hoặc chuỗi khổng lồ.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * Log JSON ra stdout bằng pino. Mỗi request có `req.id` (= header `x-request-id`),
 * mọi log trong request đó tự gắn `reqId` nhờ AsyncLocalStorage của nestjs-pino.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // pino-pretty là devDependency: chỉ bật khi chạy local.
          transport: config.get('LOG_PRETTY', { infer: true })
            ? {
                target: 'pino-pretty',
                options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
              }
            : undefined,
          genReqId: resolveRequestId,
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            censor: '[REDACTED]',
          },
          autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
          customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
