import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthLiveResponseDto, HealthReadyResponseDto } from './dto/health-response.dto.js';
import { HealthService } from './health.service.js';

@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness — tiến trình còn sống.
   *
   * @remarks Không kiểm tra phụ thuộc: DB chết không phải lý do để orchestrator restart api.
   */
  @Get('live')
  live(): HealthLiveResponseDto {
    return { status: 'ok' };
  }

  /**
   * Readiness — sẵn sàng nhận traffic.
   *
   * @remarks Kiểm tra Postgres (`SELECT 1`) và Redis (`PING`), mỗi kiểm tra timeout 1 giây.
   */
  @Get('ready')
  @ApiServiceUnavailableResponse({
    description: 'Ít nhất một phụ thuộc không phản hồi.',
    type: HealthReadyResponseDto,
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthReadyResponseDto> {
    const result = await this.healthService.checkReadiness();
    if (result.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
