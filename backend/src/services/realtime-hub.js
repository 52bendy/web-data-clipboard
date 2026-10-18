import { randomUUID } from 'node:crypto';

/**
 * In-process realtime fan-out for the clipboard SSE feed (REQ-202610-1274).
 *
 * The hub is transport-agnostic: subscribers receive `{ id, event, data }`
 * objects, heartbeat ticks and a close callback. The SSE handler owns the wire
 * format, so a future WebSocket adapter can reuse the same hub and event
 * contract. A shared pub/sub driver (e.g. Upstash Redis) can replace `publish`
 * when the backend runs on more than one instance.
 *
 * Connection management is deliberately small and bounded:
 * - `maxConnections` caps concurrent subscriptions (free-tier friendly);
 * - one shared heartbeat timer serves every connection;
 * - an optional per-connection TTL forces a clean reconnect before a
 *   serverless platform terminates the function;
 * - slow/broken writers are closed instead of accumulating an unbounded queue.
 */

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_CONNECTIONS = 100;
export const DEFAULT_RETRY_MS = 3_000;

/** Stable SSE event id derived from the §4.1.2 clipboard identity. */
export function formatClipboardEventId(record) {
  if (!record) return null;
  const updatedAtMs =
    typeof record.updated_at === 'number'
      ? record.updated_at
      : Date.parse(record.updated_at);
  if (!Number.isFinite(updatedAtMs) || !record.clipboard_id) return null;
  return `${updatedAtMs}-${record.clipboard_id}`;
}

export function createRealtimeHub({
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  connectionTtlMs = 0,
  now = Date.now,
  logger = null,
} = {}) {
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error('maxConnections must be a positive integer.');
  }
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new Error('heartbeatIntervalMs must be a positive integer.');
  }
  if (!Number.isInteger(connectionTtlMs) || connectionTtlMs < 0) {
    throw new Error('connectionTtlMs must be a non-negative integer.');
  }

  /** @type {Map<string, { id: string, onEvent: Function, onHeartbeat: Function, onClose: Function, ttlTimer: NodeJS.Timeout | null }>} */
  const clients = new Map();
  let heartbeatTimer = null;
  let accepted = 0;
  let rejected = 0;
  let closed = 0;
  let published = 0;

  function startHeartbeat() {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      const ts = now();
      for (const client of [...clients.values()]) {
        try {
          client.onHeartbeat?.(ts);
        } catch (error) {
          logger?.warn('realtime.heartbeat_failed', {
            connection_id: client.id,
            error: String(error),
          });
          closeClient(client, 'heartbeat_error');
        }
      }
    }, heartbeatIntervalMs);
    // The hub must never keep a CLI process alive on its own.
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer === null) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function closeClient(client, reason = 'server') {
    if (!clients.delete(client.id)) return;
    if (client.ttlTimer !== null) clearTimeout(client.ttlTimer);
    if (clients.size === 0) stopHeartbeat();
    closed += 1;
    try {
      client.onClose?.(reason);
    } catch (error) {
      logger?.warn('realtime.close_handler_failed', {
        connection_id: client.id,
        error: String(error),
      });
    }
  }

  function subscribe({ onEvent, onHeartbeat, onClose } = {}) {
    if (clients.size >= maxConnections) {
      rejected += 1;
      logger?.warn('realtime.connection_rejected', {
        active: clients.size,
        max_connections: maxConnections,
      });
      return null;
    }

    const client = {
      id: `sse_${randomUUID()}`,
      onEvent,
      onHeartbeat,
      onClose,
      ttlTimer: null,
    };
    clients.set(client.id, client);
    accepted += 1;
    startHeartbeat();

    if (connectionTtlMs > 0) {
      client.ttlTimer = setTimeout(
        () => closeClient(client, 'ttl'),
        connectionTtlMs,
      );
      client.ttlTimer.unref?.();
    }

    logger?.info('realtime.connected', {
      connection_id: client.id,
      active: clients.size,
    });

    return {
      id: client.id,
      get active() {
        return clients.has(client.id);
      },
      close(reason = 'client') {
        closeClient(client, reason);
      },
    };
  }

  function publish(event) {
    published += 1;
    let delivered = 0;
    for (const client of [...clients.values()]) {
      try {
        client.onEvent?.(event);
        delivered += 1;
      } catch (error) {
        logger?.warn('realtime.publish_failed', {
          connection_id: client.id,
          error: String(error),
        });
        closeClient(client, 'write_error');
      }
    }
    return delivered;
  }

  function stats() {
    return {
      active: clients.size,
      max_connections: maxConnections,
      heartbeat_interval_ms: heartbeatIntervalMs,
      connection_ttl_ms: connectionTtlMs,
      accepted,
      rejected,
      closed,
      published,
    };
  }

  return {
    subscribe,
    publish,
    stats,
    closeAll(reason = 'shutdown') {
      for (const client of [...clients.values()]) closeClient(client, reason);
    },
  };
}
