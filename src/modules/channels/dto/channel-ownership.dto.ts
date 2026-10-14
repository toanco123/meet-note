import { IsUUID } from 'class-validator';

export class TransferChannelOwnershipDto {
  /** Người nhận: phải là thành viên kênh và không phải Khách. Chủ cũ trở thành QTV kênh. */
  @IsUUID()
  newOwnerId: string;
}

export class ChannelOwnershipTransferResponseDto {
  channelId: string;

  /** Chủ kênh mới. */
  ownerId: string;
}
