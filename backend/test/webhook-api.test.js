import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from '../src/server.js';

const TOKEN = 'test-token';

function makeConfig({ send, webhook = {} } = {}) {
  return {
    apiSecretToken: TOKEN,
    autoExtract: true,
    enforceHttps: false,
    trustProxy: false,
    rateLimitEnabled: false,
    storage: { driver: 'memory' },
    clipboard: {
      ttlMs: 1800000,
      historyMaxEntries: 500,
      historyMaxAgeMs: 86400000,
      maintenanceIntervalMs: 60000,
    },
    collect: { maxRawContentLength: 4096, maxBodyBytes: 64 * 1024 },
    webhook: {
      timeoutMs: 1000,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      validateTarget: async (value) => new URL(value),
      sleep: async () => {},
      send: send ?? (async () => ({ status: 200, body: 'ok' })),
      ...webhook,
    },
  };
}

async function withServer(config, run) {
  const server = createServer({ config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const auth = { 'X-DCC-Token': TOKEN, 'content-type': 'application/json' };

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition was not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('webhook management requires the token and supports CRUD', async () => {
  await withServer(makeConfig(), async (base) => {
    assert.equal((await fetch(`${base}/api/v1/webhooks`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/v1/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hook' }),
        })
      ).status,
      401,
    );

    const createResponse = await fetch(`${base}/api/v1/webhooks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        url: 'https://hooks.example.com/dcc',
        name: 'Ops',
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.code, 201);
    assert.match(created.data.webhook_id, /^wh_/);
    assert.equal(created.data.name, 'Ops');
    assert.match(created.data.secret, /^whsec_[0-9a-f]{64}$/);
    const id = created.data.webhook_id;

    const list = await (
      await fetch(`${base}/api/v1/webhooks`, { headers: auth })
    ).json();
    assert.equal(list.data.total, 1);
    assert.equal(list.data.webhooks[0].webhook_id, id);

    const detail = await (
      await fetch(`${base}/api/v1/webhooks/${id}`, { headers: auth })
    ).json();
    assert.equal(detail.data.webhook_id, id);

    const patched = await (
      await fetch(`${base}/api/v1/webhooks/${id}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ enabled: false }),
      })
    ).json();
    assert.equal(patched.data.enabled, false);

    const removed = await (
      await fetch(`${base}/api/v1/webhooks/${id}`, {
        method: 'DELETE',
        headers: auth,
      })
    ).json();
    assert.deepEqual(removed.data, { deleted: true, webhook_id: id });
    assert.equal(
      (await fetch(`${base}/api/v1/webhooks/${id}`, { headers: auth })).status,
      404,
    );

    assert.equal(
      (
        await fetch(`${base}/api/v1/webhooks`, {
          method: 'PUT',
          headers: auth,
        })
      ).status,
      405,
    );
    const deliveries = await (
      await fetch(`${base}/api/v1/webhooks/deliveries`, { headers: auth })
    ).json();
    assert.deepEqual(deliveries.data.deliveries, []);
  });
});

test('rejects unsafe or invalid webhook targets', async () => {
  await withServer(makeConfig(), async (base) => {
    const cases = [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://10.0.0.1/hook',
      'https://user:pass@example.com/hook',
      'not a url',
    ];
    for (const url of cases) {
      const response = await fetch(`${base}/api/v1/webhooks`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ url }),
      });
      assert.equal(response.status, 400, url);
      const payload = await response.json();
      assert.equal(payload.code, 400);
      assert.equal(payload.data, null);
    }

    const invalidBody = await fetch(`${base}/api/v1/webhooks`, {
      method: 'POST',
      headers: auth,
      body: '{bad',
    });
    assert.equal(invalidBody.status, 400);

    for (const method of ['PATCH', 'DELETE']) {
      const response = await fetch(`${base}/api/v1/webhooks/wh_missing`, {
        method,
        headers: auth,
        ...(method === 'PATCH'
          ? { body: JSON.stringify({ enabled: true }) }
          : {}),
      });
      assert.equal(response.status, 404);
    }
    assert.equal(
      (
        await fetch(`${base}/api/v1/webhooks/wh_missing/test`, {
          method: 'POST',
          headers: auth,
        })
      ).status,
      404,
    );
  });
});

test('the test endpoint performs a real signed delivery and records it', async () => {
  const calls = [];
  let status = 200;
  const config = makeConfig({
    send: async (target, request) => {
      calls.push({ target: target.toString(), ...request });
      return { status, body: status === 200 ? 'ok' : 'down' };
    },
  });
  await withServer(config, async (base) => {
    const created = await (
      await fetch(`${base}/api/v1/webhooks`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ url: 'https://example.com/hook' }),
      })
    ).json();
    const webhook = created.data;

    const tested = await (
      await fetch(`${base}/api/v1/webhooks/${webhook.webhook_id}/test`, {
        method: 'POST',
        headers: auth,
      })
    ).json();
    assert.equal(tested.code, 200);
    assert.equal(tested.data.status, 'success');
    assert.equal(tested.data.test, true);
    assert.equal(calls.length, 1);
    const sent = calls[0];
    const expected = createHmac('sha256', webhook.secret)
      .update(`${sent.headers['x-dcc-timestamp']}.${sent.body}`)
      .digest('hex');
    assert.equal(sent.headers['x-dcc-signature'], `sha256=${expected}`);
    assert.match(JSON.parse(sent.body).message, /收到新验证码/);

    status = 503;
    const failed = await (
      await fetch(`${base}/api/v1/webhooks/${webhook.webhook_id}/test`, {
        method: 'POST',
        headers: auth,
      })
    ).json();
    assert.equal(failed.data.status, 'failed');
    assert.equal(failed.data.attempts, 2);

    const failedList = await (
      await fetch(
        `${base}/api/v1/webhooks/deliveries?status=failed&webhook_id=${webhook.webhook_id}`,
        { headers: auth },
      )
    ).json();
    assert.equal(failedList.data.total, 1);
    assert.equal(failedList.data.deliveries[0].status, 'failed');
    assert.equal(failedList.data.deliveries[0].webhook_id, webhook.webhook_id);
  });
});

test('an accepted collection triggers the configured webhook asynchronously', async () => {
  const calls = [];
  const config = makeConfig({
    send: async (target, request) => {
      calls.push({ target: target.toString(), ...request });
      return { status: 200, body: 'ok' };
    },
  });
  await withServer(config, async (base) => {
    const created = await (
      await fetch(`${base}/api/v1/webhooks`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ url: 'https://example.com/hook' }),
      })
    ).json();

    const response = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        device_id: 'android_mi13_001',
        device_name: '小米 13Pro',
        platform: 'android',
        sender: '+8610086',
        raw_content:
          '【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。',
        timestamp: Date.now() - 1000,
      }),
    });
    assert.equal(response.status, 200);
    const collected = await response.json();
    assert.equal(collected.data.extracted_code, '839201');

    await waitFor(() => calls.length === 1);
    const sent = calls[0];
    const payload = JSON.parse(sent.body);
    assert.equal(payload.collection_id, collected.data.collection_id);
    assert.equal(payload.data.parsed_code, '839201');
    assert.equal(payload.data.source.device_name, '小米 13Pro');
    assert.equal(payload.sender, '+8610086');
    assert.match(payload.message, /原始短信：/);
    const expected = createHmac('sha256', created.data.secret)
      .update(`${sent.headers['x-dcc-timestamp']}.${sent.body}`)
      .digest('hex');
    assert.equal(sent.headers['x-dcc-signature'], `sha256=${expected}`);

    const deliveries = await (
      await fetch(`${base}/api/v1/webhooks/deliveries`, { headers: auth })
    ).json();
    assert.equal(deliveries.data.total, 1);
    assert.equal(deliveries.data.deliveries[0].status, 'success');
    assert.equal(
      deliveries.data.deliveries[0].collection_id,
      collected.data.collection_id,
    );
  });
});

test('a slow webhook never delays the collect response', async () => {
  const config = makeConfig({
    send: () => new Promise(() => {}),
    webhook: { timeoutMs: 1000, maxAttempts: 1 },
  });
  await withServer(config, async (base) => {
    await fetch(`${base}/api/v1/webhooks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ url: 'https://example.com/hook' }),
    });
    const started = Date.now();
    const response = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        device_id: 'android_slow_001',
        device_name: 'Slow Phone',
        platform: 'android',
        sender: '+8610086',
        raw_content: '验证码 123456，请勿泄漏。',
        timestamp: Date.now() - 1000,
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(
      Date.now() - started < 1000,
      'collect must not wait for delivery',
    );
  });
});
