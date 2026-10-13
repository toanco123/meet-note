import { ApiProperty } from '@nestjs/swagger';

/**
 * Phần chung của mọi response danh sách. Field `data` được ghép theo từng model bằng
 * `@ApiPaginatedResponse(Model)` vì Swagger plugin không hiểu generic.
 */
export class PaginatedResponseDto {
  // Khai báo tay: plugin chưa suy ra `nullable` chắc chắn cho kiểu `string | null`.
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cursor để lấy trang sau. `null` nghĩa là đã hết dữ liệu.',
    example: 'eyJ2IjoxLCJrIjpbIjIwMjYtMTAtMTMiLCIwMTk5Il19',
  })
  nextCursor: string | null;
}
