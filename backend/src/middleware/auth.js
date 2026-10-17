import { createHash, timingSafeEqual } from 'node:crypto';
import { errorResponse } from './errors.js';

const digest = (value) => createHash('sha256').update(value).digest();
const MAX_TOKEN_LENGTH = 4096;

/**
 * Credentials are read from headers only (defect 21). `X-DCC-Token` is the
 * canonical channel; `Authorization: Bearer <token>` is accepted for standard
 * HTTP clients. Query strings are never consulted.
 */
function readSuppliedToken(request) {
  const direct = request.headers['x-dcc-token'];
  if (direct !== undefined) return String(direct);

  const authorization = request.headers['authorization'];
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match) return match[1];
  }
  return '';
}

export function authorize(request, expectedToken) {
  const supplied = readSuppliedToken(request);
  const actualDigest = digest(supplied);
  const expectedDigest = digest(expectedToken || '');
  const matches = timingSafeEqual(actualDigest, expectedDigest);
  if (!expectedToken || !matches || supplied.length > MAX_TOKEN_LENGTH) {
    return errorResponse(401);
  }
  return null;
}
