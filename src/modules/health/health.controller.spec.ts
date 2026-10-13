import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { HealthReadyResponseDto } from './dto/health-response.dto.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * Test này còn có mục đích thứ hai: chứng minh Vitest (Oxc transform) phát
 * `design:paramtypes` đúng — HealthController inject HealthService CHỈ qua kiểu của
 * constructor, không có @Inject(). Nếu metadata hỏng, `healthService` sẽ là undefined.
 */
describe('HealthController', () => {
  async function setup(result: HealthReadyResponseDto) {
    const checkReadiness = vi.fn<() => Promise<HealthReadyResponseDto>>().mockResolvedValue(result);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { checkReadiness } }],
    }).compile();
    return moduleRef.get(HealthController);
  }

  function fakeResponse() {
    const res = { status: vi.fn<(code: number) => unknown>() };
    res.status.mockReturnValue(res);
    return res;
  }

  it('live luôn trả ok', async () => {
    const controller = await setup({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('ready: mọi phụ thuộc up → giữ status 200', async () => {
    const controller = await setup({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    const res = fakeResponse();

    await expect(controller.ready(res as unknown as Response)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('ready: một phụ thuộc down → 503 kèm chi tiết', async () => {
    const controller = await setup({ status: 'error', checks: { database: 'down', redis: 'up' } });
    const res = fakeResponse();

    const body = await controller.ready(res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body.checks.database).toBe('down');
  });
});
