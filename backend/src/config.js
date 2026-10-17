import {
  DEFAULT_HISTORY_MAX_AGE_MS,
  DEFAULT_HISTORY_MAX_ENTRIES,
  DEFAULT_TTL_MS,
} from './services/clipboard-store.js';
import { normalizeAllowedHosts } from './services/webhook-target.js';

const DEFAULT_PORT = 3000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 1000;
/** Upper bound for raw_content (characters), §4.1.1 field validation. */
const DEFAULT_MAX_RAW_CONTENT_LENGTH = 4096;
/** Request body cap for the dev server, guards against oversized payloads. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** Webhook delivery limits (REQ-202610-1258). */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 3;
const DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_WEBHOOK_MAX_CONFIGS = 20;
const DEFAULT_WEBHOOK_MAX_DELIVERIES = 200;

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

/**
 * Parses `WEBHOOK_ALLOWED_HOSTS` (comma-separated hostnames, IP literals or
 * `*.domain` wildcards). An empty value disables the allowlist. Invalid
 * entries fail fast at startup instead of silently widening or narrowing
 * the allowed target set.
 */
function parseAllowedHosts(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return [];
  }
  const entries = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  try {
    return normalizeAllowedHosts(entries);
  } catch (error) {
    throw new Error(`WEBHOOK_ALLOWED_HOSTS is invalid: ${error.message}`);
  }
}

export function getConfig(env = process.env) {
  const enforceHttps = env.ENFORCE_HTTPS?.toLowerCase();
  const rateLimitEnabled = env.RATE_LIMIT_ENABLED?.toLowerCase();
  const rateLimitPerMinute = Number(env.RATE_LIMIT_PER_MINUTE ?? 30);
  const rateLimitWindowSeconds = Number(env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
  if (enforceHttps !== undefined && !['true', 'false'].includes(enforceHttps)) {
    throw new Error('ENFORCE_HTTPS must be true or false.');
  }
  if (
    rateLimitEnabled !== undefined &&
    !['true', 'false'].includes(rateLimitEnabled)
  ) {
    throw new Error('RATE_LIMIT_ENABLED must be true or false.');
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
    contentSecurityPolicy: env.CONTENT_SECURITY_POLICY || "default-src 'self'",
    hstsMaxAge: Number(env.HSTS_MAX_AGE || 31536000),
    rateLimitEnabled: rateLimitEnabled !== 'false',
    rateLimitPerMinute,
    rateLimitWindowSeconds,
    // 「自动提取」开关（PRD §4.2）：缺省开启，AUTO_EXTRACT=false|0 关闭；
    // 后续后台设置面板（REQ-202610-1262）接入后可覆盖该缺省值。
    autoExtract: env.AUTO_EXTRACT !== 'false' && env.AUTO_EXTRACT !== '0',
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
    collect: {
      // raw_content length cap (characters); longer payloads are rejected 400.
      maxRawContentLength: positiveInt(
        env.MAX_RAW_CONTENT_LENGTH,
        DEFAULT_MAX_RAW_CONTENT_LENGTH,
      ),
      // Request body cap in bytes; larger bodies are rejected 413.
      maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    },
    webhook: {
      // Optional outbound target allowlist (defect 22). Empty = disabled.
      allowedHosts: parseAllowedHosts(env.WEBHOOK_ALLOWED_HOSTS),
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
  };
}
