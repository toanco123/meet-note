import type { ValidationError } from '@nestjs/common';
import type { AppException } from './app.exception.js';
import { Errors } from './errors.js';
import type { ErrorDetail } from './errors.types.js';

/** Biến cây ValidationError (có lồng `children`) thành danh sách phẳng `{ field, message }`. */
export function flattenValidationErrors(errors: ValidationError[], parent?: string): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

export function validationExceptionFactory(errors: ValidationError[]): AppException {
  return Errors.common.validationFailed(flattenValidationErrors(errors));
}
