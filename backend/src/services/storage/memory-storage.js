/**
 * In-memory storage adapter implementing the contract documented in ./index.js.
 *
 * Expiry is evaluated against an injectable clock so TTL behaviour is fully
 * deterministic in tests. `update` serializes read-modify-write cycles per key
 * through a promise chain, so concurrent updates never interleave.
 */
export function createMemoryStorage({ now = Date.now } = {}) {
  /** @type {Map<string, { value: unknown, expiresAt: number | null }>} */
  const entries = new Map();
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();

  function read(key) {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    return structuredClone(entry.value);
  }

  function write(key, value, ttlMs) {
    const expiresAt =
      typeof ttlMs === 'number' && ttlMs > 0 ? now() + ttlMs : null;
    entries.set(key, { value: structuredClone(value), expiresAt });
  }

  function chain(key, task) {
    const tail = chains.get(key) ?? Promise.resolve();
    const run = tail.then(task, task);
    const settled = run.then(
      () => {},
      () => {},
    );
    chains.set(key, settled);
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return run;
  }

  return {
    async get(key) {
      return read(key);
    },

    async set(key, value, { ttlMs } = {}) {
      write(key, value, ttlMs);
    },

    async delete(key) {
      entries.delete(key);
    },

    /**
     * Atomic read-modify-write. The updater runs serialized per key; it
     * receives the current value (or null) and returns the next value.
     * Returning `undefined` deletes the key, and returning the current value
     * unchanged skips the write.
     */
    update(key, updater, { ttlMs } = {}) {
      return chain(key, async () => {
        const current = read(key);
        const next = await updater(current);
        if (next === undefined) {
          entries.delete(key);
          return null;
        }
        if (next === current) return structuredClone(current);
        write(key, next, ttlMs);
        return structuredClone(next);
      });
    },

    /** Removes every expired entry and returns how many were purged. */
    async purgeExpired() {
      let purged = 0;
      for (const [key, entry] of entries) {
        if (entry.expiresAt !== null && entry.expiresAt <= now()) {
          entries.delete(key);
          purged += 1;
        }
      }
      return purged;
    },
  };
}
