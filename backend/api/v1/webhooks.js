import { randomUUID } from 'node:crypto';
import { errorResponse } from '../../src/middleware/errors.js';
import { WebhookConfigError } from '../../src/services/webhook-store.js';
import { WebhookTargetError } from '../../src/services/webhook-target.js';
import { createLogger } from '../../src/utils/logger.js';
import { created, ok } from '../../src/utils/respond.js';

const MAX_BODY_BYTES = 64 * 1024;
const DELIVERY_STATUSES = new Set(['success', 'failed']);

/**
 * Webhook management API (REQ-202610-1258):
 *   GET    /api/v1/webhooks
 *   POST   /api/v1/webhooks
 *   GET    /api/v1/webhooks/:id
 *   PATCH  /api/v1/webhooks/:id
 *   DELETE /api/v1/webhooks/:id
 *   POST   /api/v1/webhooks/:id/test
 *   GET    /api/v1/webhooks/deliveries
 *
 * All routes are authenticated by the shared X-DCC-Token middleware today;
 * the admin auth layer (REQ-202610-1260) will sit in front of them.
 */
export function createWebhookHandlers({
  services,
  logger = createLogger(),
  now = Date.now,
} = {}) {
  const store = services.webhookStore;
  const forwarder = services.webhookForwarder;

  async function list() {
    const webhooks = await store.list();
    return ok({ webhooks, total: webhooks.length });
  }

  async function create(request) {
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    try {
      const webhook = await store.create(parsed.value);
      logger.info('webhook.config.created', {
        webhook_id: webhook.webhook_id,
        url: webhook.url,
      });
      return created(webhook, 'Webhook created');
    } catch (error) {
      return mapStoreError(error) ?? errorResponse(500);
    }
  }

  async function get(request, url) {
    const webhook = await store.get(webhookIdFromPath(url.pathname));
    if (!webhook) return errorResponse(404, 'webhook not found.');
    return ok(webhook);
  }

  async function update(request, url) {
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    try {
      const webhook = await store.update(
        webhookIdFromPath(url.pathname),
        parsed.value,
      );
      logger.info('webhook.config.updated', {
        webhook_id: webhook.webhook_id,
        enabled: webhook.enabled,
      });
      return ok(webhook, 'Webhook updated');
    } catch (error) {
      return mapStoreError(error) ?? errorResponse(500);
    }
  }

  async function remove(request, url) {
    try {
      const webhook = await store.remove(webhookIdFromPath(url.pathname));
      logger.info('webhook.config.deleted', {
        webhook_id: webhook.webhook_id,
      });
      return ok({ deleted: true, webhook_id: webhook.webhook_id });
    } catch (error) {
      return mapStoreError(error) ?? errorResponse(500);
    }
  }

  async function test(request, url) {
    const webhook = await store.get(webhookIdFromPath(url.pathname));
    if (!webhook) return errorResponse(404, 'webhook not found.');
    const timestamp = now();
    const record = {
      clipboard_id: `clip_test_${randomUUID()}`,
      data_type: 'verification_code',
      parsed_code: '123456',
      full_text: '【DCC】这是一条 Webhook 测试消息，验证码：123456。',
      updated_at: new Date(timestamp).toISOString(),
      source: { device_name: 'DCC Test', platform: 'android' },
    };
    try {
      const delivery = await forwarder.deliverOne(
        webhook,
        record,
        {
          collection_id: `col_test_${timestamp}`,
          device_id: 'dcc_test',
          sender: '+8610086',
        },
        { test: true },
      );
      return ok(delivery, 'Webhook test delivered');
    } catch (error) {
      logger.error('webhook.test.failed', {
        webhook_id: webhook.webhook_id,
        error: String(error),
      });
      return mapStoreError(error) ?? errorResponse(500);
    }
  }

  async function deliveries(request, url) {
    const status = url.searchParams.get('status') ?? undefined;
    if (status !== undefined && !DELIVERY_STATUSES.has(status)) {
      return errorResponse(400, 'status must be one of: success, failed.');
    }
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? 50 : Number(limitParam);
    if (limitParam !== null && (!Number.isInteger(limit) || limit < 1)) {
      return errorResponse(400, 'limit must be a positive integer.');
    }
    const items = await store.listDeliveries({
      webhookId: url.searchParams.get('webhook_id') ?? undefined,
      status,
      limit,
    });
    return ok({ deliveries: items, total: items.length });
  }

  return { list, create, get, update, remove, test, deliveries };
}

function webhookIdFromPath(pathname) {
  return decodeURIComponent(pathname.split('/')[4] ?? '');
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return { error: errorResponse(413) };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return { error: errorResponse(413) };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    return {
      error: errorResponse(400, 'request body must be valid JSON.'),
    };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      error: errorResponse(400, 'request body must be valid JSON.'),
    };
  }
}

function mapStoreError(error) {
  if (error instanceof WebhookConfigError) {
    if (error.code === 'not_found') {
      return errorResponse(404, 'webhook not found.');
    }
    return errorResponse(400, error.message);
  }
  if (error instanceof WebhookTargetError) {
    return errorResponse(400, error.message);
  }
  return null;
}
