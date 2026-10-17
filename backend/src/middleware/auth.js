import { createHash, timingSafeEqual } from 'node:crypto';
import { errorResponse } from './errors.js';

const digest = (value) => createHash('sha256').update(value).digest();

export function authorize(request, expectedToken) {
  const supplied = request.headers['x-dcc-token'] || '';
  const actualDigest = digest(supplied);
  const expectedDigest = digest(expectedToken || '');
  const matches = timingSafeEqual(actualDigest, expectedDigest);
  if (!expectedToken || !matches || supplied.length > 4096) {
    return errorResponse(401);
  }
  return null;
}
