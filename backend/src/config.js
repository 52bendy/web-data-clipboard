import {
  DEFAULT_HISTORY_MAX_AGE_MS,
  DEFAULT_HISTORY_MAX_ENTRIES,
  DEFAULT_TTL_MS,
} from './services/clipboard-store.js';

const DEFAULT_PORT = 3000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 1000;

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
  };
}
