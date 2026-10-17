import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createUpstashStorage } from '../src/services/storage/upstash-storage.js';
import { createStorage } from '../src/services/storage/index.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';

async function createFakeUpstash() {
  const values = new Map();
  const requests = [];
  let failure = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const args = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ headers: request.headers, args });
    if (failure) {
      response.writeHead(failure.status, { 'content-type': 'application/json' });
      response.end(failure.raw ?? JSON.stringify(failure.body));
      return;
    }
    const [operation, ...params] = args;
    let result;
    if (operation === 'GET') {
      const entry = values.get(params[0]);
      if (entry?.expiresAt <= Date.now()) values.delete(params[0]);
      result = values.get(params[0])?.value ?? null;
    } else if (operation === 'SET') {
      const [key, value, ...options] = params;
      if (options.includes('NX') && values.has(key)) {
        result = null;
      } else {
        const px = options.indexOf('PX');
        values.set(key, {
          value,
          expiresAt: px >= 0 ? Date.now() + Number(options[px + 1]) : Infinity,
        });
        result = 'OK';
      }
    } else if (operation === 'DEL') {
      result = values.delete(params[0]) ? 1 : 0;
    } else if (operation === 'EVAL') {
      const [, , count, key, lockToken] = args;
      const entry = values.get(key);
      if (Number(count) === 1 && entry?.value === lockToken) {
        values.delete(key);
        result = 1;
      } else {
        result = 0;
      }
    } else {
      response.writeHead(400);
      response.end(JSON.stringify({ error: `unsupported command: ${operation}` }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    values,
    requests,
    failWith(nextFailure) { failure = nextFailure; },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function withFake(run, options = {}) {
  const fake = await createFakeUpstash();
  try {
    const storage = createUpstashStorage({ url: fake.url, token: 'test-token', ...options });
    await run({ fake, storage });
  } finally {
    await fake.close();
  }
}

test('Upstash CRUD uses prefixed REST keys and returns defensive JSON copies', async () => {
  await withFake(async ({ fake, storage }) => {
    const input = { nested: { value: 1 } };
    await storage.set('item', input);
    input.nested.value = 9;
    const value = await storage.get('item');
    assert.deepEqual(value, { nested: { value: 1 } });
    value.nested.value = 7;
    assert.deepEqual(await storage.get('item'), { nested: { value: 1 } });
    assert.equal(fake.requests[0].headers.authorization, 'Bearer test-token');
    assert.deepEqual(fake.requests[0].args, ['SET', 'dcc:item', '{"nested":{"value":1}}']);
    await storage.delete('item');
    assert.equal(await storage.get('item'), null);
  });
});

test('Upstash set honors TTL and leaves values without TTL persistent', async () => {
  await withFake(async ({ fake, storage }) => {
    await storage.set('short', 'value', { ttlMs: 20 });
    await storage.set('forever', 'value');
    assert.deepEqual(fake.requests[0].args.slice(0, 4), ['SET', 'dcc:short', '"value"', 'PX']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await storage.get('short'), null);
    assert.equal(await storage.get('forever'), 'value');
  });
});

test('Upstash update serializes concurrent increments and releases locks on errors', async () => {
  await withFake(async ({ fake, storage }) => {
    await Promise.all(Array.from({ length: 25 }, () =>
      storage.update('counter', async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return (current ?? 0) + 1;
      }),
    ));
    assert.equal(await storage.get('counter'), 25);
    await assert.rejects(storage.update('counter', () => { throw new Error('updater failed'); }), /updater failed/);
    assert.equal([...fake.values.keys()].some((key) => key.includes('__lock__')), false);
    assert.equal(await storage.update('counter', (value) => value + 1), 26);
    assert.equal(await storage.update('counter', (value) => value), 26);
    assert.equal(await storage.update('counter', () => undefined), null);
  });
});

test('Upstash reports REST errors and non-success HTTP responses', async () => {
  await withFake(async ({ fake, storage }) => {
    fake.failWith({ status: 200, body: { error: 'bad command' } });
    await assert.rejects(storage.get('x'), /Upstash error: bad command/);
    fake.failWith({ status: 503, body: { error: 'offline' } });
    await assert.rejects(storage.get('x'), /HTTP 503/);
    fake.failWith({ status: 200, raw: 'not json' });
    await assert.rejects(storage.get('x'), /invalid Upstash JSON response/);
  });
});

test('Upstash purgeExpired is a no-op because Redis owns TTL expiry', async () => {
  await withFake(async ({ storage }) => assert.equal(await storage.purgeExpired(), 0));
});

test('clipboard store works with Upstash storage and Redis TTL', async () => {
  await withFake(async ({ fake }) => {
    const { clipboardStore: store } = createServices({
      config: {
        storage: {
          driver: 'upstash',
          upstashUrl: fake.url,
          upstashToken: 'test-token',
          keyPrefix: 'test:',
        },
        clipboard: { ttlMs: 30 },
      },
      now: Date.now,
    });
    await store.write({ full_text: 'hello' });
    assert.equal((await store.getLatest()).full_text, 'hello');
    assert.equal((await store.getHistory()).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await store.getLatest(), null);
  });
});

test('Upstash factory and config validate driver credentials while memory stays default', () => {
  assert.equal(getConfig({}).storage.driver, 'memory');
  assert.throws(() => getConfig({ STORAGE_DRIVER: 'upstash' }), /UPSTASH_REDIS_REST_URL/);
  assert.throws(() => getConfig({ STORAGE_DRIVER: 'other' }), /Unsupported storage type: other/);
  assert.throws(() => createStorage({ type: 'upstash' }), /requires a REST URL/);
  const config = getConfig({ STORAGE_DRIVER: 'upstash', UPSTASH_REDIS_REST_URL: 'http://localhost', UPSTASH_REDIS_REST_TOKEN: 'token' });
  assert.equal(createStorage({ type: config.storage.driver, url: config.storage.upstashUrl, token: config.storage.upstashToken }).constructor, Object);
  assert.throws(
    () => createServices({ config: { storage: { driver: 'upstash' } } }),
    /requires a REST URL/,
  );
});
