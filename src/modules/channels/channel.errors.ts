import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import type { TargetDecision } from '../organizations/organization.policy.js';
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

export function channelMemberNotFound(): AppException {
  return AppException.notFound('Không tìm thấy thành viên kênh.');
}

/** Kết quả kiểm tra theo ĐỐI TƯỢNG (đổi vai trò / gỡ một người cụ thể) → lỗi HTTP. */
export function assertChannelTargetDecision(decision: TargetDecision): void {
  if (decision === 'owner_immutable') {
    throw AppException.conflict(
      ErrorCode.ChannelOwnerImmutable,
      'Không đổi vai trò hay gỡ được Chủ kênh. Hãy chuyển chủ kênh trước.',
    );
  }
  if (decision === 'forbidden') {
    throw AppException.forbidden('Bạn không được tác động lên thành viên có vai trò này.');
  }
}
