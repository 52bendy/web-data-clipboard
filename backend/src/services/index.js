import { createStorage } from './storage/index.js';
import { createClipboardStore } from './clipboard-store.js';
import { buildClipboardPayload } from './clipboard-payload.js';
import { createCollectionLogStore } from './collection-log-store.js';
import {
  createRealtimeHub,
  formatClipboardEventId,
} from './realtime-hub.js';
import { createDeviceRegistry } from './device-registry.js';
import { createSettingsStore } from './settings-store.js';
import { createDispatcher } from './webhook-dispatcher.js';
import { createWebhookStore } from './webhook-store.js';
import { createWebhookForwarder } from './webhook-forwarder.js';

/**
 * Builds the backend service graph from configuration. HTTP routes consume
 * these services as they land (collect / clipboard / devices / webhooks /
 * logs).
 *
 * The webhook forwarder registers itself as the dispatcher sink, so every
 * accepted collection fans out to the enabled Webhook configs without the
 * collect chain waiting for delivery (REQ-202610-1258).
 */
export function createServices({ config = {}, now = Date.now, logger } = {}) {
  const storage = createStorage({
    type: config.storage?.driver ?? 'memory',
    now,
  });
  const realtimeConfig = config.realtime ?? {};
  const realtimeHub = createRealtimeHub({
    maxConnections: realtimeConfig.maxConnections,
    heartbeatIntervalMs: realtimeConfig.heartbeatIntervalMs,
    connectionTtlMs: realtimeConfig.connectionTtlMs,
    now,
    logger,
  });
  const clipboardConfig = config.clipboard ?? {};
  const clipboardStore = createClipboardStore({
    storage,
    ttlMs: clipboardConfig.ttlMs,
    historyMaxEntries: clipboardConfig.historyMaxEntries,
    historyMaxAgeMs: clipboardConfig.historyMaxAgeMs,
    now,
    logger,
    // Every accepted clipboard write becomes a `clipboard.updated` event with
    // the same §4.1.2 fields as the read API (REQ-202610-1274).
    onWrite: (record) => {
      const data = buildClipboardPayload(record, {
        ttlMs: clipboardConfig.ttlMs,
        nowMs: now(),
      });
      if (!data) return;
      realtimeHub.publish({
        id: formatClipboardEventId(record),
        event: 'clipboard.updated',
        data,
      });
    },
  });
  const deviceRegistry = createDeviceRegistry({ storage, now });
  const logConfig = config.logs ?? {};
  const collectionLogStore = createCollectionLogStore({
    storage,
    maxEntries: logConfig.maxEntries,
    maxAgeMs: logConfig.maxAgeMs,
    now,
  });
  const settingsStore = createSettingsStore({ storage, config, now });
  const webhookConfig = config.webhook ?? {};
  const webhookStore = createWebhookStore({
    storage,
    now,
    maxConfigs: webhookConfig.maxConfigs,
    maxDeliveries: webhookConfig.maxDeliveries,
    resolveHost: webhookConfig.resolveHost,
  });
  const dispatcher = createDispatcher({ logger });
  const webhookForwarder = createWebhookForwarder({
    config,
    webhookStore,
    logger,
    now,
    send: webhookConfig.send,
    sleep: webhookConfig.sleep,
    validateTarget: webhookConfig.validateTarget,
  });
  dispatcher.register((record, context) =>
    webhookForwarder.deliverToAll(record, context),
  );
  return {
    storage,
    clipboardStore,
    realtimeHub,
    deviceRegistry,
    collectionLogStore,
    settingsStore,
    webhookStore,
    dispatcher,
    webhookForwarder,
  };
}
