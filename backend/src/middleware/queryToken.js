import { errorResponse } from './errors.js';

/**
 * Defect 21: credentials must never travel in the URL. Query strings end up in
 * access logs, proxy logs, browser history, and `Referer` headers, so a token
 * placed there is considered leaked even when the request is rejected.
 *
 * Matching is intentionally broad: names are lower-cased and stripped of every
 * non-alphanumeric character, so `access_token`, `Access-Token`, `access%5Ftoken`
 * and `ACCESSTOKEN` are all treated as the same credential parameter.
 */
const CREDENTIAL_PARAM_NAMES = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'apitoken',
  'xdcctoken',
  'authorization',
  'auth',
  'apikey',
  'accesskey',
  'clientsecret',
  'secret',
  'password',
  'passwd',
  'jwt',
]);

const normalizeParamName = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '');

export const QUERY_TOKEN_MESSAGE =
  'Token must be sent in the X-DCC-Token header; query-string tokens are not supported.';

/** Returns the first token-like query parameter name, or null when clean. */
export function findQueryToken(url) {
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_PARAM_NAMES.has(normalizeParamName(name))) return name;
  }
  return null;
}

/**
 * Rejects any request that carries a credential in the query string. Returns a
 * 400 `Response`, or null when the URL is safe. Call this before authentication
 * so a query token is never silently ignored (defect 21).
 */
export function rejectQueryToken(url) {
  if (findQueryToken(url) === null) return null;
  return errorResponse(400, QUERY_TOKEN_MESSAGE);
}
