import { createHash, timingSafeEqual } from 'node:crypto';
import { errorResponse } from './errors.js';

/**
 * `X-DCC-Token` verification (PRD §4.1.1 step 1, §8.1): constant-time digest
 * comparison so response timing cannot leak the token. Fails closed when the
 * server token is not configured.
 *
 * Interface aligned with REQ-202610-1252, which owns the final auth/rate-limit
 * middleware; this module is expected to be superseded by that implementation.
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

const digest = (value) => createHash('sha256').update(value).digest();
