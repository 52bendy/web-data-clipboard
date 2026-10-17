import { randomUUID } from 'node:crypto';

/** Default clipboard lifetime: 30 minutes (§8.2). */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Default history retention: last 500 entries, no older than 24 hours. */
export const DEFAULT_HISTORY_MAX_ENTRIES = 500;
export const DEFAULT_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Upper bound for a single clipboard payload. */
export const MAX_FULL_TEXT_LENGTH = 100_000;

const LATEST_KEY = 'clipboard:latest';
const HISTORY_KEY = 'clipboard:history';

/** Validation error with a stable `code` for API layers to map. */
export class ClipboardEntryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClipboardEntryError';
    this.code = code;
  }
}

function normalizeEntry(input, receivedAt) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClipboardEntryError('invalid_entry', 'entry must be an object');
  }
  const {
    full_text: fullText,
    parsed_code: parsedCode = null,
    data_type: dataType = 'text',
    source,
  } = input;

  if (typeof fullText !== 'string' || fullText.length === 0) {
    throw new ClipboardEntryError(
      'invalid_full_text',
      'full_text must be a non-empty string',
    );
  }
  if (fullText.length > MAX_FULL_TEXT_LENGTH) {
    throw new ClipboardEntryError(
      'full_text_too_long',
      `full_text must be at most ${MAX_FULL_TEXT_LENGTH} characters`,
    );
  }
  if (parsedCode !== null && typeof parsedCode !== 'string') {
    throw new ClipboardEntryError(
      'invalid_parsed_code',
      'parsed_code must be a string or null',
    );
  }
  if (typeof dataType !== 'string' || dataType.length === 0) {
    throw new ClipboardEntryError(
      'invalid_data_type',
      'data_type must be a non-empty string',
    );
  }

  let normalizedSource = { device_name: 'unknown', platform: 'unknown' };
  if (source !== undefined) {
    if (
      source === null ||
      typeof source !== 'object' ||
      Array.isArray(source)
    ) {
      throw new ClipboardEntryError(
        'invalid_source',
        'source must be an object',
      );
    }
    const { device_name: deviceName = 'unknown', platform = 'unknown' } =
      source;
    if (typeof deviceName !== 'string' || typeof platform !== 'string') {
      throw new ClipboardEntryError(
        'invalid_source',
        'source.device_name and source.platform must be strings',
      );
    }
    normalizedSource = { device_name: deviceName, platform };
  }

  // Server receive time and identifiers are always assigned here: client
  // timestamps or ids are ignored so ordering cannot be spoofed (defect 23).
  return {
    clipboard_id: randomUUID(),
    data_type: dataType,
    parsed_code: parsedCode,
    full_text: fullText,
    updated_at: new Date(receivedAt).toISOString(),
    source: normalizedSource,
  };
}

function trimHistory(history, { maxEntries, maxAgeMs }, nowMs) {
  let out = history;
  if (maxAgeMs > 0) {
    const cutoff = nowMs - maxAgeMs;
    if (out.some((entry) => Date.parse(entry.updated_at) < cutoff)) {
      out = out.filter((entry) => Date.parse(entry.updated_at) >= cutoff);
    }
  }
  if (maxEntries > 0 && out.length > maxEntries) {
    out = out.slice(out.length - maxEntries);
  }
  return out;
}

/**
 * Clipboard state service: the single latest clipboard record (§7.1) plus an
 * append-only history log, on top of a pluggable storage adapter.
 *
 * - Server receive time is authoritative: `updated_at` and the write sequence
 *   are assigned server-side; client timestamps are ignored (defect 23).
 * - Concurrent writes serialize per key: each accepted write takes the next
 *   `seq`, the last one wins as latest, and every write is appended to history.
 * - TTL: the latest record expires after `ttlMs` (default 30 min); expired
 *   reads return null (treated as absent) and expired data is cleaned up by
 *   lazy reads, the maintenance sweep, or `purgeExpired()`.
 * - History retention is configurable by count and age (0 = unlimited).
 */
export function createClipboardStore({
  storage,
  ttlMs = DEFAULT_TTL_MS,
  historyMaxEntries = DEFAULT_HISTORY_MAX_ENTRIES,
  historyMaxAgeMs = DEFAULT_HISTORY_MAX_AGE_MS,
  now = Date.now,
  // Optional post-write hook used by the realtime feed (REQ-202610-1274).
  // Hook failures must never reject an already-persisted clipboard update.
  onWrite = null,
  logger = null,
} = {}) {
  if (!storage) {
    throw new Error('createClipboardStore requires a storage adapter');
  }
  const historyPolicy = {
    maxEntries: historyMaxEntries,
    maxAgeMs: historyMaxAgeMs,
  };

  async function write(input) {
    const record = normalizeEntry(input, now());
    const stored = await storage.update(
      LATEST_KEY,
      (current) => ({ ...record, seq: (current?.seq ?? 0) + 1 }),
      { ttlMs },
    );
    await storage.update(HISTORY_KEY, (history) => {
      const base = Array.isArray(history) ? history : [];
      return trimHistory([...base, stored], historyPolicy, now());
    });
    if (onWrite) {
      try {
        await onWrite(stored);
      } catch (error) {
        logger?.error('clipboard.write_hook_failed', {
          clipboard_id: stored.clipboard_id,
          error: String(error),
        });
      }
    }
    return stored;
  }

  async function getLatest() {
    return storage.get(LATEST_KEY);
  }

  async function getHistory({ limit } = {}) {
    const history = (await storage.get(HISTORY_KEY)) ?? [];
    if (typeof limit === 'number' && limit > 0 && history.length > limit) {
      return history.slice(history.length - limit);
    }
    return history;
  }

  async function purgeExpired() {
    const purged = await storage.purgeExpired();
    await storage.update(HISTORY_KEY, (history) => {
      if (!Array.isArray(history)) return undefined;
      return trimHistory(history, historyPolicy, now());
    });
    return purged;
  }

  return { write, getLatest, getHistory, purgeExpired };
}
