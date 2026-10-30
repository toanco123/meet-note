import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { RateLimit } from '../../infra/rate-limit/rate-limits.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import { DashboardQueryDto } from './dto/dashboard-query.dto.js';
import { DashboardResponseDto } from './dto/dashboard-response.dto.js';
import { DashboardService } from './services/dashboard.service.js';

@ApiTags('Dashboard')
@Controller('orgs/:orgId/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Số liệu tổng hợp của tổ chức (Owner / Admin).
   *
   * @remarks Chỉ số, không tiêu đề cuộc họp / nội dung / tên người. Khoảng tính theo ngày lịch giờ Việt
   * Nam, gồm cả hai đầu, tối đa 92 ngày và nằm trong 92 ngày gần nhất (mặc định 30 ngày tới hôm nay).
   * Chuỗi theo ngày / tuần đến từ bảng rollup do worker cập nhật — "hôm nay" có thể trễ vài phút
   * (`computedAt`); xoá hoặc đổi ngày cuộc họp được tính lại gần như ngay. Thành viên hoạt động, dung
   * lượng, top kênh và số việc tính lúc gọi. Giới hạn 60 lần / phút.
   */
  @Get()
  @RequireOrgPermission('org.dashboard.read')
  @Throttle(RateLimit.dashboard)
  @ApiErrorResponses(400, 403)
  async overview(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardResponseDto> {
    return DashboardResponseDto.from(await this.dashboard.overview(orgId, query));
  }
}
