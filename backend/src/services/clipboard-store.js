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

function normalizeEntry(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClipboardEntryError('invalid_entry', 'entry must be an object');
  }
  const {
    full_text: fullText,
    parsed_code: parsedCode = null,
    data_type: dataType = 'text',
    source,
    client_timestamp: clientTimestamp = null,
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
  if (
    clientTimestamp !== null &&
    (!Number.isInteger(clientTimestamp) || clientTimestamp < 0)
  ) {
    throw new ClipboardEntryError(
      'invalid_client_timestamp',
      'client_timestamp must be a non-negative integer or null',
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

  // Identifiers are always server-assigned. The client timestamp is kept only
  // as a reference field: it never participates in ordering, TTL or ETags
  // (defect 23). `received_at` is assigned inside the atomic update below.
  return {
    clipboard_id: randomUUID(),
    data_type: dataType,
    parsed_code: parsedCode,
    full_text: fullText,
    client_timestamp: clientTimestamp,
    source: normalizedSource,
  };
}

/** Server receive time of an entry, with legacy `updated_at` fallback. */
function entryTimeMs(entry) {
  const value = entry?.received_at ?? entry?.updated_at;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** History order is server receive time, then the server sequence number. */
function compareEntries(a, b) {
  const byTime = entryTimeMs(a) - entryTimeMs(b);
  if (byTime !== 0) return byTime;
  return (a?.seq ?? 0) - (b?.seq ?? 0);
}

function trimHistory(history, { maxEntries, maxAgeMs }, nowMs) {
  let out = history;
  if (maxAgeMs > 0) {
    const cutoff = nowMs - maxAgeMs;
    if (out.some((entry) => entryTimeMs(entry) < cutoff)) {
      out = out.filter((entry) => entryTimeMs(entry) >= cutoff);
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
 * - Server receive time is authoritative: `received_at` is assigned inside the
 *   per-key atomic update and mirrored to `updated_at` for the PRD §4.1.2
 *   contract. Client clocks cannot influence ordering, TTL or ETags.
 * - `client_timestamp` is retained only as a reference field (defect 23).
 * - Concurrent writes serialize per key: every accepted write takes the next
 *   `seq`, the last committed write wins as latest, and each history entry
 *   records the `overwrote` snapshot of the record it replaced.
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
} = {}) {
  if (!storage) {
    throw new Error('createClipboardStore requires a storage adapter');
  }
  const historyPolicy = {
    maxEntries: historyMaxEntries,
    maxAgeMs: historyMaxAgeMs,
  };

  async function write(input) {
    // Validate before taking the storage lock so malformed writes never
    // consume a sequence number or appear in history.
    const template = normalizeEntry(input);
    const stored = await storage.update(
      LATEST_KEY,
      (current) => {
        const previous = current ?? null;
        // Assign the receive time at commit time, in the same serialized
        // critical section that assigns `seq`, so both orders always agree.
        const receivedAt = new Date(now()).toISOString();
        return {
          ...template,
          received_at: receivedAt,
          updated_at: receivedAt,
          seq: (previous?.seq ?? 0) + 1,
          overwrote: previous
            ? {
                clipboard_id: previous.clipboard_id ?? null,
                seq: previous.seq ?? null,
                received_at:
                  previous.received_at ?? previous.updated_at ?? null,
              }
            : null,
        };
      },
      { ttlMs },
    );
    await storage.update(HISTORY_KEY, (history) => {
      const base = Array.isArray(history) ? history : [];
      return trimHistory(
        [...base, stored].sort(compareEntries),
        historyPolicy,
        now(),
      );
    });
    return stored;
  }

  async function getLatest() {
    return storage.get(LATEST_KEY);
  }

  async function getHistory({ limit } = {}) {
    const history = (await storage.get(HISTORY_KEY)) ?? [];
    const ordered = [...history].sort(compareEntries);
    if (typeof limit === 'number' && limit > 0 && ordered.length > limit) {
      return ordered.slice(ordered.length - limit);
    }
    return ordered;
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
