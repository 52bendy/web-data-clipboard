const REGISTRY_KEY = 'devices:registry';
const DEFAULT_ONLINE_THRESHOLD_MS = 86_400_000;

export function createDeviceRegistry({ storage, now = Date.now } = {}) {
  if (!storage || typeof storage.update !== 'function') {
    throw new TypeError('device registry requires storage.update().');
  }

  async function touch({ device_id, device_name, platform } = {}) {
    if ([device_id, device_name, platform].some((value) =>
      typeof value !== 'string' || value.trim() === ''
    )) {
      throw new TypeError('device_id, device_name, and platform must be non-empty strings.');
    }
    const timestamp = new Date(now()).toISOString();
    let created = false;
    const record = await storage.update(REGISTRY_KEY, (current) => {
      const devices = current && typeof current === 'object' ? current : {};
      const previous = Object.hasOwn(devices, device_id) ? devices[device_id] : null;
      created = !previous;
      return {
        ...devices,
        [device_id]: {
          device_id,
          device_name: device_name.trim(),
          platform,
          first_seen: previous?.first_seen ?? timestamp,
          last_seen: timestamp,
        },
      };
    });
    return { ...record[device_id], created };
  }

  async function list({ onlineThresholdMs = DEFAULT_ONLINE_THRESHOLD_MS } = {}) {
    if (!Number.isInteger(onlineThresholdMs) || onlineThresholdMs <= 0) {
      throw new TypeError('onlineThresholdMs must be a positive integer.');
    }
    const registry = (await storage.get(REGISTRY_KEY)) || {};
    const currentTime = now();
    const devices = Object.values(registry).map((device) => ({
      ...device,
      online: currentTime - Date.parse(device.last_seen) <= onlineThresholdMs,
    }));
    devices.sort((left, right) =>
      Date.parse(right.last_seen) - Date.parse(left.last_seen) ||
      (left.device_id < right.device_id ? -1 : left.device_id > right.device_id ? 1 : 0),
    );
    const online = devices.filter((device) => device.online).length;
    return {
      devices,
      stats: {
        total: devices.length,
        online,
        offline: devices.length - online,
        online_threshold_ms: onlineThresholdMs,
      },
    };
  }

  return { touch, list };
}
