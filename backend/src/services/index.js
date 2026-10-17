import { createStorage } from './storage/index.js';
import { createClipboardStore } from './clipboard-store.js';
import { createDispatcher } from './webhook-dispatcher.js';
import { createWebhookStore } from './webhook-store.js';
import { createWebhookForwarder } from './webhook-forwarder.js';

/**
 * Builds the backend service graph from configuration. HTTP routes consume
 * these services as they land (collect / clipboard / devices / webhooks).
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
  const clipboardConfig = config.clipboard ?? {};
  const clipboardStore = createClipboardStore({
    storage,
    ttlMs: clipboardConfig.ttlMs,
    historyMaxEntries: clipboardConfig.historyMaxEntries,
    historyMaxAgeMs: clipboardConfig.historyMaxAgeMs,
    now,
  });
  const webhookConfig = config.webhook ?? {};
  const webhookStore = createWebhookStore({
    storage,
    now,
    allowedHosts: webhookConfig.allowedHosts,
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
    webhookStore,
    dispatcher,
    webhookForwarder,
  };
}
