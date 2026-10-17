import { createHash, timingSafeEqual } from 'node:crypto';
import { errorResponse } from './errors.js';

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * `X-DCC-Token` verification (PRD §4.1.1 step 1, §8.1): constant-time digest
 * comparison so response timing cannot leak the token. Fails closed when the
 * server token is not configured.
 *
 * Query-string tokens are never accepted (defect 21); only the header is read.
 *
 * @returns {Response | null} an error response to send, or null when allowed.
 */
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
