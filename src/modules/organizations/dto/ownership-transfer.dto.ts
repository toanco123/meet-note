import { IsUUID } from 'class-validator';

export class TransferOwnershipDto {
  /** Người nhận quyền sở hữu — phải đang là thành viên của tổ chức. */
  @IsUUID()
  newOwnerId: string;
}

export class OwnershipTransferResponseDto {
  orgId: string;

  /** Owner mới. Owner cũ trở thành Admin. */
  ownerId: string;
}
