/**
 * Success envelope: `{ code, message, data }` with `code: 200` (PRD §4.1.1).
 * Error responses use the shared envelope in `src/middleware/errors.js`.
 */
export function ok(data, message = 'ok') {
  return new Response(JSON.stringify({ code: 200, message, data }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
