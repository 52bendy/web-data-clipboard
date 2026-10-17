import { createHmac, randomUUID } from 'node:crypto';
import https from 'node:https';
import { createLogger } from '../utils/logger.js';
import {
  validateWebhookUrl,
  safeLookup,
  WebhookTargetError,
} from './webhook-target.js';

/**
 * Webhook delivery engine (REQ-202610-1258, PRD §4.1.3 / §7.2.2):
 * formats the downstream message, signs the exact request body with
 * HMAC-SHA256, delivers asynchronously with a per-attempt timeout and
 * exponential-backoff retries, and records every outcome for the admin UI.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const MAX_RESPONSE_EXCERPT = 512;
export const WEBHOOK_EVENT = 'clipboard.updated';

/** §7.2.2 human-readable message template for chat consumers. */
export function formatWebhookMessage(record) {
  const source = record.source ?? {};
  const lines = [
    record.parsed_code ? '📱 收到新验证码' : '📱 收到新消息',
    '-------------------',
  ];
  if (record.parsed_code) lines.push(`验证码：${record.parsed_code}`);
  lines.push(
    `来源设备：${source.device_name || 'unknown'}`,
    '',
    '',
    `原始短信：${record.full_text}`,
  );
  return lines.join('\n');
}

export function buildWebhookPayload(
  record,
  context = {},
  { deliveryId, nowMs = Date.now() } = {},
) {
  return {
    event: WEBHOOK_EVENT,
    delivery_id: deliveryId,
    collection_id: context.collection_id ?? null,
    sender: context.sender || null,
    created_at: new Date(nowMs).toISOString(),
    data: {
      clipboard_id: record.clipboard_id,
      data_type: record.data_type,
      parsed_code: record.parsed_code,
      full_text: record.full_text,
      updated_at: record.updated_at,
      source: record.source,
    },
    message: formatWebhookMessage(record),
  };
}

/**
 * Signature contract documented in `backend/docs/webhooks.md`:
 * `X-DCC-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 */
export function signWebhookPayload(secret, timestamp, body) {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `sha256=${digest}`;
}

/** Default transport: one POST over https, no redirects, hard timeout. */
export function createHttpsSender({ lookup = safeLookup } = {}) {
  return function sendHttps(target, { body, headers, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          protocol: 'https:',
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers,
          timeout: timeoutMs,
          lookup,
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_EXCERPT) chunks.push(chunk);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks)
                .toString('utf8')
                .slice(0, MAX_RESPONSE_EXCERPT),
            });
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('webhook request timed out')),
      );
      request.on('error', reject);
      request.end(body);
    });
  };
}

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createWebhookForwarder({
  config = {},
  webhookStore,
  logger = createLogger(),
  now = Date.now,
  send = createHttpsSender(),
  sleep = defaultSleep,
  validateTarget = validateWebhookUrl,
  randomId = () => randomUUID(),
} = {}) {
  if (!webhookStore) {
    throw new Error('createWebhookForwarder requires a webhook store');
  }
  const settings = config.webhook ?? {};
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseDelayMs =
    settings.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const allowedHosts = settings.allowedHosts ?? [];

  async function deliverOne(
    webhook,
    record,
    context = {},
    { test = false } = {},
  ) {
    const deliveryId = `dlv_${randomId()}`;
    const startedAt = now();
    const payload = buildWebhookPayload(record, context, {
      deliveryId,
      nowMs: startedAt,
    });
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(startedAt / 1000));
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'DCC-Webhook/1.0',
      'x-dcc-event': WEBHOOK_EVENT,
      'x-dcc-delivery-id': deliveryId,
      'x-dcc-timestamp': timestamp,
      'x-dcc-signature': signWebhookPayload(webhook.secret, timestamp, body),
    };

    let attempts = 0;
    let lastStatus = null;
    let lastError = null;
    let lastResponse = null;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        // Re-check the target at delivery time (including the optional
        // allowlist); the https lookup hook checks the actual connection
        // address again (DNS rebinding defence).
        const target = await validateTarget(webhook.url, { allowedHosts });
        const response = await send(target, { body, headers, timeoutMs });
        lastStatus = response.status;
        lastResponse = response.body ?? null;
        if (response.status >= 200 && response.status < 300) {
          const delivery = {
            delivery_id: deliveryId,
            webhook_id: webhook.webhook_id,
            webhook_url: webhook.url,
            event: WEBHOOK_EVENT,
            collection_id: context.collection_id ?? null,
            test,
            status: 'success',
            attempts,
            http_status: response.status,
            error: null,
            response_excerpt: lastResponse,
            started_at: new Date(startedAt).toISOString(),
            finished_at: new Date(now()).toISOString(),
            duration_ms: now() - startedAt,
          };
          await webhookStore.recordDelivery(delivery);
          logger.info('webhook.delivery.succeeded', {
            delivery_id: deliveryId,
            webhook_id: webhook.webhook_id,
            collection_id: context.collection_id,
            attempts,
            http_status: response.status,
            test,
          });
          return delivery;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError =
          error instanceof WebhookTargetError
            ? `${error.code}: ${error.message}`
            : String(error?.message ?? error);
        lastStatus = null;
        lastResponse = null;
      }

      if (attempts < maxAttempts) {
        const delay = retryBaseDelayMs * 2 ** (attempts - 1);
        logger.warn('webhook.delivery.retry', {
          delivery_id: deliveryId,
          webhook_id: webhook.webhook_id,
          collection_id: context.collection_id,
          attempt: attempts,
          delay_ms: delay,
          error: lastError,
        });
        await sleep(delay);
      }
    }

    const delivery = {
      delivery_id: deliveryId,
      webhook_id: webhook.webhook_id,
      webhook_url: webhook.url,
      event: WEBHOOK_EVENT,
      collection_id: context.collection_id ?? null,
      test,
      status: 'failed',
      attempts,
      http_status: lastStatus,
      error: lastError,
      response_excerpt: lastResponse,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(now()).toISOString(),
      duration_ms: now() - startedAt,
    };
    await webhookStore.recordDelivery(delivery);
    logger.error('webhook.delivery.failed', {
      delivery_id: deliveryId,
      webhook_id: webhook.webhook_id,
      collection_id: context.collection_id,
      attempts,
      error: lastError,
      test,
    });
    return delivery;
  }

  async function deliverToAll(record, context = {}) {
    const configs = await webhookStore.list();
    const enabled = configs.filter((item) => item.enabled);
    if (enabled.length === 0) {
      logger.info('webhook.dispatch.skipped', {
        collection_id: context.collection_id,
        reason: 'no_enabled_webhooks',
      });
      return { dispatched: 0, succeeded: 0, failed: 0 };
    }
    const results = await Promise.allSettled(
      enabled.map((webhook) => deliverOne(webhook, record, context)),
    );
    let succeeded = 0;
    let failed = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.status === 'success') {
        succeeded += 1;
      } else {
        failed += 1;
        if (result.status === 'rejected') {
          logger.error('webhook.delivery.crashed', {
            collection_id: context.collection_id,
            webhook_id: enabled[index].webhook_id,
            error: String(result.reason),
          });
        }
      }
    });
    logger.info('webhook.dispatch.completed', {
      collection_id: context.collection_id,
      dispatched: results.length,
      succeeded,
      failed,
    });
    return { dispatched: results.length, succeeded, failed };
  }

  return { deliverOne, deliverToAll };
}
