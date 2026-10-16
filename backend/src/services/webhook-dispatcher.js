import { createLogger } from '../utils/logger.js';

/**
 * Async fan-out point for accepted collections (PRD §4.1.1 step 4).
 * REQ-202610-1258 plugs the Webhook forwarder in as a sink (https-only
 * targets, HMAC signing, retries, failure records); this module only
 * guarantees the collect chain never blocks on downstream delivery.
 *
 * `register(sink)` returns an unregister function. A sink receives
 * `(record, context)` where `record` is the §7.1 clipboard record.
 */
export function createDispatcher({ logger = createLogger() } = {}) {
  const sinks = new Set();
  return {
    register(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    async dispatch(record, context = {}) {
      if (sinks.size === 0) {
        logger.info('dispatch.skipped', {
          collection_id: context.collection_id,
          reason: 'no_sinks_registered',
        });
        return { dispatched: 0 };
      }
      const results = await Promise.allSettled(
        [...sinks].map((sink) => sink(record, context)),
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error('dispatch.sink_failed', {
            collection_id: context.collection_id,
            sink: index,
            error: String(result.reason),
          });
        }
      });
      return { dispatched: results.length };
    },
  };
}

/** Shared instance so webhook configuration and the collect route see the same sinks. */
export const dispatcher = createDispatcher();
