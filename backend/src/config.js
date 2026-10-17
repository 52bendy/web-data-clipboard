const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ADMIN_MAX_SESSIONS = 1000;

function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function getConfig(env = process.env) {
  const enforceHttps = env.ENFORCE_HTTPS?.toLowerCase();
  const rateLimitEnabled = env.RATE_LIMIT_ENABLED?.toLowerCase();
  const rateLimitPerMinute = Number(env.RATE_LIMIT_PER_MINUTE ?? 30);
  const rateLimitWindowSeconds = Number(env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
  const adminCookieSecure = env.ADMIN_COOKIE_SECURE?.toLowerCase();
  if (enforceHttps !== undefined && !['true', 'false'].includes(enforceHttps)) {
    throw new Error('ENFORCE_HTTPS must be true or false.');
  }
  if (rateLimitEnabled !== undefined && !['true', 'false'].includes(rateLimitEnabled)) {
    throw new Error('RATE_LIMIT_ENABLED must be true or false.');
  }
  if (adminCookieSecure !== undefined && !['true', 'false', 'auto'].includes(adminCookieSecure)) {
    throw new Error('ADMIN_COOKIE_SECURE must be true, false, or auto.');
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
    // 管理后台登录态（REQ-202610-1260，缺陷 20）。未配置任何凭据时后台
    // fail closed：所有管理资源一律拒绝，而不是退回匿名可访问。
    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      password: env.ADMIN_PASSWORD || '',
      // 推荐使用 scrypt 哈希（node scripts/hash-admin-password.js 生成），
      // 明文 ADMIN_PASSWORD 仅用于本地开发兜底。
      passwordHash: env.ADMIN_PASSWORD_HASH || '',
      sessionTtlMs: positiveInt(
        env.ADMIN_SESSION_TTL_MS,
        DEFAULT_ADMIN_SESSION_TTL_MS,
        'ADMIN_SESSION_TTL_MS',
      ),
      loginMaxAttempts: positiveInt(
        env.ADMIN_LOGIN_MAX_ATTEMPTS,
        DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS,
        'ADMIN_LOGIN_MAX_ATTEMPTS',
      ),
      loginWindowMs: positiveInt(
        env.ADMIN_LOGIN_WINDOW_MS,
        DEFAULT_ADMIN_LOGIN_WINDOW_MS,
        'ADMIN_LOGIN_WINDOW_MS',
      ),
      maxSessions: positiveInt(
        env.ADMIN_MAX_SESSIONS,
        DEFAULT_ADMIN_MAX_SESSIONS,
        'ADMIN_MAX_SESSIONS',
      ),
      cookieSecure: adminCookieSecure || 'auto',
    },
  };
}
