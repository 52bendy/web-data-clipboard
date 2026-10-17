export function securityHeaders(config, https) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': config.contentSecurityPolicy,
  };
  if (https) headers['strict-transport-security'] = `max-age=${config.hstsMaxAge}`;
  return headers;
}
