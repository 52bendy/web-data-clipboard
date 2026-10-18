import { randomUUID } from 'node:crypto';
import {
  DEFAULT_NAMESPACE,
  NAMESPACES_KEY,
  historyKey,
  latestKey,
  normalizeNamespace,
} from './clipboard-namespace.js';

/** Default clipboard lifetime: 30 minutes (§8.2). */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Default history retention: last 500 entries, no older than 24 hours. */
export const DEFAULT_HISTORY_MAX_ENTRIES = 500;
export const DEFAULT_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Upper bound for a single clipboard payload. */
export const MAX_FULL_TEXT_LENGTH = 100_000;

/** Optional source metadata fields introduced by REQ-202610-1276. */
const SOURCE_METADATA_FIELDS = ['project', 'label', 'collector'];
const MAX_SOURCE_METADATA_LENGTH = 128;

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
    content_json: contentJson = null,
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
    // Multi-source metadata (REQ-202610-1276) is optional so records written
    // before this requirement stay valid and keep their exact shape.
    for (const field of SOURCE_METADATA_FIELDS) {
      const value = source[field];
      if (value === undefined) continue;
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_SOURCE_METADATA_LENGTH
      ) {
        throw new ClipboardEntryError(
          'invalid_source',
          `source.${field} must be a non-empty string of at most ${MAX_SOURCE_METADATA_LENGTH} characters`,
        );
      }
      normalizedSource[field] = value;
    }
  }

  // Identifiers are always server-assigned. The client timestamp is kept only
  // as a reference field: it never participates in ordering, TTL or ETags
  // (defect 23). `received_at` is assigned inside the atomic update below.
  return {
    clipboard_id: randomUUID(),
    data_type: dataType,
    parsed_code: parsedCode,
    // Native JSON value for `type: "json"` writes (REQ-202610-1276); null for
    // text/link records so the read model keeps its historical mapping.
    content_json: contentJson,
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

  /**
   * Writes a record into one namespace. The namespace may be supplied as
   * `input.namespace` or via `options.namespace`; it defaults to `default`.
   */
  async function write(input, { namespace } = {}) {
    // Validate before taking the storage lock so malformed writes never
    // consume a sequence number or appear in history.
    const ns = normalizeNamespace(namespace ?? input?.namespace);
    const template = { ...normalizeEntry(input), namespace: ns };
    const stored = await storage.update(
      latestKey(ns),
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
    await storage.update(historyKey(ns), (history) => {
      const base = Array.isArray(history) ? history : [];
      return trimHistory(
        [...base, stored].sort(compareEntries),
        historyPolicy,
        now(),
      );
    });
    // Keep a small namespace index for maintenance and admin introspection.
    // The index is metadata only: a failure here must not reject the write.
    try {
      await storage.update(NAMESPACES_KEY, (current) => {
        const base = Array.isArray(current) ? current : [];
        const previous = base.find((item) => item.namespace === ns);
        const next = base.filter((item) => item.namespace !== ns);
        next.push({
          namespace: ns,
          last_write_at: stored.received_at,
          last_clipboard_id: stored.clipboard_id,
          writes: (previous?.writes ?? 0) + 1,
        });
        return next.sort((a, b) => a.namespace.localeCompare(b.namespace));
      });
    } catch (error) {
      logger?.warn('clipboard.namespace_index_failed', {
        namespace: ns,
        error: String(error),
      });
    }
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

  async function getLatest(namespace = DEFAULT_NAMESPACE) {
    return storage.get(latestKey(normalizeNamespace(namespace)));
  }

  async function getHistory({
    limit,
    namespace = DEFAULT_NAMESPACE,
  } = {}) {
    const history =
      (await storage.get(historyKey(normalizeNamespace(namespace)))) ?? [];
    const ordered = [...history].sort(compareEntries);
    if (typeof limit === 'number' && limit > 0 && ordered.length > limit) {
      return ordered.slice(ordered.length - limit);
    }
    return ordered;
  }

  /** Namespaces known to the store, always including `default`. */
  async function listNamespaces() {
    const index = (await storage.get(NAMESPACES_KEY)) ?? [];
    const byName = new Map(
      (Array.isArray(index) ? index : []).map((item) => [
        item.namespace,
        item,
      ]),
    );
    if (!byName.has(DEFAULT_NAMESPACE)) {
      byName.set(DEFAULT_NAMESPACE, {
        namespace: DEFAULT_NAMESPACE,
        last_write_at: null,
        last_clipboard_id: null,
        writes: 0,
      });
    }
    return [...byName.values()].sort((a, b) =>
      a.namespace.localeCompare(b.namespace),
    );
  }

  async function purgeExpired() {
    const purged = await storage.purgeExpired();
    const namespaces = new Set([
      DEFAULT_NAMESPACE,
      ...(await listNamespaces()).map((item) => item.namespace),
    ]);
    for (const ns of namespaces) {
      await storage.update(historyKey(ns), (history) => {
        if (!Array.isArray(history)) return undefined;
        return trimHistory(history, historyPolicy, now());
      });
    }
    return purged;
  }

  return { write, getLatest, getHistory, listNamespaces, purgeExpired };
}
