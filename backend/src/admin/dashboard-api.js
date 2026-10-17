import {
  buildClipboardPayload,
  getClipboardTiming,
} from '../../api/v1/clipboard-latest.js';
import { DEFAULT_TTL_MS } from '../services/clipboard-store.js';
import { jsonResponse } from './responses.js';

/**
 * GET /api/admin/dashboard (REQ-202610-1261, PRD §4.2).
 *
 * Session-protected aggregate consumed by the admin dashboard page. It reads
 * the same service instances as the public APIs, so the stat cards and the
 * clipboard card always agree with `GET /api/v1/stats` and
 * `GET /api/v1/clipboard/latest` (acceptance: card data matches the APIs).
 *
 * `clipboard_state` distinguishes the two friendly empty states that the
 * public read API intentionally collapses into one 404 (defect 24):
 * - `empty`   — no clipboard has ever been written in the retained history;
 * - `expired` — a previous record existed but its TTL elapsed. No content is
 *   returned in this state, only the expiry timestamp.
 */
export function createDashboardApi({
  config = {},
  services,
  now = Date.now,
} = {}) {
  if (!services?.collectionLogStore || !services?.clipboardStore) {
    throw new Error(
      'createDashboardApi requires services.collectionLogStore and services.clipboardStore',
    );
  }
  const ttlMs = config.clipboard?.ttlMs ?? DEFAULT_TTL_MS;

  return async function handleDashboardApi() {
    const [stats, record, history] = await Promise.all([
      services.collectionLogStore.getStats(),
      services.clipboardStore.getLatest(),
      services.clipboardStore.getHistory({ limit: 1 }),
    ]);

    const nowMs = now();
    const clipboard = buildClipboardPayload(record, { ttlMs, nowMs });
    let clipboardState = 'empty';
    let expiredAt = null;

    if (clipboard) {
      clipboardState = 'active';
    } else {
      const last = Array.isArray(history) ? history.at(-1) : null;
      const timing = getClipboardTiming(record ?? last, { ttlMs, nowMs });
      if (timing && timing.remainingMs <= 0) {
        clipboardState = 'expired';
        expiredAt = timing.updatedAtMs + ttlMs;
      }
    }

    return jsonResponse(200, {
      code: 200,
      message: 'Dashboard data retrieved',
      data: {
        stats,
        clipboard,
        clipboard_state: clipboardState,
        clipboard_expired_at: expiredAt,
        refreshed_at: nowMs,
      },
    });
  };
}
