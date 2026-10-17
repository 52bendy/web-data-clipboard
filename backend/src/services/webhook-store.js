import { randomBytes, randomUUID } from 'node:crypto';
import { validateWebhookUrl } from './webhook-target.js';

/**
 * Webhook configuration and delivery-log store (REQ-202610-1258), built on
 * the platform-decoupled KV storage adapter from REQ-202610-1255.
 *
 * Configs are kept in one array key so updates serialize through the
 * adapter's atomic `update`; the delivery log is a bounded, newest-first
 * record of every forward attempt for the admin/observability layer.
 */
const CONFIGS_KEY = 'webhooks:configs';
const DELIVERIES_KEY = 'webhooks:deliveries';
const MAX_NAME_LENGTH = 100;
const SECRET_PREFIX = 'whsec_';

export class WebhookConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebhookConfigError';
    this.code = code;
  }
}

function generateSecret() {
  return `${SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
}

function normalizeName(name, fallback) {
  if (name === undefined || name === null || name === '') return fallback;
  if (typeof name !== 'string') {
    throw new WebhookConfigError('invalid_name', 'name must be a string.');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new WebhookConfigError(
      'invalid_name',
      `name must be 1-${MAX_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function normalizeEnabled(enabled) {
  if (enabled === undefined) return true;
  if (typeof enabled !== 'boolean') {
    throw new WebhookConfigError(
      'invalid_enabled',
      'enabled must be a boolean.',
    );
  }
  return enabled;
}

export function createWebhookStore({
  storage,
  now = Date.now,
  resolveHost,
  allowedHosts = [],
  maxConfigs = 20,
  maxDeliveries = 200,
} = {}) {
  if (!storage) {
    throw new Error('createWebhookStore requires a storage adapter');
  }

  async function readConfigs() {
    const value = await storage.get(CONFIGS_KEY);
    return Array.isArray(value) ? value : [];
  }

  async function create(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new WebhookConfigError(
        'invalid_body',
        'request body must be a JSON object.',
      );
    }
    const url = await validateWebhookUrl(input.url, {
      resolveHost,
      allowedHosts,
    });
    const name = normalizeName(input.name, url.hostname);
    const enabled = normalizeEnabled(input.enabled);
    const timestamp = new Date(now()).toISOString();
    let created = null;
    await storage.update(CONFIGS_KEY, (current) => {
      const configs = Array.isArray(current) ? current : [];
      if (configs.length >= maxConfigs) {
        throw new WebhookConfigError(
          'too_many_webhooks',
          `at most ${maxConfigs} webhook configurations are allowed.`,
        );
      }
      created = {
        webhook_id: `wh_${randomUUID()}`,
        name,
        url: url.toString(),
        enabled,
        secret: generateSecret(),
        created_at: timestamp,
        updated_at: timestamp,
      };
      return [...configs, created];
    });
    return created;
  }

  async function list() {
    return readConfigs();
  }

  async function get(webhookId) {
    const configs = await readConfigs();
    return configs.find((item) => item.webhook_id === webhookId) ?? null;
  }

  async function update(webhookId, patch = {}) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new WebhookConfigError(
        'invalid_body',
        'request body must be a JSON object.',
      );
    }
    let nextUrl = null;
    if (patch.url !== undefined) {
      nextUrl = await validateWebhookUrl(patch.url, {
        resolveHost,
        allowedHosts,
      });
    }
    let updated = null;
    await storage.update(CONFIGS_KEY, (current) => {
      const configs = Array.isArray(current) ? current : [];
      const index = configs.findIndex((item) => item.webhook_id === webhookId);
      if (index === -1) return current;
      const existing = configs[index];
      updated = {
        ...existing,
        ...(nextUrl ? { url: nextUrl.toString() } : {}),
        ...(patch.name !== undefined
          ? { name: normalizeName(patch.name, existing.name) }
          : {}),
        ...(patch.enabled !== undefined
          ? { enabled: normalizeEnabled(patch.enabled) }
          : {}),
        ...(patch.rotate_secret === true ? { secret: generateSecret() } : {}),
        updated_at: new Date(now()).toISOString(),
      };
      const next = [...configs];
      next[index] = updated;
      return next;
    });
    if (!updated) {
      throw new WebhookConfigError('not_found', 'webhook not found.');
    }
    return updated;
  }

  async function remove(webhookId) {
    let removed = null;
    await storage.update(CONFIGS_KEY, (current) => {
      const configs = Array.isArray(current) ? current : [];
      const index = configs.findIndex((item) => item.webhook_id === webhookId);
      if (index === -1) return current;
      removed = configs[index];
      return configs.filter((item) => item.webhook_id !== webhookId);
    });
    if (!removed) {
      throw new WebhookConfigError('not_found', 'webhook not found.');
    }
    return removed;
  }

  async function recordDelivery(delivery) {
    await storage.update(DELIVERIES_KEY, (current) => {
      const deliveries = Array.isArray(current) ? current : [];
      return [...deliveries, delivery].slice(-maxDeliveries);
    });
  }

  async function listDeliveries({ webhookId, status, limit = 50 } = {}) {
    let deliveries = (await storage.get(DELIVERIES_KEY)) ?? [];
    if (!Array.isArray(deliveries)) deliveries = [];
    if (webhookId) {
      deliveries = deliveries.filter((item) => item.webhook_id === webhookId);
    }
    if (status) {
      deliveries = deliveries.filter((item) => item.status === status);
    }
    const safeLimit =
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return deliveries.slice(-safeLimit).reverse();
  }

  return {
    create,
    list,
    get,
    update,
    remove,
    recordDelivery,
    listDeliveries,
  };
}
