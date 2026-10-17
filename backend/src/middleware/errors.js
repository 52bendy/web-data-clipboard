/**
 * Unified error envelope: `{ code, message, data: null }` (PRD §4.1.1 error
 * shape), shared by every route (REQ-202610-1252).
 */
const messages = {
  400: 'Bad request.',
  401: 'Missing or invalid X-DCC-Token header.',
  403: 'HTTPS is required.',
  404: 'Not found.',
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
