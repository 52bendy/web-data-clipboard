import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  pollOnce,
  writeSystemClipboard,
} from '../scripts/pc-poll-sync.js';
import {
  E2E_TOKEN,
  collectPayload,
  request,
  startBackend,
} from '../scripts/lib/e2e-harness.js';

const silentLogger = { log() {}, warn() {}, error() {} };

async function withHarness(run) {
  const harness = await startBackend();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

test('parseArgs applies defaults and validates numeric flags', () => {
  const defaults = parseArgs([], {});
  assert.equal(defaults.url, 'http://localhost:3000');
  assert.equal(defaults.intervalSeconds, 5);
  assert.equal(defaults.clipboard, true);
  assert.equal(defaults.notify, true);
  assert.throws(() => parseArgs(['--interval', '0'], {}), /positive number/);
  assert.throws(() => parseArgs(['--unknown'], {}), /Unknown option/);
  const parsed = parseArgs(
    ['--url', 'http://example.test:8080/', '--once', '--no-notify', '--raw'],
    {},
  );
  assert.equal(parsed.url, 'http://example.test:8080');
  assert.equal(parsed.once, true);
  assert.equal(parsed.notify, false);
  assert.equal(parsed.raw, true);
});

test('pollOnce copies a new value once, then relies on the ETag', async () => {
  await withHarness(async ({ base }) => {
    const collected = await request(base, '/api/v1/collect', {
      method: 'POST',
      token: E2E_TOKEN,
      body: collectPayload(),
    });
    assert.equal(collected.status, 200);

    const dir = await mkdtemp(join(tmpdir(), 'dcc-poll-'));
    const statePath = join(dir, 'state.json');
    const written = [];
    const notifications = [];
    try {
      const first = await pollOnce({
        baseUrl: base,
        token: E2E_TOKEN,
        statePath,
        clipboard: true,
        notify: true,
        writeClipboard: async (text) => {
          written.push(text);
          return { ok: true, command: 'test' };
        },
        sendNotification: async (notification) => {
          notifications.push(notification);
          return true;
        },
        logger: silentLogger,
      });
      assert.equal(first.updated, true);
      assert.equal(first.text, '839201');
      assert.deepEqual(written, ['839201']);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].body, /E2E 小米 13Pro/);

      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.ok(state.etag);
      assert.equal(typeof state.updated_at, 'number');

      const second = await pollOnce({
        baseUrl: base,
        token: E2E_TOKEN,
        statePath,
        clipboard: true,
        notify: true,
        writeClipboard: async (text) => {
          written.push(text);
          return { ok: true, command: 'test' };
        },
        sendNotification: async (notification) => {
          notifications.push(notification);
          return true;
        },
        logger: silentLogger,
      });
      assert.equal(second.updated, false);
      assert.equal(second.reason, 'not-modified');
      assert.deepEqual(written, ['839201']);
      assert.equal(notifications.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('pollOnce treats 404 as an empty clipboard and does not advance state', async () => {
  await withHarness(async ({ base }) => {
    const dir = await mkdtemp(join(tmpdir(), 'dcc-poll-'));
    const statePath = join(dir, 'state.json');
    try {
      const result = await pollOnce({
        baseUrl: base,
        token: E2E_TOKEN,
        statePath,
        clipboard: false,
        notify: false,
        logger: silentLogger,
      });
      assert.equal(result.updated, false);
      assert.equal(result.reason, 'empty-or-expired');
      await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('writeSystemClipboard reports a missing utility instead of throwing', () => {
  const result = writeSystemClipboard('hello', {
    platform: 'linux',
    spawn: () => ({ error: new Error('not found'), status: null }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no clipboard utility succeeded/);
});

test('writeSystemClipboard uses the first working platform utility', () => {
  const calls = [];
  const result = writeSystemClipboard('hello', {
    platform: 'linux',
    spawn: (command, args) => {
      calls.push([command, args]);
      return { status: command === 'xclip' ? 0 : 1 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, 'xclip');
  assert.deepEqual(calls[0][0], 'wl-copy');
  assert.deepEqual(calls[1], ['xclip', ['-selection', 'clipboard']]);
});
