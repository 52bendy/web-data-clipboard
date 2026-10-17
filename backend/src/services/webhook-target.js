import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsCallbackLookup } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Outbound Webhook target validation (REQ-202610-1258 / defect 22):
 * only https, no credentials in the URL, and no loopback, private, link-local
 * or otherwise reserved addresses — neither as an IP literal nor as the
 * result of DNS resolution (which also covers rebinding at connect time).
 */
export class WebhookTargetError extends Error {
  constructor(message, code = 'invalid_webhook_url') {
    super(message);
    this.name = 'WebhookTargetError';
    this.code = code;
  }
}

const MAX_URL_LENGTH = 2048;
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
];

function ipv4ToNumber(address) {
  const [a, b, c, d] = address.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([address, bits]) => ({
  base: ipv4ToNumber(address),
  mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0,
}));

function isBlockedIpv4(address) {
  const value = ipv4ToNumber(address);
  return BLOCKED_IPV4_RANGES.some(
    (range) => (value & range.mask) >>> 0 === range.base,
  );
}

function ipv6ToBigInt(address) {
  let input = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = input.indexOf('%');
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);

  const v4Match = input.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4 = ipv4ToNumber(v4Match[1]);
    input = `${input.slice(0, -v4Match[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const [left, right] = input.split('::');
  const leftGroups = left ? left.split(':').filter(Boolean) : [];
  const rightGroups =
    right !== undefined && right !== '' ? right.split(':').filter(Boolean) : [];
  const missing =
    right === undefined ? 0 : 8 - leftGroups.length - rightGroups.length;
  const groups = [
    ...leftGroups,
    ...Array(Math.max(0, missing)).fill('0'),
    ...rightGroups,
  ];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(parseInt(group || '0', 16));
  }
  return value;
}

function isBlockedIpv6(address) {
  const value = ipv6ToBigInt(address);
  if (value === 0n || value === 1n) return true; // :: and ::1
  if (value >> 121n === 0x7en) return true; // fc00::/7 unique local
  if (value >> 118n === 0x3fan) return true; // fe80::/10 link local
  if (value >> 120n === 0xffn) return true; // ff00::/8 multicast
  if (value >> 96n === 0x20010db8n) return true; // 2001:db8::/32 docs
  if (value >> 64n === 0x100n) return true; // 100::/64 discard-only

  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) embed an IPv4
  // address; validate the embedded address rather than trusting the wrapper.
  if (value >> 32n === 0xffffn || value >> 96n === 0x64ff9bn) {
    const embedded = value & 0xffffffffn;
    const v4 = [
      Number((embedded >> 24n) & 0xffn),
      Number((embedded >> 16n) & 0xffn),
      Number((embedded >> 8n) & 0xffn),
      Number(embedded & 0xffn),
    ].join('.');
    return isBlockedIpv4(v4);
  }
  return false;
}

/** Returns true for loopback, private, link-local and reserved addresses. */
export function isBlockedIp(address) {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

export function normalizeHostname(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

const MAX_ALLOWED_HOST_LENGTH = 253;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class WebhookAllowlistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookAllowlistError';
    this.code = 'invalid_allowlist';
  }
}

function isValidHostname(value) {
  if (value.length === 0 || value.length > MAX_ALLOWED_HOST_LENGTH) {
    return false;
  }
  const labels = value.split('.');
  // Webhook targets must be fully qualified, so a single-label allowlist
  // entry could never match; reject it as a configuration error.
  if (labels.length < 2) return false;
  return labels.every((label) => HOST_LABEL_PATTERN.test(label));
}

/**
 * Normalizes one allowlist entry: a public hostname, an IP literal, or a
 * `*.example.com` wildcard that matches one or more subdomain labels.
 */
export function normalizeAllowedHost(entry) {
  if (typeof entry !== 'string') {
    throw new WebhookAllowlistError('allowlist entries must be strings.');
  }
  const value = normalizeHostname(entry.trim());
  if (value === '') {
    throw new WebhookAllowlistError('allowlist entries must not be empty.');
  }
  if (value.startsWith('*.')) {
    const suffix = value.slice(2);
    if (isIP(suffix) || !isValidHostname(suffix)) {
      throw new WebhookAllowlistError(
        `invalid wildcard allowlist entry: ${entry}`,
      );
    }
    return `*.${suffix}`;
  }
  if (value.includes('*')) {
    throw new WebhookAllowlistError(`invalid allowlist entry: ${entry}`);
  }
  if (!isIP(value) && !isValidHostname(value)) {
    throw new WebhookAllowlistError(
      `allowlist entry must be a hostname, IP literal or *.domain wildcard: ${entry}`,
    );
  }
  return value;
}

/** Normalizes and de-duplicates a list of allowlist entries. */
export function normalizeAllowedHosts(entries = []) {
  if (!Array.isArray(entries)) {
    throw new WebhookAllowlistError('allowlist must be an array.');
  }
  return [...new Set(entries.map(normalizeAllowedHost))];
}

/**
 * Returns true when the hostname is allowed. An empty allowlist means the
 * allowlist is disabled (every otherwise-valid public target is allowed).
 */
export function isHostAllowed(hostname, allowedHosts = []) {
  const normalized = normalizeHostname(hostname);
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return true;
  return allowedHosts.some((entry) => {
    const pattern = normalizeHostname(entry);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return normalized === pattern;
  });
}

export function isBlockedHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Default resolver: all A/AAAA records for a hostname. */
export async function resolvePublicHost(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/**
 * Validates a Webhook URL and resolves its hostname, rejecting targets that
 * point at private or reserved networks. When `allowedHosts` is non-empty,
 * the hostname must also match the configured allowlist. `resolveHost` is
 * injectable for deterministic tests.
 *
 * @returns {Promise<URL>} the parsed URL
 * @throws {WebhookTargetError}
 */
export async function validateWebhookUrl(
  rawUrl,
  { resolveHost = resolvePublicHost, allowedHosts = [] } = {},
) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new WebhookTargetError('url must be a non-empty string.');
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new WebhookTargetError(
      `url must be at most ${MAX_URL_LENGTH} characters.`,
    );
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookTargetError('url must be a valid absolute URL.');
  }
  if (url.protocol !== 'https:') {
    throw new WebhookTargetError('url must use https.');
  }
  if (url.username || url.password) {
    throw new WebhookTargetError('url must not contain credentials.');
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new WebhookTargetError('url must include a hostname.');
  }
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new WebhookTargetError(
        'url must not point at a loopback, private or reserved address.',
        'blocked_target',
      );
    }
    if (!isHostAllowed(hostname, allowedHosts)) {
      throw new WebhookTargetError(
        'url hostname is not in the configured allowlist.',
        'host_not_allowed',
      );
    }
    return url;
  }
  if (isBlockedHostname(hostname)) {
    throw new WebhookTargetError(
      'url must not point at a local or internal hostname.',
      'blocked_target',
    );
  }
  // Single-label names can only resolve through local search domains.
  if (!hostname.includes('.')) {
    throw new WebhookTargetError(
      'url must use a fully qualified public hostname.',
      'blocked_target',
    );
  }
  if (!isHostAllowed(hostname, allowedHosts)) {
    throw new WebhookTargetError(
      'url hostname is not in the configured allowlist.',
      'host_not_allowed',
    );
  }
  let addresses;
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new WebhookTargetError(
      'url hostname could not be resolved.',
      'dns_error',
    );
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) {
    throw new WebhookTargetError(
      'url hostname could not be resolved.',
      'dns_error',
    );
  }
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (!address || isBlockedIp(address)) {
      throw new WebhookTargetError(
        'url resolves to a loopback, private or reserved address.',
        'blocked_target',
      );
    }
  }
  return url;
}

/**
 * `https.request` lookup hook: every DNS answer is checked at connect time,
 * closing the DNS-rebinding window between config validation and delivery.
 */
export function safeLookup(hostname, options, callback) {
  dnsCallbackLookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    if (Array.isArray(address)) {
      for (const entry of address) {
        if (isBlockedIp(entry.address)) {
          return callback(
            new WebhookTargetError(
              'url resolves to a loopback, private or reserved address.',
              'blocked_target',
            ),
          );
        }
      }
      return callback(null, address, family);
    }
    if (isBlockedIp(address)) {
      return callback(
        new WebhookTargetError(
          'url resolves to a loopback, private or reserved address.',
          'blocked_target',
        ),
      );
    }
    return callback(null, address, family);
  });
}
