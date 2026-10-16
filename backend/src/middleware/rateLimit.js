import { createHash } from 'node:crypto';
import { errorResponse } from './errors.js';
import { InMemoryRateLimitStore } from '../services/rateLimitStore.js';

const tokenKey = (token) => createHash('sha256').update(token || '').digest('hex');

export function rateLimit({ config = {}, store = new InMemoryRateLimitStore(), now = Date.now } = {}) {
  const windowMs = config.rateLimitWindowSeconds * 1000;
  return (handler) => async (request, url) => {
    if (!config.rateLimitEnabled) return handler(request, url);

    const timestamp = now();
    const bucket = Math.floor(timestamp / windowMs);
    const expiresAt = (bucket + 1) * windowMs;
    const forwarded = config.trustProxy ? request.headers['x-forwarded-for'] : '';
    const ip = forwarded ? forwarded.split(',')[0].trim() : request.socket.remoteAddress || 'unknown';
    const token = tokenKey(request.headers['x-dcc-token']);
    const keys = [`token:${token}:${bucket}`, `ip:${ip}:${bucket}`];
    const counts = await Promise.all(keys.map((key) => store.increment(key, expiresAt, timestamp)));
    if (counts.some((count) => count > config.rateLimitPerMinute)) {
      const retryAfter = Math.max(1, Math.ceil((expiresAt - timestamp) / 1000));
      const response = errorResponse(429);
      response.headers.set('retry-after', String(retryAfter));
      return response;
    }
    return handler(request, url);
  };
}
