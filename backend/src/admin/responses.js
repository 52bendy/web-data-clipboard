const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

export function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': JSON_TYPE,
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function adminError(status, message) {
  return jsonResponse(status, { code: status, message, data: null });
}

export function htmlResponse(status, html, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      'content-type': HTML_TYPE,
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function redirectResponse(location, status = 303, headers = {}) {
  return new Response(null, {
    status,
    headers: {
      location,
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
