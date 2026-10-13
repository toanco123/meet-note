import { HttpStatus, type ValidationError } from '@nestjs/common';
import { AppException, type ErrorDetail } from './app.exception.js';
import { ErrorCode } from './error-code.js';

/** Biến cây ValidationError (có lồng `children`) thành danh sách phẳng `{ field, message }`. */
export function flattenValidationErrors(errors: ValidationError[], parent?: string): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

export function validationExceptionFactory(errors: ValidationError[]): AppException {
  return new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Dữ liệu gửi lên không hợp lệ.',
    flattenValidationErrors(errors),
  );
}
