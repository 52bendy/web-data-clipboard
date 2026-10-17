import { errorResponse } from '../../src/middleware/errors.js';
import { ok } from '../../src/utils/respond.js';

export function createDevicesHandler({ deviceRegistry, config = {} } = {}) {
  return async function handleDevices(request) {
    if (request.method !== 'GET') return errorResponse(405);
    const result = await deviceRegistry.list({
      onlineThresholdMs: config.devices?.onlineThresholdMs ?? 86_400_000,
    });
    return ok(result, 'Devices retrieved successfully');
  };
}
