import { createStorage } from './storage/index.js';
import { createClipboardStore } from './clipboard-store.js';
import { createCollectionLogStore } from './collection-log-store.js';
import { createDeviceRegistry } from './device-registry.js';

/**
 * Builds the backend service graph from configuration. HTTP routes consume
 * these services as they land (collect / clipboard / devices / webhooks /
 * logs).
 */
export function createServices({ config = {}, now = Date.now } = {}) {
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
  const deviceRegistry = createDeviceRegistry({ storage, now });
  const logConfig = config.logs ?? {};
  const collectionLogStore = createCollectionLogStore({
    storage,
    maxEntries: logConfig.maxEntries,
    maxAgeMs: logConfig.maxAgeMs,
    now,
  });
  return { storage, clipboardStore, deviceRegistry, collectionLogStore };
}
