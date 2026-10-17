import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const CSRF_BYTES = 32;

const digestToken = (token) =>
  createHash('sha256')
    .update(String(token ?? ''))
    .digest('hex');

/**
 * In-memory admin session store. Sessions are addressed by a SHA-256 digest of
 * the opaque cookie value, so a memory dump does not expose usable tokens.
 * Production multi-instance deployments should swap this for a shared store
 * implementing the same create/get/remove contract.
 */
export function createSessionStore({
  ttlMs = 8 * 60 * 60 * 1000,
  maxSessions = 1000,
  now = Date.now,
} = {}) {
  const sessions = new Map();

  function purgeExpired() {
    const timestamp = now();
    for (const [key, entry] of sessions) {
      if (entry.expiresAt <= timestamp) sessions.delete(key);
    }
  }

  function evictOldest() {
    let oldestKey = null;
    let oldestCreatedAt = Infinity;
    for (const [key, entry] of sessions) {
      if (entry.createdAt < oldestCreatedAt) {
        oldestCreatedAt = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) sessions.delete(oldestKey);
  }

  function create(username) {
    purgeExpired();
    while (sessions.size >= maxSessions) evictOldest();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const csrfToken = randomBytes(CSRF_BYTES).toString('base64url');
    const createdAt = now();
    const expiresAt = createdAt + ttlMs;
    sessions.set(digestToken(token), {
      username,
      csrfToken,
      createdAt,
      expiresAt,
    });
    return { token, csrfToken, username, createdAt, expiresAt };
  }

  function get(token) {
    if (!token) return null;
    purgeExpired();
    const key = digestToken(token);
    const entry = sessions.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return { ...entry, token };
  }

  function remove(token) {
    if (token) sessions.delete(digestToken(token));
  }

  return {
    create,
    get,
    remove,
    purgeExpired,
    get size() {
      purgeExpired();
      return sessions.size;
    },
  };
}
