import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlockedHostname,
  isBlockedIp,
  validateWebhookUrl,
  WebhookTargetError,
} from '../src/services/webhook-target.js';

const publicResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

test('accepts a public https target', async () => {
  const url = await validateWebhookUrl(
    'https://example.com/hooks/dcc?source=test',
    { resolveHost: publicResolver },
  );
  assert.equal(url.toString(), 'https://example.com/hooks/dcc?source=test');
});

test('rejects non-https, credentials, malformed and oversized urls', async () => {
  const cases = [
    ['http://example.com/hook', /https/],
    ['ftp://example.com/hook', /https/],
    ['not a url', /valid absolute URL/],
    ['', /non-empty/],
    [42, /non-empty/],
    [`https://example.com/${'a'.repeat(2100)}`, /at most 2048/],
    ['https://user:pass@example.com/hook', /credentials/],
  ];
  for (const [value, pattern] of cases) {
    await assert.rejects(
      validateWebhookUrl(value, { resolveHost: publicResolver }),
      (error) =>
        error instanceof WebhookTargetError && pattern.test(error.message),
      String(value),
    );
  }
});

test('rejects loopback, private and reserved IP literals', async () => {
  const blocked = [
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://172.16.1.1/hook',
    'https://192.168.0.10/hook',
    'https://169.254.1.1/hook',
    'https://100.64.0.1/hook',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[fc00::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ];
  for (const value of blocked) {
    await assert.rejects(
      validateWebhookUrl(value, { resolveHost: publicResolver }),
      (error) => error.code === 'blocked_target',
      value,
    );
  }
});

test('rejects local and single-label hostnames', async () => {
  for (const host of ['localhost', 'api.local', 'service.internal']) {
    assert.equal(isBlockedHostname(host), true, host);
    await assert.rejects(
      validateWebhookUrl(`https://${host}/hook`, {
        resolveHost: publicResolver,
      }),
      (error) => error.code === 'blocked_target',
      host,
    );
  }
  assert.equal(isBlockedHostname('example.com'), false);
  await assert.rejects(
    validateWebhookUrl('https://intranet/hook', {
      resolveHost: publicResolver,
    }),
    (error) => error.code === 'blocked_target',
  );
});

test('rejects hostnames that resolve to private addresses', async () => {
  const resolvers = [
    async () => [{ address: '10.0.0.1', family: 4 }],
    async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '::1', family: 6 },
    ],
  ];
  for (const resolveHost of resolvers) {
    await assert.rejects(
      validateWebhookUrl('https://rebind.example.com/hook', { resolveHost }),
      (error) => error.code === 'blocked_target',
    );
  }
  await assert.rejects(
    validateWebhookUrl('https://empty.example.com/hook', {
      resolveHost: async () => [],
    }),
    (error) => error.code === 'dns_error',
  );
  await assert.rejects(
    validateWebhookUrl('https://nxdomain.example.com/hook', {
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
    }),
    (error) => error.code === 'dns_error',
  );
});

test('IP classification covers IPv4 and IPv6 reserved ranges', () => {
  const cases = [
    ['127.0.0.1', true],
    ['8.8.8.8', false],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['198.51.100.7', true],
    ['203.0.113.7', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['2001:db8::1', true],
    ['2400:cb00::1', false],
    ['::ffff:192.168.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['64:ff9b::10.0.0.1', true],
    ['not-an-ip', true],
  ];
  for (const [address, expected] of cases) {
    assert.equal(isBlockedIp(address), expected, address);
  }
});
