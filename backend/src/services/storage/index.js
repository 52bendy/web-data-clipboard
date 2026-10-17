import { createMemoryStorage } from './memory-storage.js';

/**
 * Storage adapter contract — a small KV interface that business services rely
 * on, keeping the clipboard layer decoupled from the deployed platform
 * (memory for local development; KV/Redis adapters plug in with the runtime
 * selection in REQ-202610-1251).
 *
 * Adapter interface:
 * - `get(key)` -> Promise<value | null>            — expired entries are absent
 * - `set(key, value, { ttlMs })` -> Promise<void>  — positive ttlMs sets an
 *   expiry, otherwise the entry does not expire
 * - `delete(key)` -> Promise<void>
 * - `update(key, updater, { ttlMs })` -> Promise<value | null>
 *   Atomic read-modify-write: `updater(current)` runs serialized per key and
 *   returns the next value. Returning `undefined` deletes the key; returning
 *   the current value unchanged lets the adapter skip the write.
 * - `purgeExpired()` -> Promise<number>            — sweep expired entries
 *
 * Values must be JSON-serializable. Adapters return defensive copies so
 * callers can never observe or mutate a torn intermediate state.
 */
export function createStorage({ type = 'memory', now = Date.now } = {}) {
  if (type === 'memory') {
    return createMemoryStorage({ now });
  }
  throw new Error(`Unsupported storage type: ${type}`);
}

export { createMemoryStorage };
