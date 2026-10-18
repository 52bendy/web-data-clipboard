import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';

const MASTER_TOKEN = 'master-secret-token';
const TOKEN_A = 'project-a-token';
const TOKEN_B = 'project-b-token';
const READONLY_TOKEN = 'project-c-read-token';
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const TOKENS = [
  {
    token: TOKEN_A,
    project: 'project-a',
    label: '项目 A',
    name: 'project-a-ci',
    namespaces: ['project-a', 'shared'],
    permissions: ['read', 'write'],
  },
  {
    token: TOKEN_B,
    project: 'project-b',
    label: '项目 B',
    name: 'project-b-ci',
    namespaces: ['project-b', 'shared'],
    permissions: ['read', 'write'],
  },
  {
    token: READONLY_TOKEN,
    project: 'project-c',
    label: '项目 C',
    name: 'project-c-reader',
    namespaces: ['project-c'],
    permissions: ['read'],
  },
];

function baseConfig(overrides = {}) {
  const defaults = getConfig({});
  return {
    ...defaults,
    apiSecretToken: MASTER_TOKEN,
    enforceHttps: false,
    trustProxy: false,
    rateLimitEnabled: false,
    clipboard: {
      ...defaults.clipboard,
      ttlMs: 1_800_000,
      maintenanceIntervalMs: 3_600_000,
      tokens: TOKENS,
      ...overrides.clipboard,
    },
  };
}

function createHarness(overrides = {}) {
  const config = baseConfig(overrides);
  const services = createServices({ config, now: () => NOW });
  return { config, services };
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

function postWrite(base, token, body, path = '/api/v1/clipboard/write') {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-DCC-Token'] = token;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const getLatest = (base, token, namespace) =>
  fetch(
    `${base}/api/v1/clipboard/latest${
      namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''
    }`,
    { headers: token ? { 'X-DCC-Token': token } : {} },
  );

test('write API requires a header token and rejects query-string tokens', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    assert.equal(
      (await postWrite(base, null, { content: 'hello' })).status,
      401,
    );
    assert.equal(
      (await postWrite(base, 'wrong-token', { content: 'hello' })).status,
      401,
    );

    const queryOnly = await postWrite(
      base,
      TOKEN_A,
      { content: 'hello' },
      `/api/v1/clipboard/write?token=${TOKEN_A}`,
    );
    assert.equal(queryOnly.status, 400);
    assert.deepEqual(await queryOnly.json(), {
      code: 400,
      message:
        'Token must be sent in the X-DCC-Token header; query-string tokens are not supported.',
      data: null,
    });
  });
});

test('a project token writes text with its own source metadata', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    const response = await postWrite(base, TOKEN_A, {
      content: '部署完成：v1.2.3',
      type: 'text',
      namespace: 'project-a',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, 200);
    assert.equal(body.data.content, '部署完成：v1.2.3');
    assert.equal(body.data.type, 'text');
    assert.equal(body.data.raw_text, '部署完成：v1.2.3');
    assert.equal(body.data.namespace, 'project-a');
    assert.equal(body.data.source_project, 'project-a');
    assert.equal(body.data.source_label, '项目 A');
    assert.equal(body.data.collector, 'api');
    assert.equal(body.data.source_device, 'project-a-ci');
    assert.equal(body.data.platform, 'api');
    assert.equal(typeof body.data.updated_at, 'number');
    assert.equal(typeof body.data.received_at, 'string');
    assert.equal(typeof body.data.clipboard_id, 'string');
    assert.equal(typeof body.data.collection_id, 'string');

    const latest = await getLatest(base, TOKEN_A, 'project-a');
    assert.equal(latest.status, 200);
    const latestBody = await latest.json();
    assert.equal(latestBody.data.content, '部署完成：v1.2.3');
    assert.equal(latestBody.data.source_project, 'project-a');

    // The SMS/default namespace was not touched.
    assert.equal((await getLatest(base, MASTER_TOKEN)).status, 404);
  });
});

test('namespace isolation and scoped read permissions are enforced', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    assert.equal(
      (
        await postWrite(base, TOKEN_A, {
          content: 'A only',
          namespace: 'project-a',
        })
      ).status,
      200,
    );

    assert.equal((await getLatest(base, TOKEN_B, 'project-a')).status, 403);
    assert.equal((await getLatest(base, READONLY_TOKEN, 'project-c')).status, 404);
    assert.equal((await getLatest(base, READONLY_TOKEN, 'project-a')).status, 403);
    assert.equal(
      (await getLatest(base, TOKEN_A, 'project-a')).status,
      200,
    );
  });
});

test('a read-only token cannot write', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    const response = await postWrite(base, READONLY_TOKEN, {
      content: 'nope',
      namespace: 'project-c',
    });
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json()).message,
      'Token is not allowed to write this namespace.',
    );
  });
});

test('two projects exchange data through a shared namespace without polluting SMS', async () => {
  const { config, services } = createHarness();
  await services.clipboardStore.write({
    full_text: '【中国移动】您的验证码是：839201，5分钟内有效。',
    parsed_code: '839201',
    data_type: 'verification_code',
    source: {
      device_name: '小米 13Pro',
      platform: 'android',
      project: 'sms',
      label: '短信采集',
      collector: 'sms',
    },
  });

  await withServer({ config, services, now: () => NOW }, async (base) => {
    // Project A copies a payload into the shared clipboard.
    const copied = await postWrite(base, TOKEN_A, {
      content: { build: '42', status: 'green' },
      type: 'json',
      namespace: 'shared',
      label: 'CI 构建结果',
    });
    assert.equal(copied.status, 200);
    const copiedBody = await copied.json();
    assert.equal(copiedBody.data.source_project, 'project-a');
    assert.equal(copiedBody.data.source_label, 'CI 构建结果');

    // Project B pastes it from the same shared namespace.
    const pasted = await getLatest(base, TOKEN_B, 'shared');
    assert.equal(pasted.status, 200);
    const pastedBody = await pasted.json();
    assert.deepEqual(pastedBody.data.content, {
      build: '42',
      status: 'green',
    });
    assert.equal(pastedBody.data.type, 'json');
    assert.equal(pastedBody.data.source_project, 'project-a');

    // The SMS pipeline still owns the default namespace.
    const sms = await getLatest(base, MASTER_TOKEN);
    assert.equal(sms.status, 200);
    assert.equal((await sms.json()).data.content, '839201');

    const logs = await services.collectionLogStore.query({ pageSize: 100 });
    assert.equal(logs.total, 1);
    assert.equal(logs.items[0].collector, 'api');
    assert.equal(logs.items[0].source_project, 'project-a');
    assert.equal(logs.items[0].source_label, 'CI 构建结果');
    assert.equal(logs.items[0].namespace, 'shared');
  });
});

test('link writes validate the URL and JSON writes preserve their native value', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    const link = await postWrite(base, TOKEN_A, {
      content: 'https://example.com/build/42',
      type: 'link',
      namespace: 'project-a',
    });
    assert.equal(link.status, 200);
    assert.equal((await link.json()).data.type, 'link');

    for (const content of ['not a url', 'ftp://example.com/file']) {
      const invalid = await postWrite(base, TOKEN_A, {
        content,
        type: 'link',
        namespace: 'project-a',
      });
      assert.equal(invalid.status, 400, content);
    }

    const json = await postWrite(base, TOKEN_A, {
      content: { items: [1, 2, 3], ok: true },
      type: 'json',
      namespace: 'project-a',
    });
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.deepEqual(body.data.content, { items: [1, 2, 3], ok: true });
    assert.deepEqual(JSON.parse(body.data.raw_text), {
      items: [1, 2, 3],
      ok: true,
    });
  });
});

test('rejects invalid writes and cross-project impersonation', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    const cases = [
      [{ content: '', namespace: 'project-a' }, 400],
      [{ content: 'x', type: 'binary', namespace: 'project-a' }, 400],
      [{ content: 'x', namespace: '../escape' }, 400],
      [{ content: 'x', namespace: 'shared', project: 'project-b' }, 403],
      [{ type: 'json', namespace: 'project-a' }, 400],
    ];
    for (const [body, status] of cases) {
      const response = await postWrite(base, TOKEN_A, body);
      assert.equal(response.status, status, JSON.stringify(body));
    }

    const wrongProjectRead = await getLatest(base, TOKEN_A, 'project-b');
    assert.equal(wrongProjectRead.status, 403);
  });
});

test('master token can write any project and namespace', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services, now: () => NOW }, async (base) => {
    const response = await postWrite(base, MASTER_TOKEN, {
      content: 'system generated',
      project: 'ops',
      label: '运维脚本',
      namespace: 'shared',
      source_device: 'cron',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.source_project, 'ops');
    assert.equal(body.data.source_label, '运维脚本');
    assert.equal(body.data.source_device, 'cron');
  });
});

test('oversized bodies and contents are rejected', async () => {
  const { config, services } = createHarness({
    clipboard: { maxWriteBodyBytes: 128, maxContentLength: 10 },
  });
  await withServer({ config, services, now: () => NOW }, async (base) => {
    const tooBig = await postWrite(base, TOKEN_A, {
      content: 'x'.repeat(200),
      namespace: 'project-a',
    });
    assert.equal(tooBig.status, 413);

    const tooLong = await postWrite(base, TOKEN_A, {
      content: 'x'.repeat(11),
      namespace: 'project-a',
    });
    assert.equal(tooLong.status, 400);
  });
});
