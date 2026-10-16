export function getConfig(env = process.env) {
  const enforceHttps = env.ENFORCE_HTTPS?.toLowerCase();
  if (enforceHttps !== undefined && !['true', 'false'].includes(enforceHttps)) {
    throw new Error('ENFORCE_HTTPS must be true or false.');
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
  };
}
