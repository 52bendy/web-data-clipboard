import { getConfig } from '../../src/config.js';
import { authorize } from '../../src/middleware/auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import {
  CollectionLogError,
  MAX_PAGE_SIZE,
} from '../../src/services/collection-log-store.js';
import { maskLogEntry } from '../../src/utils/mask.js';
import { ok } from '../../src/utils/respond.js';

const MAX_DEVICE_LENGTH = 128;
const MAX_KEYWORD_LENGTH = 200;

function parsePositiveInt(raw, name, { fallback, max }) {
  if (raw === null || raw === '') return { value: fallback };
  if (!/^\d+$/.test(raw)) {
    return { error: `${name} must be a positive integer.` };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return { error: `${name} must be between 1 and ${max}.` };
  }
  return { value };
}

function parseBooleanFlag(raw, name) {
  if (raw === null || raw === '') return { value: undefined };
  if (raw === '1' || raw === 'true') return { value: true };
  if (raw === '0' || raw === 'false') return { value: false };
  return { error: `${name} must be one of: 1, 0, true, false.` };
}

function parseDate(raw, name) {
  if (raw === null || raw === '') return { value: undefined };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: `${name} must be a YYYY-MM-DD date.` };
  }
  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return { error: `${name} is not a real date.` };
  }
  return { value: raw };
}

/**
 * GET /api/v1/logs (REQ-202610-1259, PRD §4.2 log board).
 *
 * Query: page, page_size, device, date (or from/to), keyword, mask. Requires the
 * same X-DCC-Token as the collect API because log entries contain raw SMS
 * content and sender numbers. Sender masking follows config.maskSender
 * (MASK_SENDER env, on by default) and can be verified by flipping the flag.
 */
export function createLogsHandler({
  config = getConfig(),
  services,
  logger = null,
  requireToken = true,
} = {}) {
  return async function handleLogs(request) {
    if (request.method !== 'GET') {
      return errorResponse(405);
    }
    if (requireToken) {
      const denied = authorize(request, config.apiSecretToken);
      if (denied) return denied;
    }

    const url = new URL(request.url, 'http://localhost');
    const params = url.searchParams;

    const page = parsePositiveInt(params.get('page'), 'page', {
      fallback: 1,
      max: 1_000_000,
    });
    if (page.error) return errorResponse(400, page.error);
    const pageSize = parsePositiveInt(params.get('page_size'), 'page_size', {
      fallback: 20,
      max: MAX_PAGE_SIZE,
    });
    if (pageSize.error) return errorResponse(400, pageSize.error);

    const device = params.get('device') ?? '';
    const deviceId = params.get('device_id') ?? '';
    const deviceName = params.get('device_name') ?? '';
    if (device.length > MAX_DEVICE_LENGTH) {
      return errorResponse(
        400,
        `device must be at most ${MAX_DEVICE_LENGTH} characters.`,
      );
    }
    if (deviceId.length > MAX_DEVICE_LENGTH) {
      return errorResponse(
        400,
        `device_id must be at most ${MAX_DEVICE_LENGTH} characters.`,
      );
    }
    if (deviceName.length > MAX_DEVICE_LENGTH) {
      return errorResponse(
        400,
        `device_name must be at most ${MAX_DEVICE_LENGTH} characters.`,
      );
    }
    const keyword = params.get('keyword') ?? '';
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return errorResponse(
        400,
        `keyword must be at most ${MAX_KEYWORD_LENGTH} characters.`,
      );
    }

    const date = parseDate(params.get('date'), 'date');
    if (date.error) return errorResponse(400, date.error);
    const from = parseDate(params.get('from'), 'from');
    if (from.error) return errorResponse(400, from.error);
    const to = parseDate(params.get('to'), 'to');
    if (to.error) return errorResponse(400, to.error);
    const mask = parseBooleanFlag(params.get('mask'), 'mask');
    if (mask.error) return errorResponse(400, mask.error);

    try {
      const result = await services.collectionLogStore.query({
        page: page.value,
        pageSize: pageSize.value,
        device,
        deviceId,
        deviceName,
        date: date.value,
        from: from.value,
        to: to.value,
        keyword,
      });
      const masked = mask.value ?? config.maskSender !== false;
      return ok(
        {
          ...result,
          items: result.items.map((entry) => maskLogEntry(entry, masked)),
          masked,
        },
        'Logs retrieved',
      );
    } catch (error) {
      if (error instanceof CollectionLogError) {
        return errorResponse(400, error.message);
      }
      logger?.error('logs.query_failed', { error: String(error) });
      return errorResponse(500);
    }
  };
}
