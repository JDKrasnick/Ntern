/** R2's documented Workers error suffix; other storage failures stay fatal. */
export function isR2InternalFailure(error: unknown): error is Error {
  return error instanceof Error
    && /^(?:get|head|put|delete|list):[^\n]*\(10001\)$/u.test(error.message);
}
