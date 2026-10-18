import { DEFAULT_TTL_MS } from './clipboard-store.js';

/**
 * Clipboard read-model helpers shared by the public read API (REQ-202610-1256),
 * the admin dashboard (REQ-202610-1261) and the realtime SSE feed
 * (REQ-202610-1274). Keeping one implementation guarantees that a pushed event
 * carries exactly the same §4.1.2 fields as `GET /api/v1/clipboard/latest`.
 */

/**
 * Computes the server-authoritative expiry timing of a clipboard record.
 * `received_at` is authoritative (defect 23); `updated_at` is the legacy alias
 * kept for records written before the field was introduced.
 * Returns null when the record has no parseable server receive time.
 */
export function getClipboardTiming(
  record,
  { ttlMs = DEFAULT_TTL_MS, nowMs = Date.now() } = {},
) {
  if (!record) return null;
  const value = record.received_at ?? record.updated_at;
  const updatedAtMs = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(updatedAtMs)) return null;
  return {
    updatedAtMs,
    nowMs,
    remainingMs: updatedAtMs + ttlMs - nowMs,
  };
}

/**
 * Builds the PRD §4.1.2 clipboard payload shared by the public read API, the
 * admin dashboard card and SSE events. Returns null for absent or TTL-expired
 * records; expired content is never returned (defect 24).
 */
export function buildClipboardPayload(
  record,
  { ttlMs = DEFAULT_TTL_MS, nowMs = Date.now() } = {},
) {
  const timing = getClipboardTiming(record, { ttlMs, nowMs });
  if (!timing || timing.remainingMs <= 0) return null;
  return {
    content: record.parsed_code ?? record.full_text,
    type: record.data_type,
    raw_text: record.full_text,
    source_device: record.source?.device_name ?? 'unknown',
    platform: record.source?.platform ?? 'unknown',
    updated_at: timing.updatedAtMs,
    expire_in_seconds: Math.ceil(timing.remainingMs / 1000),
  };
}
