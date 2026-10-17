export class RateLimitStore {
  async increment() {
    throw new Error('RateLimitStore.increment must be implemented.');
  }
}

export class InMemoryRateLimitStore extends RateLimitStore {
  #counters = new Map();

  async increment(key, expiresAt, now) {
    for (const [entryKey, entry] of this.#counters) {
      if (entry.expiresAt <= now) this.#counters.delete(entryKey);
    }
    const entry = this.#counters.get(key) || { count: 0, expiresAt };
    entry.count += 1;
    this.#counters.set(key, entry);
    return entry.count;
  }
}
