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

/** Same envelope with HTTP 201 for resource creation. */
export function created(data, message = 'Created') {
  return new Response(JSON.stringify({ code: 201, message, data }), {
    status: 201,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
