import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import type { ChannelAccess } from '../channels/channels.types.js';
import { CurrentChannelAccess } from '../channels/guards/channel-access.js';
import { RequireChannelPermission } from '../channels/guards/require-channel-permission.decorator.js';
import {
  ReportResponseDto,
  ReportSummaryResponseDto,
  ReportVersionResponseDto,
} from './dto/report-response.dto.js';
import { ReportsService } from './services/reports.service.js';
import { ParseWeekStartPipe } from './week-start.pipe.js';

@ApiTags('Reports')
@Controller('orgs/:orgId/channels/:channelId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Danh sách báo cáo tuần của kênh, tuần mới nhất trước.
   *
   * @remarks Cần đọc được nội dung kênh: thành viên kênh, hoặc thành viên tổ chức với kênh công khai.
   * Kênh chỉ có báo cáo từ tuần đầu tiên sau khi bật báo cáo; không có dòng cho tuần không có gì.
   */
  @Get()
  @RequireChannelPermission('channel.content.read')
  @ApiPaginatedResponse(ReportSummaryResponseDto)
  @ApiErrorResponses(400)
  async list(
    @CurrentChannelAccess() access: ChannelAccess,
    @Query() query: CursorQueryDto,
  ): Promise<Page<ReportSummaryResponseDto>> {
    return this.reports.list(access, query);
  }

  /**
   * Báo cáo của một tuần.
   *
   * @remarks `weekStart` là ngày Thứ Hai (giờ Việt Nam) của tuần, vd `2026-10-05`; sai → 400. Trả
   * trạng thái và PHIÊN BẢN ĐANG HIỂN THỊ: khi đang tạo lại hoặc tạo lại lỗi vẫn là bản cũ.
   */
  @Get(':weekStart')
  @RequireChannelPermission('channel.content.read')
  @ApiErrorResponses(400)
  async get(
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('weekStart', ParseWeekStartPipe) weekStart: string,
  ): Promise<ReportResponseDto> {
    return this.reports.get(access, weekStart);
  }

  /** Mọi phiên bản của báo cáo (bản theo lịch + tối đa 3 lần tạo lại), mới nhất trước. */
  @Get(':weekStart/versions')
  @RequireChannelPermission('channel.content.read')
  @ApiErrorResponses(400)
  async versions(
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('weekStart', ParseWeekStartPipe) weekStart: string,
  ): Promise<ReportVersionResponseDto[]> {
    return this.reports.versions(access, weekStart);
  }

  /**
   * Tạo lại báo cáo (tối đa 3 lần mỗi báo cáo).
   *
   * @remarks Chủ kênh và quản trị viên kênh. Trả 202 ngay: báo cáo về `pending`, bản cũ vẫn hiển thị
   * cho tới khi bản mới xong. Đang tạo → 409 `REPORT_IN_PROGRESS`; hết lượt → 409
   * `REPORT_REGENERATE_LIMIT`; kênh lưu trữ → 409 `CHANNEL_ARCHIVED`. Tạo lại tính lại danh sách cuộc
   * họp từ đầu nên cuộc họp xong muộn cũng được đưa vào.
   */
  @Post(':weekStart/regenerate')
  @HttpCode(202)
  @RequireChannelPermission('channel.report.regenerate')
  @ApiErrorResponses(400)
  async regenerate(
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('weekStart', ParseWeekStartPipe) weekStart: string,
    @Req() req: Request,
  ): Promise<ReportResponseDto> {
    const requestId = (req as Request & { id?: unknown }).id;
    return this.reports.regenerate(
      access,
      weekStart,
      typeof requestId === 'string' ? requestId : null,
    );
  }
}
