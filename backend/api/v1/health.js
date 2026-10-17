export function health() {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default async function healthHandler(request, response) {
  if (request.method !== 'GET') {
    response.writeHead(405, {
      'content-type': 'application/json; charset=utf-8',
      allow: 'GET',
    });
    response.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  const result = health();
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(await result.text());
}
