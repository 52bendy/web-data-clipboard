import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createServices } from '../src/services/index.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'management-password';
const silentLogger = { info() {}, warn() {}, error() {} };

function makeConfig(overrides = {}) {
  return {
    apiSecretToken: 'old-token',
    enforceHttps: false,
    trustProxy: false,
    contentSecurityPolicy: "default-src 'self'",
    hstsMaxAge: 31536000,
    rateLimitEnabled: false,
    rateLimitPerMinute: 30,
    rateLimitWindowSeconds: 60,
    autoExtract: true,
    maskSender: true,
    storage: { driver: 'memory' },
    clipboard: {
      ttlMs: 1800000,
      historyMaxEntries: 500,
      historyMaxAgeMs: 86400000,
      maintenanceIntervalMs: 60000,
    },
    collect: { maxRawContentLength: 4096, maxBodyBytes: 65536 },
    devices: { onlineThresholdMs: 1000 },
    logs: { maxEntries: 1000, maxAgeMs: 7 * 86400000 },
    admin: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      passwordHash: '',
      sessionTtlMs: 3600000,
      loginMaxAttempts: 10,
      loginWindowMs: 900000,
      maxSessions: 100,
      cookieSecure: 'auto',
    },
    ...overrides,
  };
}

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function login(base) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  const body = await response.json();
  return { cookie, csrf: body.data.csrfToken, body };
}

function collectPayload(overrides = {}) {
  return {
    device_id: 'android_mi13_001',
    device_name: '小米 13Pro',
    platform: 'android',
    sender: '13800138000',
    raw_content: '【中国移动】您的验证码是：839201，5分钟内有效。',
    timestamp: Date.now(),
    ...overrides,
  };
}

function postCollect(base, token, payload = collectPayload()) {
  return fetch(`${base}/api/v1/collect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dcc-token': token,
    },
    body: JSON.stringify(payload),
  });
}

test('admin modules require a session and serve the three static pages', async () => {
  await withServer(
    { config: makeConfig(), adminOptions: { logger: silentLogger } },
    async (base) => {
      for (const path of [
        '/api/admin/devices',
        '/api/admin/logs',
        '/api/admin/settings',
      ]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 401, path);
      }

      const { cookie } = await login(base);
      const devices = await fetch(`${base}/api/admin/devices`, {
        headers: { cookie },
      });
      assert.equal(devices.status, 200);
      const deviceBody = await devices.json();
      assert.deepEqual(deviceBody.data.stats, {
        total: 0,
        online: 0,
        offline: 0,
        online_threshold_ms: 1000,
      });

      const logs = await fetch(`${base}/api/admin/logs`, {
        headers: { cookie },
      });
      assert.equal(logs.status, 200);
      assert.equal((await logs.json()).data.total, 0);

      const settings = await fetch(`${base}/api/admin/settings`, {
        headers: { cookie },
      });
      assert.equal(settings.status, 200);
      const settingsBody = await settings.json();
      assert.equal(settingsBody.data.auto_extract, true);
      assert.equal(settingsBody.data.mask_sender, true);
      assert.equal(settingsBody.data.token_configured, true);

      for (const [path, marker] of [
        ['/admin/devices.html', '设备列表'],
        ['/admin/logs.html', '日志看板'],
        ['/admin/settings.html', '设置面板'],
      ]) {
        const page = await fetch(`${base}${path}`, { headers: { cookie } });
        assert.equal(page.status, 200, path);
        const html = await page.text();
        assert.match(html, new RegExp(marker));
        assert.doesNotMatch(html, /\{\{CSRF_TOKEN\}\}/);
      }
    },
  );
});

test('settings PATCH requires CSRF and changes collect/log behaviour immediately', async () => {
  await withServer(
    { config: makeConfig(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const { cookie, csrf } = await login(base);

      const missingCsrf = await fetch(`${base}/api/admin/settings`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ auto_extract: false }),
      });
      assert.equal(missingCsrf.status, 403);

      const updated = await fetch(`${base}/api/admin/settings`, {
        method: 'PATCH',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          auto_extract: false,
          mask_sender: false,
          webhook_url: 'https://example.com/hooks/dcc',
        }),
      });
      assert.equal(updated.status, 200);
      const body = await updated.json();
      assert.equal(body.data.auto_extract, false);
      assert.equal(body.data.mask_sender, false);
      assert.equal(body.data.webhook_url, 'https://example.com/hooks/dcc');

      const collected = await postCollect(base, 'old-token');
      assert.equal(collected.status, 200);
      const collectedBody = await collected.json();
      assert.equal(collectedBody.data.extracted_code, null);

      const logs = await fetch(`${base}/api/admin/logs`, {
        headers: { cookie },
      });
      const logsBody = await logs.json();
      assert.equal(logsBody.data.items[0].sender, '13800138000');
      assert.equal(logsBody.data.items[0].extracted_code, null);

      const invalid = await fetch(`${base}/api/admin/settings`, {
        method: 'PATCH',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ webhook_url: 'http://127.0.0.1/hook' }),
      });
      assert.equal(invalid.status, 400);
    },
  );
});

test('token reset requires confirmation and invalidates the old token', async () => {
  await withServer(
    { config: makeConfig(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const { cookie, csrf } = await login(base);

      const unconfirmed = await fetch(`${base}/api/admin/token/reset`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ confirm: false }),
      });
      assert.equal(unconfirmed.status, 400);

      const reset = await fetch(`${base}/api/admin/token/reset`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ confirm: true }),
      });
      assert.equal(reset.status, 200);
      const resetBody = await reset.json();
      const newToken = resetBody.data.token;
      assert.match(newToken, /^dcc_[0-9a-f]{48}$/);
      assert.equal(resetBody.data.token_configured, true);
      assert.notEqual(resetBody.data.token_masked, newToken);

      assert.equal((await postCollect(base, 'old-token')).status, 401);
      assert.equal((await postCollect(base, newToken)).status, 200);
    },
  );
});

test('device list reports online/offline and logs support filters', async () => {
  let now = Date.now();
  const config = makeConfig();
  const services = createServices({ config, now: () => now });
  await withServer(
    { config, services, adminOptions: { logger: silentLogger } },
    async (base) => {
      const { cookie } = await login(base);
      assert.equal((await postCollect(base, 'old-token')).status, 200);

      const online = await fetch(`${base}/api/admin/devices`, {
        headers: { cookie },
      });
      const onlineBody = await online.json();
      assert.equal(onlineBody.data.devices.length, 1);
      assert.equal(onlineBody.data.devices[0].online, true);
      assert.equal(onlineBody.data.stats.online, 1);

      now += 2000;
      const offline = await fetch(`${base}/api/admin/devices`, {
        headers: { cookie },
      });
      const offlineBody = await offline.json();
      assert.equal(offlineBody.data.devices[0].online, false);
      assert.equal(offlineBody.data.stats.offline, 1);

      const filtered = await fetch(
        `${base}/api/admin/logs?device=mi13&keyword=839201&page=1&page_size=20`,
        { headers: { cookie } },
      );
      assert.equal(filtered.status, 200);
      assert.equal((await filtered.json()).data.total, 1);

      const none = await fetch(`${base}/api/admin/logs?device=iphone`, {
        headers: { cookie },
      });
      assert.equal((await none.json()).data.total, 0);
    },
  );
});
