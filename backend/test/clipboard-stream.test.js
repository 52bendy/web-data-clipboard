import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';
import { formatClipboardEventId } from '../src/services/realtime-hub.js';
import { createSseParser } from '../scripts/lib/sse-parser.js';

const TOKEN = 'stream-secret-token';
const RAW_TEXT =
  '【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。';
const FIXED_NOW = 1_700_000_000_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness({
  realtime = {},
  clipboard = {},
  now = Date.now,
} = {}) {
  const base = getConfig({});
  const config = {
    ...base,
    apiSecretToken: TOKEN,
    enforceHttps: false,
    trustProxy: false,
    rateLimitEnabled: false,
    clipboard: {
      ...base.clipboard,
      maintenanceIntervalMs: 3_600_000,
      ...clipboard,
    },
    realtime: { ...base.realtime, ...realtime },
  };
  const services = createServices({ config, now });
  return { config, services };
}

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controllers = [];
  try {
    await run(`http://127.0.0.1:${server.address().port}`, controllers);
  } finally {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections?.();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function openStream(
  base,
  { token = TOKEN, headers = {}, namespace } = {},
) {
  const controller = new AbortController();
  const path = namespace
    ? `/api/v1/clipboard/stream?namespace=${encodeURIComponent(namespace)}`
    : '/api/v1/clipboard/stream';
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: 'text/event-stream',
      ...(token ? { 'X-DCC-Token': token } : {}),
      ...headers,
    },
    signal: controller.signal,
  });
  return { response, controller };
}

function sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  return (async function* events() {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          yield event;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  })();
}

async function nextEvent(iterator, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for an SSE event.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

function seed(services, overrides = {}) {
  return services.clipboardStore.write({
    full_text: RAW_TEXT,
    parsed_code: '839201',
    data_type: 'verification_code',
    source: { device_name: 'Test Phone', platform: 'android' },
    ...overrides,
  });
}

async function postCollect(base, overrides = {}) {
  return fetch(`${base}/api/v1/collect`, {
    method: 'POST',
    headers: {
      'X-DCC-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      device_id: 'android_e2e_001',
      device_name: 'Test Phone',
      platform: 'android',
      sender: '10086',
      raw_content: RAW_TEXT,
      timestamp: Date.now(),
      ...overrides,
    }),
  });
}

test('sends ready and the current clipboard snapshot with §4.1.2 fields', async () => {
  const { config, services } = createHarness({ now: () => FIXED_NOW });
  await seed(services);

  await withServer(
    { config, services, now: () => FIXED_NOW },
    async (base, controllers) => {
      const { response, controller } = await openStream(base);
      controllers.push(controller);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('content-type'),
        /^text\/event-stream/,
      );
      assert.equal(
        response.headers.get('cache-control'),
        'no-cache, no-transform',
      );
      assert.equal(response.headers.get('x-accel-buffering'), 'no');

      const events = sseEvents(response);
      const ready = await nextEvent(events);
      assert.equal(ready.value.event, 'ready');
      assert.deepEqual(JSON.parse(ready.value.data), {
        connected_at: FIXED_NOW,
        heartbeat_interval_ms: config.realtime.heartbeatIntervalMs,
        retry_ms: config.realtime.retryMs,
        namespace: 'default',
      });

      const update = await nextEvent(events);
      assert.equal(update.value.event, 'clipboard.updated');
      assert.match(update.value.id, /^\d+-[0-9a-f-]{36}$/);

      const latest = await fetch(`${base}/api/v1/clipboard/latest`, {
        headers: { 'X-DCC-Token': TOKEN },
      });
      assert.deepEqual(JSON.parse(update.value.data), (await latest.json()).data);
    },
  );
});

test('pushes a collect update to subscribers in under one second', async () => {
  const { config, services } = createHarness();

  await withServer({ config, services }, async (base, controllers) => {
    const { response, controller } = await openStream(base);
    controllers.push(controller);
    const events = sseEvents(response);
    await nextEvent(events); // ready

    const started = Date.now();
    const collected = await postCollect(base);
    assert.equal(collected.status, 200);
    const update = await nextEvent(events, 1_000);
    const elapsed = Date.now() - started;

    assert.equal(update.value.event, 'clipboard.updated');
    const data = JSON.parse(update.value.data);
    assert.equal(data.content, '839201');
    assert.equal(data.type, 'verification_code');
    assert.equal(data.raw_text, RAW_TEXT);
    assert.equal(data.source_device, 'Test Phone');
    assert.equal(data.platform, 'android');
    assert.equal(typeof data.updated_at, 'number');
    assert.ok(data.expire_in_seconds > 0);
    assert.ok(elapsed < 1_000, `expected <1000ms, got ${elapsed}ms`);
  });
});

test('emits heartbeat comments while the connection is idle', async () => {
  const { config, services } = createHarness({
    realtime: { heartbeatIntervalMs: 25 },
  });

  await withServer({ config, services }, async (base, controllers) => {
    const { response, controller } = await openStream(base);
    controllers.push(controller);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 1_000;

    while (Date.now() < deadline && !text.includes(': heartbeat')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /: heartbeat \d+/);
    await reader.cancel();
  });
});

test('rejects missing, wrong and query-string tokens before streaming', async () => {
  const { config, services } = createHarness();

  await withServer({ config, services }, async (base) => {
    const missing = await fetch(`${base}/api/v1/clipboard/stream`);
    assert.equal(missing.status, 401);

    const wrong = await openStream(base, { token: 'wrong' });
    assert.equal(wrong.response.status, 401);

    const queryOnly = await fetch(
      `${base}/api/v1/clipboard/stream?token=${TOKEN}`,
    );
    assert.equal(queryOnly.status, 400);

    const queryToken = await fetch(
      `${base}/api/v1/clipboard/stream?token=${TOKEN}`,
      { headers: { 'X-DCC-Token': TOKEN } },
    );
    assert.equal(queryToken.status, 400);
    assert.deepEqual(await queryToken.json(), {
      code: 400,
      message:
        'Token must be sent in the X-DCC-Token header; query-string tokens are not supported.',
      data: null,
    });

    const accessToken = await fetch(
      `${base}/api/v1/clipboard/stream?access_token=${TOKEN}`,
      { headers: { 'X-DCC-Token': TOKEN } },
    );
    assert.equal(accessToken.status, 400);

    const method = await fetch(`${base}/api/v1/clipboard/stream`, {
      method: 'POST',
      headers: { 'X-DCC-Token': TOKEN },
    });
    assert.equal(method.status, 405);
  });
});

test('Last-Event-ID suppresses the duplicate snapshot and still receives new updates', async () => {
  const { config, services } = createHarness();
  const record = await seed(services);
  const currentId = formatClipboardEventId(record);

  await withServer({ config, services }, async (base, controllers) => {
    const { response, controller } = await openStream(base, {
      headers: { 'Last-Event-ID': currentId },
    });
    controllers.push(controller);
    const events = sseEvents(response);
    await nextEvent(events); // ready

    const collected = await postCollect(base, {
      raw_content: '新的验证码 654321',
    });
    assert.equal(collected.status, 200);
    // If the already-seen snapshot were re-sent it would arrive before this
    // update, so checking the first frame after `ready` proves the dedupe.
    const update = await nextEvent(events, 1_000);
    assert.equal(update.value.event, 'clipboard.updated');
    assert.notEqual(update.value.id, currentId);
    assert.equal(JSON.parse(update.value.data).content, '654321');
  });
});

test('a stream only receives events from its own namespace', async () => {
  const { config, services } = createHarness();

  await withServer({ config, services }, async (base, controllers) => {
    const shared = await openStream(base, { namespace: 'shared' });
    controllers.push(shared.controller);
    const events = sseEvents(shared.response);
    const ready = await nextEvent(events);
    assert.equal(ready.value.event, 'ready');
    assert.equal(JSON.parse(ready.value.data).namespace, 'shared');

    // Default-namespace writes must not leak into the shared subscription.
    await seed(services, { full_text: 'default-only' });
    await seed(services, { full_text: 'shared-only', namespace: 'shared' });

    const update = await nextEvent(events);
    assert.equal(update.value.event, 'clipboard.updated');
    const data = JSON.parse(update.value.data);
    assert.equal(data.raw_text, 'shared-only');
    assert.equal(data.namespace, 'shared');
  });
});

test('rejects an invalid namespace before streaming', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services }, async (base) => {
    const { response, controller } = await openStream(base, {
      namespace: '../escape',
    });
    controller.abort();
    assert.equal(response.status, 400);
  });
});

test('enforces the connection cap and recovers after the client disconnects', async () => {
  const { config, services } = createHarness({
    realtime: { maxConnections: 1 },
  });

  await withServer({ config, services }, async (base, controllers) => {
    const first = await openStream(base);
    controllers.push(first.controller);
    const events = sseEvents(first.response);
    await nextEvent(events); // ready
    assert.equal(services.realtimeHub.stats().active, 1);

    const second = await openStream(base);
    assert.equal(second.response.status, 503);
    assert.equal(second.response.headers.get('retry-after'), '5');
    assert.deepEqual(await second.response.json(), {
      code: 503,
      message: 'Realtime connection limit reached. Retry later.',
      data: null,
    });

    first.controller.abort();
    assert.equal(
      await waitFor(() => services.realtimeHub.stats().active === 0),
      true,
      'the aborted connection should be released',
    );

    const third = await openStream(base);
    controllers.push(third.controller);
    assert.equal(third.response.status, 200);
    await nextEvent(sseEvents(third.response)); // ready
  });
});

test('REALTIME_ENABLED=false refuses subscriptions with 503', async () => {
  const { config, services } = createHarness({
    realtime: { enabled: false },
  });

  await withServer({ config, services }, async (base) => {
    const { response, controller } = await openStream(base);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: 503,
      message: 'Realtime push is disabled.',
      data: null,
    });
    controller.abort();
  });
});
