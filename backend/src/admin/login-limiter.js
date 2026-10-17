/**
 * Fixed-window failed-login limiter. Both the client IP and the normalized
 * username are counted so a single source cannot spray one account and a
 * distributed attempt against one account is still bounded. Successful login
 * clears both buckets. State is process-local; a shared store can replace the
 * Map without changing the interface.
 */
export function createLoginLimiter({
  maxAttempts = 5,
  windowMs = 15 * 60 * 1000,
  now = Date.now,
} = {}) {
  const entries = new Map();

  function purgeExpired(timestamp) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= timestamp) entries.delete(key);
    }
  }

  function check(keys) {
    const timestamp = now();
    purgeExpired(timestamp);
    let retryAfterSeconds = 0;
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry || entry.resetAt <= timestamp) continue;
      if (entry.count >= maxAttempts) {
        retryAfterSeconds = Math.max(
          retryAfterSeconds,
          Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000)),
        );
      }
    }
    return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
  }

  function recordFailure(keys) {
    const timestamp = now();
    purgeExpired(timestamp);
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry || entry.resetAt <= timestamp) {
        entries.set(key, { count: 1, resetAt: timestamp + windowMs });
      } else {
        entry.count += 1;
      }
    }
  }

  function reset(keys) {
    for (const key of keys) entries.delete(key);
  }

  return { check, recordFailure, reset };
}
