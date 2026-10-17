export function securityHeaders(config, https) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      config.contentSecurityPolicy || "default-src 'self'",
  };
  if (https) {
    headers['strict-transport-security'] =
      `max-age=${config.hstsMaxAge || 31536000}`;
  }
  return headers;
}
