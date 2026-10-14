import { ApiProperty } from '@nestjs/swagger';

/** `meta` của mọi response thành công. */
export class ResponseMetaDto {
  /**
   * HTTP status của chính response này (đọc từ status thật, không gán cứng).
   * @example 200
   */
  statusCode: number;

  /**
   * Trùng header `x-request-id` (và `error.requestId` khi lỗi). Gửi kèm khi báo lỗi để đối chiếu log.
   * @example "01J9Z6K3W8Q2V5T7Y9B1N4M6P0"
   */
  requestId: string;
}

/** `meta` của response danh sách: thêm cursor trang sau. */
export class PaginatedMetaDto extends ResponseMetaDto {
  // Khai báo tay: plugin chưa suy ra `nullable` chắc chắn cho kiểu `string | null`.
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cursor để lấy trang sau (query `cursor`). `null` nghĩa là đã hết dữ liệu.',
    example: 'eyJ2IjoxLCJrIjpbIjIwMjYtMTAtMTMiLCIwMTk5Il19',
  })
  nextCursor: string | null;
}
