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

export function getConfig(env = process.env) {
  return {
    port: positiveInt(env.PORT, DEFAULT_PORT),
    // 采集接口鉴权 Token（PRD §9.1）：客户端以 X-DCC-Token 头携带（§4.1.1）。
    apiSecretToken: env.API_SECRET_TOKEN || '',
    // 「自动提取」开关（PRD §4.2）：缺省开启，AUTO_EXTRACT=false|0 关闭；
    // 后续后台设置面板（REQ-202610-1262）接入后可覆盖该缺省值。
    autoExtract: env.AUTO_EXTRACT !== 'false' && env.AUTO_EXTRACT !== '0',
    // 「脱敏模式」（PRD §8.2）：缺省开启，MASK_SENDER=false|0 关闭。
    // 后台设置面板（REQ-202610-1262）接入后可覆盖该缺省值。
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
  };
}
