import { getConfig } from '../../src/config.js';
import { authorize } from '../../src/middleware/auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import { ok } from '../../src/utils/respond.js';

/**
 * GET /api/v1/stats (REQ-202610-1259, PRD §4.2 dashboard cards).
 *
 * Returns today's collected count, today's successful extraction count and
 * the number of distinct devices in the retained collection log. Counters are
 * derived from the same log store the admin log board reads, so the two views
 * cannot drift apart.
 */
export function createStatsHandler({
  config = getConfig(),
  services,
  logger = null,
  requireToken = true,
} = {}) {
  return async function handleStats(request) {
    if (request.method !== 'GET') {
      return errorResponse(405);
    }
    if (requireToken) {
      const denied = authorize(request, config.apiSecretToken);
      if (denied) return denied;
    }

    try {
      const stats = await services.collectionLogStore.getStats();
      return ok(stats, 'Statistics retrieved');
    } catch (error) {
      logger?.error('stats.query_failed', { error: String(error) });
      return errorResponse(500);
    }
  };
}
