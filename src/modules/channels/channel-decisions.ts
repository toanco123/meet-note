import { Errors } from '../../common/errors/errors.js';
import type { TargetDecision } from '../organizations/organization.policy.js';
import type { ChannelDecision } from './channel.policy.js';

/**
 * Policy là hàm THUẦN, trả về quyết định (`'ok' | 'forbidden' | …`), không biết gì về HTTP.
 * Đây là chỗ đổi quyết định thành lỗi. Guard và service dùng chung → cùng mã lỗi, cùng thông điệp.
 */
export function assertChannelDecision(decision: ChannelDecision): void {
  if (decision === 'forbidden') throw Errors.channel.forbidden();
  if (decision === 'archived') throw Errors.channel.archived();
}

/** Kết quả kiểm tra theo ĐỐI TƯỢNG (đổi vai trò / gỡ một người cụ thể) → lỗi. */
export function assertChannelTargetDecision(decision: TargetDecision): void {
  if (decision === 'owner_immutable') throw Errors.channel.ownerImmutable();
  if (decision === 'forbidden') throw Errors.role.cannotActOn();
}
