import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { mapException } from '../../../../src/common/errors/all-exceptions.filter.js';
import { AppException } from '../../../../src/common/errors/app.exception.js';
import { ErrorCode } from '../../../../src/common/errors/error-code.js';
import { validationExceptionFactory } from '../../../../src/common/errors/validation-exception.factory.js';

describe('mapException', () => {
  it('giữ nguyên code/status/message của AppException', () => {
    const mapped = mapException(
      new AppException(ErrorCode.Conflict, HttpStatus.CONFLICT, 'Kênh đã được lưu trữ.'),
    );
    expect(mapped).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'Kênh đã được lưu trữ.',
      details: undefined,
    });
  });

  it('HttpException của Nest → code mặc định theo status', () => {
    expect(mapException(new NotFoundException('Cannot GET /x'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Cannot GET /x',
    });
    expect(mapException(new BadRequestException())).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('lỗi validate lồng nhau được làm phẳng thành details', () => {
    const exception = validationExceptionFactory([
      {
        property: 'members',
        children: [
          {
            property: '0',
            children: [{ property: 'role', constraints: { isEnum: 'role must be a valid enum' } }],
          },
        ],
      },
    ]);
    expect(mapException(exception).details).toEqual([
      { field: 'members.0.role', message: 'role must be a valid enum' },
    ]);
  });

  it('lỗi unique của Postgres bị Drizzle bọc trong cause → 409', () => {
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'channels_org_name_uq',
    });
    const drizzleError = new Error('Failed query: insert into ...', { cause: pgError });

    expect(mapException(drizzleError)).toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('lỗi 4xx từ body-parser (expose=true) giữ status gốc', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });
    expect(mapException(tooLarge)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('lỗi không xác định → 500 với thông điệp chung, không lộ chi tiết', () => {
    const mapped = mapException(new Error('connection string postgres://secret@...'));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).not.toContain('secret');
  });
});
