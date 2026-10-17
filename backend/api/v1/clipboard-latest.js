import { getConfig } from '../../src/config.js';
import { authorize } from '../../src/middleware/auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import { rejectQueryToken } from '../../src/middleware/queryToken.js';
import { DEFAULT_TTL_MS } from '../../src/services/clipboard-store.js';

/** Defect 24: an absent or TTL-expired clipboard is indistinguishable (404). */
const NO_DATA_MESSAGE = 'No clipboard data available.';

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
    // createApp applies the same guard globally; this keeps direct mounts safe.
    const queryTokenDenied = rejectQueryToken(parsedUrl);
    if (queryTokenDenied) return queryTokenDenied;
    // Defense in depth: the route table already enforces auth: true, but the
    // handler also works when mounted directly (e.g. serverless adapters).
    const denied = authorize(request, config.apiSecretToken);
    if (denied) return denied;

    const record = await services.clipboardStore.getLatest();
    if (!record) return errorResponse(404, NO_DATA_MESSAGE);

    const updatedAtMs =
      typeof record.updated_at === 'number'
        ? record.updated_at
        : Date.parse(record.updated_at);
    if (!Number.isFinite(updatedAtMs)) {
      return errorResponse(500);
    }

    // Storage adapters treat expired entries as absent, but the API also
    // guards here so an adapter that returns stale data cannot leak it.
    const currentTime = now();
    const remainingMs = updatedAtMs + ttlMs - currentTime;
    if (remainingMs <= 0) {
      return errorResponse(404, NO_DATA_MESSAGE);
    }

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

    const data = {
      content: record.parsed_code ?? record.full_text,
      type: record.data_type,
      raw_text: record.full_text,
      source_device: record.source?.device_name ?? 'unknown',
      platform: record.source?.platform ?? 'unknown',
      updated_at: updatedAtMs,
      expire_in_seconds: Math.ceil(remainingMs / 1000),
    };

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
