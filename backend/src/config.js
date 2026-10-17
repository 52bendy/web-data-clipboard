import {
  DEFAULT_HISTORY_MAX_AGE_MS,
  DEFAULT_HISTORY_MAX_ENTRIES,
  DEFAULT_TTL_MS,
} from './services/clipboard-store.js';
import {
  DEFAULT_LOG_MAX_AGE_MS,
  DEFAULT_LOG_MAX_ENTRIES,
} from './services/collection-log-store.js';

const DEFAULT_PORT = 3000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 1000;
/** Upper bound for raw_content (characters), §4.1.1 field validation. */
const DEFAULT_MAX_RAW_CONTENT_LENGTH = 4096;
/** Request body cap for the dev server, guards against oversized payloads. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_DEVICE_ONLINE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** Dashboard auto-refresh cadence (REQ-202610-1261). */
const DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS = 15 * 1000;
const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ADMIN_MAX_SESSIONS = 1000;
/** Webhook delivery limits (REQ-202610-1258). */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 3;
const DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_WEBHOOK_MAX_CONFIGS = 20;
const DEFAULT_WEBHOOK_MAX_DELIVERIES = 200;

/** Lenient integer parsing for business settings: invalid values fall back. */
function positiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Strict parsing for security-sensitive settings: invalid values fail fast. */
function strictPositiveInt(value, fallback, name) {
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
  if (
    rateLimitEnabled !== undefined &&
    !['true', 'false'].includes(rateLimitEnabled)
  ) {
    throw new Error('RATE_LIMIT_ENABLED must be true or false.');
  }
  if (
    adminCookieSecure !== undefined &&
    !['true', 'false', 'auto'].includes(adminCookieSecure)
  ) {
    throw new Error('ADMIN_COOKIE_SECURE must be true, false, or auto.');
  }
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) {
    throw new Error('RATE_LIMIT_PER_MINUTE must be a positive integer.');
  }
  if (!Number.isInteger(rateLimitWindowSeconds) || rateLimitWindowSeconds < 1) {
    throw new Error('RATE_LIMIT_WINDOW_SECONDS must be a positive integer.');
  }
  return {
    port: positiveInt(env.PORT, DEFAULT_PORT),
    // 采集接口鉴权 Token（PRD §9.1）：客户端以 X-DCC-Token 头携带（§4.1.1）。
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
    // 「自动提取」开关（PRD §4.2）：缺省开启，AUTO_EXTRACT=false|0 关闭；
    // 后台设置面板（REQ-202610-1262）可在运行时覆盖该值并持久化。
    autoExtract: env.AUTO_EXTRACT !== 'false' && env.AUTO_EXTRACT !== '0',
    // 「脱敏模式」（PRD §8.2）：缺省开启，MASK_SENDER=false|0 关闭。
    // 后台设置面板（REQ-202610-1262）可在运行时覆盖该值并持久化。
    maskSender: env.MASK_SENDER !== 'false' && env.MASK_SENDER !== '0',
    storage: {
      // Only "memory" is implemented until the runtime selection lands
      // (REQ-202610-1251); business layers stay unchanged when it changes.
      driver: env.STORAGE_DRIVER || 'memory',
    },
    clipboard: {
      // TTL of the latest clipboard record; default 30 minutes (§8.2).
      ttlMs: positiveInt(env.CLIPBOARD_TTL_MS, DEFAULT_TTL_MS),
      // History retention by count and age; 0 = unlimited.
      historyMaxEntries: nonNegativeInt(
        env.CLIPBOARD_HISTORY_MAX_ENTRIES,
        DEFAULT_HISTORY_MAX_ENTRIES,
      ),
      historyMaxAgeMs: nonNegativeInt(
        env.CLIPBOARD_HISTORY_TTL_MS,
        DEFAULT_HISTORY_MAX_AGE_MS,
      ),
      // Interval of the dev-server expiry sweep.
      maintenanceIntervalMs: positiveInt(
        env.CLIPBOARD_MAINTENANCE_INTERVAL_MS,
        DEFAULT_MAINTENANCE_INTERVAL_MS,
      ),
    },
    devices: {
      // 设备离线阈值（REQ-202610-1257）：默认 24h，非法值回退默认。
      onlineThresholdMs: positiveInt(
        env.DEVICE_ONLINE_THRESHOLD_MS,
        DEFAULT_DEVICE_ONLINE_THRESHOLD_MS,
      ),
    },
    collect: {
      // raw_content length cap (characters); longer payloads are rejected 400.
      maxRawContentLength: positiveInt(
        env.MAX_RAW_CONTENT_LENGTH,
        DEFAULT_MAX_RAW_CONTENT_LENGTH,
      ),
      // Request body cap in bytes; larger bodies are rejected 413.
      maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    },
    logs: {
      // Collection-log retention; bounded so the log never grows forever.
      maxEntries: nonNegativeInt(env.LOG_MAX_ENTRIES, DEFAULT_LOG_MAX_ENTRIES),
      maxAgeMs: nonNegativeInt(env.LOG_MAX_AGE_MS, DEFAULT_LOG_MAX_AGE_MS),
    },
    webhook: {
      // Per-attempt network timeout; retries use exponential backoff.
      timeoutMs: positiveInt(
        env.WEBHOOK_TIMEOUT_MS,
        DEFAULT_WEBHOOK_TIMEOUT_MS,
      ),
      maxAttempts: positiveInt(
        env.WEBHOOK_MAX_ATTEMPTS,
        DEFAULT_WEBHOOK_MAX_ATTEMPTS,
      ),
      retryBaseDelayMs: nonNegativeInt(
        env.WEBHOOK_RETRY_BASE_DELAY_MS,
        DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS,
      ),
      maxConfigs: positiveInt(
        env.WEBHOOK_MAX_CONFIGS,
        DEFAULT_WEBHOOK_MAX_CONFIGS,
      ),
      maxDeliveries: positiveInt(
        env.WEBHOOK_MAX_DELIVERIES,
        DEFAULT_WEBHOOK_MAX_DELIVERIES,
      ),
    },
    dashboard: {
      // Polling cadence of the admin dashboard; the page reads this value
      // from a server-rendered data attribute (REQ-202610-1261).
      refreshIntervalMs: positiveInt(
        env.DASHBOARD_REFRESH_INTERVAL_MS,
        DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS,
      ),
    },
    // 管理后台登录态（REQ-202610-1260，缺陷 20）。未配置任何凭据时后台
    // fail closed：所有管理资源一律拒绝，而不是退回匿名可访问。
    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      password: env.ADMIN_PASSWORD || '',
      // 推荐使用 scrypt 哈希（node scripts/hash-admin-password.js 生成），
      // 明文 ADMIN_PASSWORD 仅用于本地开发兜底。
      passwordHash: env.ADMIN_PASSWORD_HASH || '',
      sessionTtlMs: strictPositiveInt(
        env.ADMIN_SESSION_TTL_MS,
        DEFAULT_ADMIN_SESSION_TTL_MS,
        'ADMIN_SESSION_TTL_MS',
      ),
      loginMaxAttempts: strictPositiveInt(
        env.ADMIN_LOGIN_MAX_ATTEMPTS,
        DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS,
        'ADMIN_LOGIN_MAX_ATTEMPTS',
      ),
      loginWindowMs: strictPositiveInt(
        env.ADMIN_LOGIN_WINDOW_MS,
        DEFAULT_ADMIN_LOGIN_WINDOW_MS,
        'ADMIN_LOGIN_WINDOW_MS',
      ),
      maxSessions: strictPositiveInt(
        env.ADMIN_MAX_SESSIONS,
        DEFAULT_ADMIN_MAX_SESSIONS,
        'ADMIN_MAX_SESSIONS',
      ),
      cookieSecure: adminCookieSecure || 'auto',
    },
  };
}
