import { Injectable, type PipeTransform } from '@nestjs/common';
import { Errors } from '../../common/errors/errors.js';

/**
 * `:seq` phải là số nguyên không âm vừa cột `integer`. Không dùng `ParseIntPipe` thuần: nó nhận cả số
 * âm và số vượt int32 — số lớn xuống Postgres thành lỗi `22003` (out of range) → 500 thay vì 400.
 */
@Injectable()
export class ParseSegmentSeqPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const seq = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(seq) || seq > 2_147_483_647) {
      throw Errors.common.validationFailed([
        { field: 'seq', message: 'Phải là số nguyên không âm.' },
      ]);
    }
    return seq;
  }
}
