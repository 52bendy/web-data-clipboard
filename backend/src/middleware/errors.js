/**
 * Unified error envelope: `{ code, message, data: null }` (PRD §4.1.1 error
 * shape). The final 400/401/429/500 contract is owned by REQ-202610-1252;
 * this module implements the same interface so that requirement's middleware
 * supersedes it on merge without touching callers.
 */
const messages = {
  400: 'Bad request.',
  401: 'Missing or invalid X-DCC-Token header.',
  405: 'Method not allowed.',
  413: 'Request body is too large.',
  429: 'Too many requests.',
  500: 'Internal server error.',
};

export function errorResponse(
  status,
  message = messages[status] || messages[500],
) {
  return new Response(JSON.stringify({ code: status, message, data: null }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
