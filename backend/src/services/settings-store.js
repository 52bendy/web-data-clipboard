import { randomBytes } from 'node:crypto';

/**
 * Admin settings store (REQ-202610-1262, PRD §4.2 / §8.2).
 *
 * Persists the three toggles exposed by the settings panel plus the server
 * API token that the panel can rotate. Settings are stored through the same
 * KV adapter as the rest of the business state, so a future Redis/KV driver
 * keeps working without touching this module.
 *
 * The store keeps a small in-memory mirror because authentication and the
 * collect/log pipelines read these values synchronously on every request.
 * `hydrate()` loads the persisted snapshot once at startup; `update()` and
 * `rotateToken()` persist before returning so a successful response always
 * means the value is durable for the configured storage driver.
 */
const SETTINGS_KEY = 'admin:settings';
const MAX_WEBHOOK_URL_LENGTH = 2048;

export class SettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function normalizeWebhookUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new SettingsError(
      'invalid_webhook_url',
      'webhook_url must be a string.',
    );
  }
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new SettingsError(
      'invalid_webhook_url',
      `webhook_url must be at most ${MAX_WEBHOOK_URL_LENGTH} characters.`,
    );
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SettingsError(
      'invalid_webhook_url',
      'webhook_url must be a valid URL.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new SettingsError(
      'invalid_webhook_url',
      'webhook_url must use https.',
    );
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new SettingsError(
      'invalid_webhook_url',
      'webhook_url must not point to a private or loopback host.',
    );
  }
  return parsed.toString();
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '********';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

function normalizeBoolean(patch, key, code) {
  if (patch[key] === undefined) return undefined;
  if (typeof patch[key] !== 'boolean') {
    throw new SettingsError(code, `${key} must be a boolean.`);
  }
  return patch[key];
}

/**
 * @param {object} options
 * @param {object} options.storage KV storage adapter (REQ-202610-1255).
 * @param {object} [options.config] Mutable config object read by request handlers.
 * @param {() => number} [options.now] Injectable clock.
 * @param {() => string} [options.tokenFactory] Injectable token factory.
 */
export function createSettingsStore({
  storage,
  config = {},
  now = Date.now,
  tokenFactory = () => `dcc_${randomBytes(24).toString('hex')}`,
} = {}) {
  if (!storage || typeof storage.get !== 'function') {
    throw new Error('createSettingsStore requires a storage adapter');
  }

  const state = {
    autoExtract: config.autoExtract !== false,
    maskSender: config.maskSender !== false,
    webhookUrl: '',
    apiSecretToken: config.apiSecretToken || '',
    updatedAt: null,
  };

  function applyToConfig() {
    config.autoExtract = state.autoExtract;
    config.maskSender = state.maskSender;
    config.apiSecretToken = state.apiSecretToken;
  }

  applyToConfig();

  async function hydrate() {
    const saved = await storage.get(SETTINGS_KEY);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved))
      return view();
    if (typeof saved.auto_extract === 'boolean')
      state.autoExtract = saved.auto_extract;
    if (typeof saved.mask_sender === 'boolean')
      state.maskSender = saved.mask_sender;
    if (typeof saved.webhook_url === 'string') {
      try {
        state.webhookUrl = normalizeWebhookUrl(saved.webhook_url);
      } catch {
        state.webhookUrl = '';
      }
    }
    if (typeof saved.api_secret_token === 'string' && saved.api_secret_token) {
      state.apiSecretToken = saved.api_secret_token;
    }
    state.updatedAt =
      typeof saved.updated_at === 'string' ? saved.updated_at : null;
    applyToConfig();
    return view();
  }

  async function persist() {
    await storage.set(SETTINGS_KEY, {
      auto_extract: state.autoExtract,
      mask_sender: state.maskSender,
      webhook_url: state.webhookUrl,
      api_secret_token: state.apiSecretToken,
      updated_at: state.updatedAt,
    });
  }

  function view() {
    return {
      auto_extract: state.autoExtract,
      mask_sender: state.maskSender,
      webhook_url: state.webhookUrl,
      token_masked: maskToken(state.apiSecretToken),
      token_configured: Boolean(state.apiSecretToken),
      updated_at: state.updatedAt,
    };
  }

  async function update(patch = {}) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new SettingsError(
        'invalid_body',
        'request body must be a JSON object.',
      );
    }
    const autoExtract = normalizeBoolean(
      patch,
      'auto_extract',
      'invalid_auto_extract',
    );
    const maskSender = normalizeBoolean(
      patch,
      'mask_sender',
      'invalid_mask_sender',
    );
    const webhookUrl =
      patch.webhook_url === undefined
        ? undefined
        : normalizeWebhookUrl(patch.webhook_url);

    if (autoExtract !== undefined) state.autoExtract = autoExtract;
    if (maskSender !== undefined) state.maskSender = maskSender;
    if (webhookUrl !== undefined) state.webhookUrl = webhookUrl;
    state.updatedAt = new Date(now()).toISOString();
    applyToConfig();
    await persist();
    return view();
  }

  async function rotateToken() {
    const token = tokenFactory();
    if (typeof token !== 'string' || token.length < 16) {
      throw new Error(
        'tokenFactory must return a string of at least 16 characters.',
      );
    }
    state.apiSecretToken = token;
    state.updatedAt = new Date(now()).toISOString();
    applyToConfig();
    await persist();
    return token;
  }

  return {
    hydrate,
    update,
    rotateToken,
    view,
    getToken: () => state.apiSecretToken,
  };
}
