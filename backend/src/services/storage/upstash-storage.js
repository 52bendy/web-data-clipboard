import { randomUUID } from 'node:crypto';

const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createUpstashStorage({
  url,
  token,
  keyPrefix = 'dcc:',
  fetchImpl = fetch,
  now = Date.now,
  lockTtlMs = 5000,
  lockRetryMs = 25,
  lockMaxAttempts = 200,
  timeoutMs = 5000,
} = {}) {
  if (!url) throw new Error('Upstash storage requires a REST URL');
  if (!token) throw new Error('Upstash storage requires a REST token');

  async function command(args, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${label}: Upstash HTTP ${response.status}: ${text}`);
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`${label}: invalid Upstash JSON response`, { cause: error });
      }
      if (payload?.error) {
        throw new Error(`${label}: Upstash error: ${payload.error}`);
      }
      if (!payload || !Object.hasOwn(payload, 'result')) {
        throw new Error(`${label}: Upstash response missing result`);
      }
      return payload.result;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${label}: Upstash request timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function keyFor(key) {
    return `${keyPrefix}${key}`;
  }

  async function get(key) {
    const result = await command(['GET', keyFor(key)], 'GET');
    if (result === null) return null;
    try {
      return clone(JSON.parse(result));
    } catch (error) {
      throw new Error(`GET: invalid JSON value for key ${key}`, { cause: error });
    }
  }

  async function set(key, value, { ttlMs } = {}) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError('Upstash storage values must be JSON-serializable');
    }
    const redisKey = keyFor(key);
    if (typeof ttlMs === 'number' && ttlMs > 0) {
      await command(['SET', redisKey, encoded, 'PX', String(ttlMs)], 'SET');
    } else {
      await command(['SET', redisKey, encoded], 'SET');
    }
  }

  async function deleteKey(key) {
    await command(['DEL', keyFor(key)], 'DEL');
  }

  async function update(key, updater, { ttlMs } = {}) {
    const redisKey = keyFor(key);
    const lockKey = keyFor(`__lock__:${key}`);
    const tokenValue = randomUUID();
    const lockStartedAt = now();
    let acquired = false;
    for (let attempt = 0; attempt < lockMaxAttempts; attempt += 1) {
      const result = await command(
        ['SET', lockKey, tokenValue, 'NX', 'PX', String(lockTtlMs)],
        'LOCK',
      );
      if (result === 'OK') {
        acquired = true;
        break;
      }
      if (attempt + 1 < lockMaxAttempts) await sleep(lockRetryMs);
    }
    if (!acquired) {
      throw new Error(
        `Upstash lock acquisition failed for key ${key} after ${lockMaxAttempts} attempts over ${now() - lockStartedAt}ms`,
      );
    }

    try {
      const current = await get(key);
      const next = await updater(current);
      if (next === undefined) {
        await command(['DEL', redisKey], 'UPDATE DEL');
        return null;
      }
      if (next === current) return clone(current);
      await set(key, next, { ttlMs });
      return clone(next);
    } finally {
      await command(
        ['EVAL', RELEASE_LOCK_SCRIPT, '1', lockKey, tokenValue],
        'UNLOCK',
      );
    }
  }

  return {
    get,
    set,
    delete: deleteKey,
    update,
    // Redis expires keys natively; there is no adapter-side expiry sweep.
    async purgeExpired() {
      return 0;
    },
  };
}
