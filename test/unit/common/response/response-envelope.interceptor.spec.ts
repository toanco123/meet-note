import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  PAGINATED_KEY,
  RAW_RESPONSE_KEY,
} from '../../../../src/common/response/response-envelope.js';
import { ResponseEnvelopeInterceptor } from '../../../../src/common/response/response-envelope.interceptor.js';

class ProbeController {}
// Arrow function: không có `this` (hết `unbound-method`), `.name` vẫn lấy theo key ('list'…).
const handlers = { single: () => undefined, list: () => undefined, raw: () => undefined };
Reflect.defineMetadata(PAGINATED_KEY, true, handlers.list);
Reflect.defineMetadata(RAW_RESPONSE_KEY, true, handlers.raw);

/** `requestId: null` để giả lập thiếu `req.id` (truyền `undefined` sẽ rơi về giá trị mặc định). */
function run(
  handler: keyof typeof handlers,
  result: unknown,
  {
    requestId = 'req-1',
    statusCode = 200,
  }: { requestId?: string | null; statusCode?: number } = {},
) {
  const context = {
    getType: () => 'http',
    getHandler: () => handlers[handler],
    getClass: () => ProbeController,
    switchToHttp: () => ({
      getRequest: () => ({ id: requestId }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(result) };
  return lastValueFrom(new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, next));
}

describe('ResponseEnvelopeInterceptor', () => {
  it('một tài nguyên → { data, meta: { statusCode, requestId } }; statusCode lấy từ response thật', async () => {
    await expect(run('single', { id: 'x' }, { statusCode: 201 })).resolves.toEqual({
      data: { id: 'x' },
      meta: { statusCode: 201, requestId: 'req-1' },
    });
  });

  it('danh sách → data là mảng, nextCursor chuyển vào meta', async () => {
    await expect(run('list', { data: [1, 2], nextCursor: 'c' })).resolves.toEqual({
      data: [1, 2],
      meta: { statusCode: 200, requestId: 'req-1', nextCursor: 'c' },
    });
  });

  it('undefined (204) và route @RawResponse() → giữ nguyên', async () => {
    await expect(run('single', undefined)).resolves.toBeUndefined();
    await expect(run('raw', { status: 'ok' })).resolves.toEqual({ status: 'ok' });
  });

  it('route danh sách trả sai shape → lỗi lập trình, báo rõ tên handler', async () => {
    await expect(run('list', [1, 2])).rejects.toThrow(/ProbeController\.list.*Page<T>/);
  });

  it('thiếu req.id (pino-http chưa chạy) → lỗi rõ, không trả requestId rỗng', async () => {
    await expect(run('single', { id: 'x' }, { requestId: null })).rejects.toThrow(/req\.id/);
  });
});
