import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import type { ChannelDecision } from './channel.policy.js';

/** Một thông điệp cho mọi kiểu "không thấy": không tồn tại, đã xoá, riêng tư — không lộ khác biệt. */
export function channelNotFound(): AppException {
  return AppException.notFound('Không tìm thấy kênh.');
}

export function channelNameTaken(): AppException {
  return AppException.conflict(ErrorCode.ChannelNameTaken, 'Tổ chức đã có kênh trùng tên.');
}

/** Đổi `ChannelDecision` thành lỗi HTTP. Guard và service dùng chung → cùng mã lỗi, cùng thông điệp. */
export function assertChannelDecision(decision: ChannelDecision): void {
  if (decision === 'forbidden') {
    throw AppException.forbidden('Vai trò của bạn trong kênh không được phép làm việc này.');
  }
  if (decision === 'archived') {
    throw new AppException(
      ErrorCode.ChannelArchived,
      HttpStatus.CONFLICT,
      'Kênh đã được lưu trữ (chỉ đọc).',
    );
  }
}
