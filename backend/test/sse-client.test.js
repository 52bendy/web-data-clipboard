import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../scripts/lib/sse-parser.js';
import { parseArgs, runSubscriber } from '../scripts/sse-subscribe.js';

test('SSE parser handles split chunks, CRLF, comments and multi-line data', () => {
  const parser = createSseParser();

  assert.deepEqual(parser.feed(': heartbeat 1\n\n'), []);
  assert.deepEqual(parser.feed('event: clip'), []);
  assert.deepEqual(
    parser.feed(
      'board.updated\r\nid: 42-abc\r\ndata: {"content":"123",\r\ndata: "type":"code"}\r\n\r\n',
    ),
    [
      {
        event: 'clipboard.updated',
        id: '42-abc',
        data: '{"content":"123",\n"type":"code"}',
      },
    ],
  );
  assert.deepEqual(parser.feed('retry: 2500\n\n'), [
    { event: 'message', data: '', retry: 2500 },
  ]);
  assert.equal(parser.pending, '');
});

test('parseArgs applies defaults, environment and CLI overrides', () => {
  const defaults = parseArgs([], {});
  assert.equal(defaults.url, 'http://localhost:3000');
  assert.equal(defaults.once, false);
  assert.equal(defaults.clipboard, true);

  const options = parseArgs(
    [
      '--url',
      'http://127.0.0.1:4000/',
      '--token',
      'secret',
      '--once',
      '--raw',
      '--no-clipboard',
      '--no-notify',
      '--timeout',
      '5',
      '--quiet',
    ],
    { DCC_TOKEN: 'from-env' },
  );
  assert.equal(options.url, 'http://127.0.0.1:4000');
  assert.equal(options.token, 'secret');
  assert.equal(options.once, true);
  assert.equal(options.raw, true);
  assert.equal(options.clipboard, false);
  assert.equal(options.notify, false);
  assert.equal(options.idleTimeoutSeconds, 5);
  assert.equal(options.quiet, true);
});

test('parseArgs rejects invalid URLs and missing values', () => {
  assert.throws(() => parseArgs(['--url', 'ftp://example.com'], {}), /http/);
  assert.throws(() => parseArgs(['--token'], {}), /requires a value/);
  assert.throws(() => parseArgs(['--timeout', '0'], {}), /positive number/);
  assert.throws(() => parseArgs(['--unknown'], {}), /Unknown option/);
});

test('runSubscriber reconnects after a closed stream and returns the first update', async () => {
  const calls = [];
  const fetchImpl = async (url, { headers }) => {
    calls.push({ url, headers });
    if (calls.length === 1) {
      return new Response(
        'retry: 5\n\nevent: ready\ndata: {"heartbeat_interval_ms":15000}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(
      'id: 1-abc\nevent: clipboard.updated\ndata: {"content":"839201","raw_text":"code 839201","type":"verification_code"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };

  const result = await runSubscriber(
    {
      url: 'http://example.test',
      token: 'secret',
      once: true,
      raw: false,
      clipboard: false,
      notify: false,
      idleTimeoutSeconds: 30,
      quiet: true,
    },
    {
      fetchImpl,
      sleep: async () => {},
      writeClipboard: () => ({ ok: true }),
      sendNotification: () => {},
      logger: { log() {}, warn() {} },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['X-DCC-Token'], 'secret');
  assert.equal(calls[1].headers['Last-Event-ID'], undefined);
  assert.equal(result.reason, 'update');
  assert.equal(result.data.content, '839201');
});

test('runSubscriber sends Last-Event-ID on reconnect after receiving an id', async () => {
  const calls = [];
  let sleeps = 0;
  const fetchImpl = async (url, { headers }) => {
    calls.push(headers);
    if (calls.length === 1) {
      return new Response(
        'retry: 1\n\nid: 9-old\nevent: ready\ndata: {}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(
      'event: clipboard.updated\ndata: {"content":"second","raw_text":"second"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };

  await assert.rejects(
    runSubscriber(
      {
        url: 'http://example.test',
        token: 'secret',
        once: false,
        raw: false,
        clipboard: false,
        notify: false,
        idleTimeoutSeconds: 30,
        quiet: true,
      },
      {
        fetchImpl,
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= 2) throw new Error('stop test loop');
        },
        writeClipboard: () => ({ ok: true }),
        sendNotification: () => {},
        logger: { log() {}, warn() {} },
      },
    ),
    /stop test loop/,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1]['Last-Event-ID'], '9-old');
});

test('runSubscriber treats authentication failures as fatal', async () => {
  await assert.rejects(
    runSubscriber(
      {
        url: 'http://example.test',
        token: 'secret',
        once: true,
        raw: false,
        clipboard: false,
        notify: false,
        idleTimeoutSeconds: 30,
        quiet: true,
      },
      {
        fetchImpl: async () => new Response('', { status: 401 }),
        sleep: async () => {},
        writeClipboard: () => ({ ok: true }),
        sendNotification: () => {},
        logger: { log() {}, warn() {} },
      },
    ),
    /Authentication failed/,
  );
});
