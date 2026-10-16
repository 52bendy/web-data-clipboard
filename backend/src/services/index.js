import { createStorage } from './storage/index.js';
import { createClipboardStore } from './clipboard-store.js';

/**
 * Builds the backend service graph from configuration. HTTP routes consume
 * these services as they land (collect / clipboard / devices / webhooks).
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
  return { storage, clipboardStore };
}
