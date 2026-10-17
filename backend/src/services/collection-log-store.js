import { randomUUID } from 'node:crypto';

/**
 * Collection log store (REQ-202610-1259, PRD §4.2 / §8.2).
 *
 * Append-only history of accepted device reports, used by the admin log board
 * and dashboard statistics. It is deliberately separate from the clipboard
 * history: clipboard records follow the §7.1 shape and expire after the
 * clipboard TTL, while logs retain sender / raw text / extraction outcome for
 * auditing. Retention is bounded by entry count and age so the log can never
 * grow without limit.
 */

/** Default log retention: last 1000 entries, no older than 7 days. */
export const DEFAULT_LOG_MAX_ENTRIES = 1000;
export const DEFAULT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PAGE_SIZE = 100;

const LOG_KEY = 'collection:logs';

/** Validation/query error with a stable `code` for API layers to map. */
export class CollectionLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectionLogError';
    this.code = code;
  }
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new CollectionLogError(
      'invalid_entry',
      `${field} must be a${allowEmpty ? '' : ' non-empty'} string`,
    );
  }
  return value;
}

function resolveReceivedAt(input, nowMs) {
  const value = input?.received_at;
  if (value === undefined || value === null) {
    return new Date(nowMs).toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new CollectionLogError(
      'invalid_entry',
      'received_at must be an ISO date-time string',
    );
  }
  return new Date(value).toISOString();
}

function normalizeEntry(input, receivedAt, logId) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CollectionLogError('invalid_entry', 'entry must be an object');
  }
  const {
    collection_id: collectionId,
    device_id: deviceId,
    device_name: deviceName,
    platform,
    sender = '',
    raw_content: rawContent,
    extracted_code: extractedCode = null,
    data_type: dataType = 'text',
    status = 'written',
    client_timestamp: clientTimestamp = null,
  } = input;

  requireString(collectionId, 'collection_id');
  requireString(deviceId, 'device_id');
  requireString(deviceName, 'device_name');
  requireString(platform, 'platform');
  requireString(sender, 'sender', { allowEmpty: true });
  requireString(rawContent, 'raw_content');
  requireString(dataType, 'data_type');
  requireString(status, 'status');
  if (extractedCode !== null && typeof extractedCode !== 'string') {
    throw new CollectionLogError(
      'invalid_entry',
      'extracted_code must be a string or null',
    );
  }
  if (
    clientTimestamp !== null &&
    (!Number.isInteger(clientTimestamp) || clientTimestamp < 0)
  ) {
    throw new CollectionLogError(
      'invalid_entry',
      'client_timestamp must be a non-negative integer or null',
    );
  }

  return {
    log_id: logId,
    collection_id: collectionId,
    device_id: deviceId,
    device_name: deviceName,
    platform,
    sender,
    raw_content: rawContent,
    extracted_code: extractedCode,
    data_type: dataType,
    status,
    client_timestamp: clientTimestamp,
    received_at: receivedAt,
  };
}

/** Trims a log array by age and then by count (0 = unlimited). */
function trimLogs(entries, { maxEntries, maxAgeMs }, nowMs) {
  let out = entries;
  if (maxAgeMs > 0) {
    const cutoff = nowMs - maxAgeMs;
    if (out.some((entry) => Date.parse(entry.received_at) < cutoff)) {
      out = out.filter((entry) => Date.parse(entry.received_at) >= cutoff);
    }
  }
  if (maxEntries > 0 && out.length > maxEntries) {
    out = out.slice(out.length - maxEntries);
  }
  return out;
}

function parseDateOnly(value, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new CollectionLogError(
      'invalid_date',
      `${field} must be a YYYY-MM-DD date`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new CollectionLogError('invalid_date', `${field} is not a real date`);
  }
  return date;
}

function nextDayStart(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  ).getTime();
}

function formatLocalDate(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateRange({ date, from, to }) {
  if (date !== undefined && date !== null && date !== '') {
    if (
      (from !== undefined && from !== null && from !== '') ||
      (to !== undefined && to !== null && to !== '')
    ) {
      throw new CollectionLogError(
        'invalid_query',
        'date cannot be combined with from/to',
      );
    }
    const start = parseDateOnly(date, 'date').getTime();
    return { fromMs: start, toMs: nextDayStart(new Date(start)) };
  }
  let fromMs = null;
  let toMs = null;
  if (from !== undefined && from !== null && from !== '') {
    fromMs = parseDateOnly(from, 'from').getTime();
  }
  if (to !== undefined && to !== null && to !== '') {
    const day = parseDateOnly(to, 'to');
    toMs = nextDayStart(day);
  }
  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    throw new CollectionLogError(
      'invalid_query',
      'from must be earlier than or equal to to',
    );
  }
  return { fromMs, toMs };
}

function matchesFilters(
  entry,
  { device, deviceId, deviceName, keyword, fromMs, toMs },
) {
  const receivedMs = Date.parse(entry.received_at);
  if (fromMs !== null && receivedMs < fromMs) return false;
  if (toMs !== null && receivedMs >= toMs) return false;
  if (deviceId && entry.device_id !== deviceId) return false;
  if (
    deviceName &&
    !entry.device_name.toLowerCase().includes(deviceName.toLowerCase())
  ) {
    return false;
  }
  if (device) {
    const needle = device.toLowerCase();
    if (
      !entry.device_id.toLowerCase().includes(needle) &&
      !entry.device_name.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  if (keyword) {
    const needle = keyword.toLowerCase();
    const haystack = [
      entry.collection_id,
      entry.device_id,
      entry.device_name,
      entry.sender,
      entry.raw_content,
      entry.extracted_code ?? '',
    ]
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * @param {object} options
 * @param {object} options.storage KV storage adapter (REQ-202610-1255 contract).
 * @param {number} [options.maxEntries] Retention by count (0 = unlimited).
 * @param {number} [options.maxAgeMs] Retention by age (0 = unlimited).
 * @param {() => number} [options.now] Injectable clock.
 * @param {() => string} [options.idFactory] Injectable log id factory.
 */
export function createCollectionLogStore({
  storage,
  maxEntries = DEFAULT_LOG_MAX_ENTRIES,
  maxAgeMs = DEFAULT_LOG_MAX_AGE_MS,
  now = Date.now,
  idFactory = () => `log_${randomUUID()}`,
} = {}) {
  if (!storage) {
    throw new Error('createCollectionLogStore requires a storage adapter');
  }
  const retention = { maxEntries, maxAgeMs };

  async function append(input) {
    const receivedAt = resolveReceivedAt(input, now());
    const record = normalizeEntry(input, receivedAt, idFactory());
    await storage.update(LOG_KEY, (current) => {
      const base = Array.isArray(current) ? current : [];
      return trimLogs([...base, record], retention, now());
    });
    return record;
  }

  /**
   * Paginated, filtered history. Newest entries first.
   *
   * @param {object} [query]
   * @param {number} [query.page] 1-based page number.
   * @param {number} [query.pageSize] Entries per page (1..100).
   * @param {string} [query.device] Case-insensitive substring of device id or name.
   * @param {string} [query.deviceId] Exact device id.
   * @param {string} [query.deviceName] Case-insensitive device-name substring.
   * @param {string} [query.date] Single local day (YYYY-MM-DD).
   * @param {string} [query.from] Inclusive start date (YYYY-MM-DD).
   * @param {string} [query.to] Inclusive end date (YYYY-MM-DD).
   * @param {string} [query.keyword] Substring across sender/device/text/code.
   */
  async function query({
    page = 1,
    pageSize = 20,
    device,
    deviceId,
    deviceName,
    date,
    from,
    to,
    keyword,
  } = {}) {
    if (!Number.isInteger(page) || page < 1) {
      throw new CollectionLogError(
        'invalid_query',
        'page must be a positive integer',
      );
    }
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PAGE_SIZE
    ) {
      throw new CollectionLogError(
        'invalid_query',
        `page_size must be an integer between 1 and ${MAX_PAGE_SIZE}`,
      );
    }

    const range = dateRange({ date, from, to });
    const filters = {
      device: typeof device === 'string' ? device.trim() : '',
      deviceId: typeof deviceId === 'string' ? deviceId.trim() : '',
      deviceName: typeof deviceName === 'string' ? deviceName.trim() : '',
      keyword: typeof keyword === 'string' ? keyword.trim() : '',
      ...range,
    };
    const history = (await storage.get(LOG_KEY)) ?? [];
    const entries = trimLogs(
      Array.isArray(history) ? history : [],
      retention,
      now(),
    ).filter((entry) => matchesFilters(entry, filters));

    entries.sort((a, b) => {
      const byTime = Date.parse(b.received_at) - Date.parse(a.received_at);
      if (byTime !== 0) return byTime;
      return String(b.log_id).localeCompare(String(a.log_id));
    });

    const total = entries.length;
    const offset = (page - 1) * pageSize;
    const items = entries.slice(offset, offset + pageSize);
    return {
      items,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    };
  }

  /** Dashboard counters derived from the retained log (single source of truth). */
  async function getStats() {
    const nowMs = now();
    const history = (await storage.get(LOG_KEY)) ?? [];
    const entries = trimLogs(
      Array.isArray(history) ? history : [],
      retention,
      nowMs,
    );
    const dayStart = new Date(nowMs);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = nextDayStart(dayStart);
    const today = entries.filter((entry) => {
      const receivedMs = Date.parse(entry.received_at);
      return receivedMs >= dayStart.getTime() && receivedMs < dayEnd;
    });

    return {
      date: formatLocalDate(nowMs),
      today_collected: today.length,
      today_extracted: today.filter((entry) => entry.extracted_code !== null)
        .length,
      bound_devices: new Set(entries.map((entry) => entry.device_id)).size,
    };
  }

  /** Applies age/count retention without requiring a new append. */
  async function prune() {
    const nowMs = now();
    return storage.update(LOG_KEY, (current) => {
      if (!Array.isArray(current)) return undefined;
      const next = trimLogs(current, retention, nowMs);
      return next.length === current.length ? current : next;
    });
  }

  return { append, query, getStats, prune };
}
