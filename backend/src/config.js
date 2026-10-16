export function getConfig(env = process.env) {
  const enforceHttps = env.ENFORCE_HTTPS?.toLowerCase();
  const rateLimitEnabled = env.RATE_LIMIT_ENABLED?.toLowerCase();
  const rateLimitPerMinute = Number(env.RATE_LIMIT_PER_MINUTE ?? 30);
  const rateLimitWindowSeconds = Number(env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
  if (enforceHttps !== undefined && !['true', 'false'].includes(enforceHttps)) {
    throw new Error('ENFORCE_HTTPS must be true or false.');
  }
  if (rateLimitEnabled !== undefined && !['true', 'false'].includes(rateLimitEnabled)) {
    throw new Error('RATE_LIMIT_ENABLED must be true or false.');
  }
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) {
    throw new Error('RATE_LIMIT_PER_MINUTE must be a positive integer.');
  }
  if (!Number.isInteger(rateLimitWindowSeconds) || rateLimitWindowSeconds < 1) {
    throw new Error('RATE_LIMIT_WINDOW_SECONDS must be a positive integer.');
  }
  return {
    port: Number(env.PORT || 3000),
    apiSecretToken: env.API_SECRET_TOKEN || '',
    enforceHttps:
      enforceHttps === undefined
        ? env.NODE_ENV === 'production'
        : enforceHttps === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    contentSecurityPolicy:
      env.CONTENT_SECURITY_POLICY || "default-src 'self'",
    hstsMaxAge: Number(env.HSTS_MAX_AGE || 31536000),
    rateLimitEnabled: rateLimitEnabled !== 'false',
    rateLimitPerMinute,
    rateLimitWindowSeconds,
  };
}
