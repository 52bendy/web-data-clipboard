import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { getConfig } from '../../src/config.js';
import { authorize } from '../../src/middleware/auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import { rejectQueryToken } from '../../src/middleware/queryToken.js';
import { buildClipboardPayload } from '../../src/services/clipboard-payload.js';
import { formatClipboardEventId } from '../../src/services/realtime-hub.js';
import { DEFAULT_TTL_MS } from '../../src/services/clipboard-store.js';

/**
 * GET /api/v1/clipboard/stream (REQ-202610-1274, PRD §10 Phase 2).
 *
 * Server-Sent Events feed for the clipboard. Every `clipboard.updated` event
 * carries the exact §4.1.2 payload returned by `GET /api/v1/clipboard/latest`,
 * so a downstream client can switch from polling to push without changing its
 * data model.
 *
 * Wire contract:
 * - `retry: <ms>` on connect tells EventSource how quickly to reconnect;
 * - `event: ready` announces the heartbeat cadence;
 * - `event: clipboard.updated` carries `id: <updated_at>-<clipboard_id>`,
 *   which clients echo back via `Last-Event-ID` on reconnect;
 * - comment frames (`: heartbeat <epoch-ms>`) keep proxies from timing out;
 * - `event: reconnect` is sent before a server-enforced TTL close.
 *
 * Auth is header-only (`X-DCC-Token`); a token-like query parameter is rejected
 * with 400 before authentication (defect 21). Native browser `EventSource`
 * cannot set headers, so browser clients should use `fetch()` streaming or an
 * EventSource polyfill that supports headers; the token must never be placed in
 * the URL.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const CONNECTION_LIMIT_MESSAGE =
  'Realtime connection limit reached. Retry later.';

export function createClipboardStreamHandler({
  config = getConfig(),
  services,
  now = Date.now,
} = {}) {
  if (!services?.clipboardStore) {
    throw new Error(
      'createClipboardStreamHandler requires services.clipboardStore',
    );
  }
  if (!services?.realtimeHub) {
    throw new Error(
      'createClipboardStreamHandler requires services.realtimeHub',
    );
  }

  const ttlMs = config.clipboard?.ttlMs ?? DEFAULT_TTL_MS;
  const retryMs = config.realtime?.retryMs ?? 3_000;
  const heartbeatIntervalMs =
    config.realtime?.heartbeatIntervalMs ?? 15_000;

  return async function handleClipboardStream(request, url) {
    if (request.method !== 'GET') return errorResponse(405);

    const parsedUrl =
      url ??
      new URL(
        request.url ?? '/',
        `http://${request.headers.host || 'localhost'}`,
      );

    // Defect 21: never accept a credential from the URL. This runs before
    // authentication so a leaked query token is rejected loudly (400).
    const queryTokenDenied = rejectQueryToken(parsedUrl);
    if (queryTokenDenied) return queryTokenDenied;

    const denied = authorize(request, config.apiSecretToken);
    if (denied) return denied;

    if (config.realtime?.enabled === false) {
      return errorResponse(503, 'Realtime push is disabled.');
    }

    const lastEventId = readLastEventId(request, parsedUrl);
    const encoder = new TextEncoder();
    let controller;
    let closed = false;
    let connection = null;
    let streaming = false;
    let lastSentId = null;
    const buffered = [];

    const stream = new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
        connection?.close('client');
        connection = null;
      },
    });

    const write = (text) => {
      if (closed) return false;
      try {
        controller.enqueue(encoder.encode(text));
        return true;
      } catch {
        // A broken/slow consumer must release its hub slot immediately.
        closed = true;
        connection?.close('write_error');
        connection = null;
        return false;
      }
    };

    const emit = (event) => {
      if (event?.id && event.id === lastSentId) return;
      if (event?.id) lastSentId = event.id;
      write(formatSseEvent(event));
    };

    connection = services.realtimeHub.subscribe({
      onEvent: (event) => {
        // Buffer updates that race with the initial snapshot; only the latest
        // one matters because the clipboard exposes latest state only.
        if (!streaming) buffered.push(event);
        else emit(event);
      },
      onHeartbeat: (ts) => write(`: heartbeat ${ts}\n\n`),
      onClose: (reason) => {
        if (closed) return;
        if (reason === 'ttl') {
          write(
            formatSseEvent({
              event: 'reconnect',
              data: { reason: 'connection_ttl' },
            }),
          );
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // The consumer may already have cancelled the stream.
        }
      },
    });

    if (!connection) {
      closed = true;
      try {
        controller.close();
      } catch {
        // Nothing to close when the stream was never consumed.
      }
      return connectionLimitResponse();
    }

    // Read the current snapshot before writing any bytes so a store failure can
    // still be reported as a normal 500 response. Events that arrive during the
    // read are buffered and reconciled below.
    let record;
    try {
      record = await services.clipboardStore.getLatest();
    } catch {
      connection.close('snapshot_error');
      return errorResponse(500);
    }

    write(
      formatSseEvent({
        event: 'ready',
        retry: retryMs,
        data: {
          connected_at: now(),
          heartbeat_interval_ms: heartbeatIntervalMs,
          retry_ms: retryMs,
        },
      }),
    );

    const payload = buildClipboardPayload(record, { ttlMs, nowMs: now() });
    if (payload) {
      const id = formatClipboardEventId(record);
      lastSentId = id;
      if (lastEventId !== id) {
        write(formatSseEvent({ id, event: 'clipboard.updated', data: payload }));
      }
    }

    streaming = true;
    const lastBuffered = buffered.at(-1);
    if (lastBuffered && lastBuffered.id !== lastSentId) emit(lastBuffered);

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  };
}

/** Serializes one SSE frame. `data` is JSON-encoded, so it is always one line. */
export function formatSseEvent({ id, event, data, retry } = {}) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  if (retry !== undefined && retry !== null) lines.push(`retry: ${retry}`);
  lines.push(`event: ${event ?? 'message'}`);
  if (data !== undefined) lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

function readLastEventId(request, url) {
  const header = request.headers['last-event-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const query = url.searchParams.get('last_event_id');
  return query && query.trim() ? query.trim() : null;
}

function connectionLimitResponse() {
  return new Response(
    JSON.stringify({
      code: 503,
      message: CONNECTION_LIMIT_MESSAGE,
      data: null,
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': '5',
      },
    },
  );
}
