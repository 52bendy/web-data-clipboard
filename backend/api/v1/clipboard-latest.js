import { getConfig } from '../../src/config.js';
import { authorize } from '../../src/middleware/auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import { DEFAULT_TTL_MS } from '../../src/services/clipboard-store.js';

/**
 * Defect 24 / REQ-202610-1273: an absent or TTL-expired clipboard is
 * indistinguishable (404). See docs/clipboard-ttl-semantics.md.
 */
const NO_DATA_MESSAGE = 'No clipboard data available.';
/** Defect 21: tokens in the query string are never accepted. */
const QUERY_TOKEN_MESSAGE =
  'Token must be sent in the X-DCC-Token header; query-string tokens are not supported.';

/**
 * A missing and a TTL-expired clipboard share one response (REQ-202610-1273).
 * `no-store` keeps intermediaries from caching the empty state and delaying
 * the next write's visibility.
 */
function noDataResponse() {
  const response = errorResponse(404, NO_DATA_MESSAGE);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/**
 * GET /api/v1/clipboard/latest (PRD §4.1.2).
 *
 * Returns the latest clipboard record in the exact §4.1.2 shape
 * `{ code, data: { content, type, raw_text, source_device, platform,
 * updated_at, expire_in_seconds } }`. `updated_at` is a server-assigned epoch
 * millisecond value (defect 23), and `expire_in_seconds` reflects the
 * configured TTL rather than a client-supplied timestamp.
 *
 * Polling support: the response carries an `ETag` and `Last-Modified` derived
 * from `updated_at`; `If-None-Match` / `If-Modified-Since` (and the explicit
 * `?updated_after=<epoch-ms|ISO-8601>` form) return 304 without a body when the
 * clipboard has not changed. This keeps §7.2.1 pollers cheap.
 */
export function createClipboardLatestHandler({
  config = getConfig(),
  services,
  now = Date.now,
} = {}) {
  if (!services?.clipboardStore) {
    throw new Error(
      'createClipboardLatestHandler requires services.clipboardStore',
    );
  }
  const ttlMs = config.clipboard?.ttlMs ?? DEFAULT_TTL_MS;

  return async function handleClipboardLatest(request, url) {
    const parsedUrl =
      url ??
      new URL(
        request.url ?? '/',
        `http://${request.headers.host || 'localhost'}`,
      );

    if (request.method !== 'GET') {
      return errorResponse(405);
    }
    // Reject query-string tokens before anything else so a leaked URL can
    // never authenticate a read (defect 21). The header is the only channel.
    if (parsedUrl.searchParams.has('token')) {
      return errorResponse(400, QUERY_TOKEN_MESSAGE);
    }
    // Defense in depth: the route table already enforces auth: true, but the
    // handler also works when mounted directly (e.g. serverless adapters).
    const denied = authorize(request, config.apiSecretToken);
    if (denied) return denied;

    const record = await services.clipboardStore.getLatest();
    if (!record) return noDataResponse();

    const timing = getClipboardTiming(record, { ttlMs, nowMs: now() });
    if (!timing) {
      return errorResponse(500);
    }
    // Storage adapters treat expired entries as absent, but the API also
    // guards here so an adapter that returns stale data cannot leak it. The
    // boundary is inclusive: at `updated_at + ttlMs` the record is expired.
    if (timing.remainingMs <= 0) {
      return noDataResponse();
    }
    const { updatedAtMs } = timing;

    const etag = `"${updatedAtMs}-${record.clipboard_id}"`;
    const lastModified = new Date(updatedAtMs).toUTCString();
    const cacheHeaders = {
      etag,
      'last-modified': lastModified,
      'cache-control': 'no-store',
    };

    if (isNotModified(request, parsedUrl, { updatedAtMs, etag })) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }

    const data = buildClipboardPayload(record, {
      ttlMs,
      nowMs: timing.nowMs,
    });

    return new Response(JSON.stringify({ code: 200, data }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...cacheHeaders,
      },
    });
  };
}

/**
 * Computes the server-authoritative expiry timing of a clipboard record.
 * Returns null when the record has no parseable `updated_at`.
 */
export function getClipboardTiming(
  record,
  { ttlMs = DEFAULT_TTL_MS, nowMs = Date.now() } = {},
) {
  if (!record) return null;
  const updatedAtMs =
    typeof record.updated_at === 'number'
      ? record.updated_at
      : Date.parse(record.updated_at);
  if (!Number.isFinite(updatedAtMs)) return null;
  return {
    updatedAtMs,
    nowMs,
    remainingMs: updatedAtMs + ttlMs - nowMs,
  };
}

/**
 * Builds the PRD §4.1.2 clipboard payload shared by the public read API and
 * the admin dashboard card, so both views cannot drift apart. Returns null for
 * absent or TTL-expired records; expired content is never returned (defect 24).
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

/**
 * Evaluates HTTP conditional headers against the clipboard's server-side
 * `updated_at`. `If-None-Match` takes precedence over `If-Modified-Since`
 * (RFC 9110); `updated_after` is the simple polling form.
 */
function isNotModified(request, url, { updatedAtMs, etag }) {
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    return String(ifNoneMatch)
      .split(',')
      .map((value) => value.trim())
      .some((value) => {
        if (value === '*') return true;
        const normalized = value.replace(/^W\//, '');
        // Accept the full opaque ETag as well as a bare updated_at value,
        // which downstream scripts commonly persist.
        return (
          normalized === etag ||
          normalized === `"${updatedAtMs}"` ||
          normalized === String(updatedAtMs)
        );
      });
  }

  const ifModifiedSince = request.headers['if-modified-since'];
  if (ifModifiedSince !== undefined) {
    const sinceMs = Date.parse(String(ifModifiedSince));
    // Last-Modified has one-second resolution; truncate before comparing.
    return (
      Number.isFinite(sinceMs) &&
      Math.floor(updatedAtMs / 1000) * 1000 <= sinceMs
    );
  }

  const updatedAfter = url.searchParams.get('updated_after');
  if (updatedAfter !== null) {
    const parsed = parseUpdatedAfter(updatedAfter);
    return parsed !== null && updatedAtMs <= parsed;
  }

  return false;
}

function parseUpdatedAfter(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
