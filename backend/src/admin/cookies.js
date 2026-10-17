/** Minimal RFC 6265 cookie parser; malformed pairs are ignored. */
export function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

/**
 * Serializes a hardened admin cookie. `SameSite=Strict` plus `HttpOnly` keeps
 * the session out of JavaScript and off cross-site requests; `Secure` is added
 * whenever the request arrived over HTTPS (or explicitly configured).
 */
export function serializeCookie(
  name,
  value,
  { maxAgeSeconds, secure = false, sameSite = 'Strict', path = '/' } = {},
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
  ];
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);
  if (maxAgeSeconds !== undefined) {
    const seconds = Math.max(0, Math.floor(maxAgeSeconds));
    parts.push(`Max-Age=${seconds}`);
    if (seconds === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}
