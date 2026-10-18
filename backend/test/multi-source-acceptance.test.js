import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';

const MASTER_TOKEN = 'master-token';
const TOKEN_A = 'token-project-a';
const TOKEN_B = 'token-project-b';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'multi-source-admin-password';
const silentLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function makeConfig() {
  const defaults = getConfig({});
  return {
    ...defaults,
    apiSecretToken: MASTER_TOKEN,
    enforceHttps: false,
    trustProxy: false,
    rateLimitEnabled: false,
    collect: {
      ...defaults.collect,
      project: 'sms',
      sourceLabel: '短信采集',
      namespace: 'default',
    },
    clipboard: {
      ...defaults.clipboard,
      maintenanceIntervalMs: 3_600_000,
      tokens: [
        {
          token: TOKEN_A,
          project: 'project-a',
          label: '项目 A',
          name: 'project-a-ci',
          namespaces: ['shared'],
          permissions: ['read', 'write'],
        },
        {
          token: TOKEN_B,
          project: 'project-b',
          label: '项目 B',
          name: 'project-b-ci',
          namespaces: ['shared'],
          permissions: ['read', 'write'],
        },
      ],
    },
    admin: {
      ...defaults.admin,
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      passwordHash: '',
    },
  };
}

async function withServer(options, run) {
  const server = createServer({ adminOptions: { logger: silentLogger }, ...options });
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
  assert.equal(response.status, 200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

test('acceptance: two projects copy/paste through a shared namespace while SMS stays isolated and admin filters sources', async () => {
  const config = makeConfig();
  const services = createServices({ config, now: () => NOW });

  await withServer({ config, services, now: () => NOW }, async (base) => {
    // 1. SMS collector writes to the default namespace.
    const collected = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dcc-token': MASTER_TOKEN,
      },
      body: JSON.stringify({
        device_id: 'android_mi13_001',
        device_name: '小米 13Pro',
        platform: 'android',
        sender: '13800138000',
        raw_content: '【中国移动】您的验证码是：839201，5分钟内有效。',
        timestamp: NOW - 1000,
      }),
    });
    assert.equal(collected.status, 200);

    // 2. Project A copies a JSON payload into the shared clipboard.
    const copied = await fetch(`${base}/api/v1/clipboard/write`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dcc-token': TOKEN_A,
      },
      body: JSON.stringify({
        content: { release: 'v1.2.3', status: 'green' },
        type: 'json',
        namespace: 'shared',
        label: 'CI 构建结果',
      }),
    });
    assert.equal(copied.status, 200);
    const copiedBody = await copied.json();
    assert.equal(copiedBody.data.source_project, 'project-a');
    assert.equal(copiedBody.data.source_label, 'CI 构建结果');

    // 3. Project B pastes the same payload from the shared namespace.
    const pasted = await fetch(
      `${base}/api/v1/clipboard/latest?namespace=shared`,
      { headers: { 'x-dcc-token': TOKEN_B } },
    );
    assert.equal(pasted.status, 200);
    const pastedBody = await pasted.json();
    assert.deepEqual(pastedBody.data.content, {
      release: 'v1.2.3',
      status: 'green',
    });
    assert.equal(pastedBody.data.source_project, 'project-a');

    // 4. The SMS pipeline still returns its own latest record untouched.
    const sms = await fetch(`${base}/api/v1/clipboard/latest`, {
      headers: { 'x-dcc-token': MASTER_TOKEN },
    });
    assert.equal(sms.status, 200);
    const smsBody = await sms.json();
    assert.equal(smsBody.data.content, '839201');
    assert.equal(smsBody.data.collector, 'sms');
    assert.equal(smsBody.data.source_project, 'sms');
    assert.equal(smsBody.data.namespace, 'default');

    // 5. The admin dashboard shows the source metadata of the active record.
    const cookie = await login(base);
    const dashboard = await (
      await fetch(`${base}/api/admin/dashboard`, { headers: { cookie } })
    ).json();
    assert.equal(dashboard.data.clipboard_state, 'active');
    assert.equal(dashboard.data.clipboard.source_project, 'sms');
    assert.equal(dashboard.data.clipboard.source_label, '短信采集');
    assert.equal(dashboard.data.stats.today_collected, 1);
    assert.equal(dashboard.data.stats.today_api_writes, 1);

    // 6. The log board can filter by collector/project and sees the label.
    const apiLogs = await (
      await fetch(
        `${base}/api/admin/logs?collector=api&project=project-a&namespace=shared`,
        { headers: { cookie } },
      )
    ).json();
    assert.equal(apiLogs.data.total, 1);
    assert.equal(apiLogs.data.items[0].source_label, 'CI 构建结果');
    assert.equal(apiLogs.data.items[0].collector, 'api');

    const smsLogs = await (
      await fetch(`${base}/api/admin/logs?collector=sms`, {
        headers: { cookie },
      })
    ).json();
    assert.equal(smsLogs.data.total, 1);
    assert.equal(smsLogs.data.items[0].source_project, 'sms');

    // 7. The admin page exposes the multi-source filters and columns.
    const page = await fetch(`${base}/admin/logs`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const marker of [
      'id="collector"',
      'id="project"',
      'id="source"',
      'id="namespace"',
      '<th>来源</th>',
      '<th>命名空间</th>',
    ]) {
      assert.ok(html.includes(marker), `missing ${marker}`);
    }
  });
});
