import { errorResponse } from '../../src/middleware/errors.js';
import { SettingsError } from '../../src/services/settings-store.js';
import { ok } from '../../src/utils/respond.js';

const MAX_BODY_BYTES = 64 * 1024;

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
    return { error: errorResponse(400, 'request body must be valid JSON.') };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: errorResponse(400, 'request body must be valid JSON.') };
  }
}

/** GET /api/admin/devices — device registry view for the admin device list. */
export function createAdminDevicesHandler({ services, config = {} } = {}) {
  return async function handleAdminDevices(request) {
    if (request.method !== 'GET') return errorResponse(405);
    const result = await services.deviceRegistry.list({
      onlineThresholdMs: config.devices?.onlineThresholdMs ?? 86_400_000,
    });
    return ok(result, 'Devices retrieved successfully');
  };
}

/**
 * Admin settings panel API (REQ-202610-1262):
 *   GET   /api/admin/settings
 *   PATCH /api/admin/settings
 *   POST  /api/admin/token/reset
 *
 * The admin session and CSRF checks are enforced by the shared app router;
 * these handlers only validate the payload and talk to the settings store.
 */
export function createAdminSettingsHandlers({ services, logger = null } = {}) {
  const store = services.settingsStore;

  async function get(request) {
    if (request.method !== 'GET') return errorResponse(405);
    return ok(store.view(), 'Settings retrieved');
  }

  async function update(request) {
    if (request.method !== 'PATCH') return errorResponse(405);
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    try {
      const settings = await store.update(parsed.value);
      logger?.info('admin.settings.updated', {
        auto_extract: settings.auto_extract,
        mask_sender: settings.mask_sender,
        webhook_url_configured: Boolean(settings.webhook_url),
      });
      return ok(settings, 'Settings updated');
    } catch (error) {
      if (error instanceof SettingsError)
        return errorResponse(400, error.message);
      throw error;
    }
  }

  async function resetToken(request) {
    if (request.method !== 'POST') return errorResponse(405);
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    // The UI asks the operator to type RESET; the server also refuses an
    // unconfirmed rotation so a stray POST cannot invalidate every device.
    if (parsed.value?.confirm !== true && parsed.value?.confirm !== 'RESET') {
      return errorResponse(
        400,
        'Token rotation requires explicit confirmation.',
      );
    }
    const token = await store.rotateToken();
    const settings = store.view();
    logger?.info('admin.settings.token_rotated', {
      token_masked: settings.token_masked,
    });
    // The plaintext token is returned exactly once so the operator can copy
    // it into the device configuration; it is never stored in plaintext logs.
    return ok({ token, ...settings }, 'Token rotated');
  }

  return { get, update, resetToken };
}
