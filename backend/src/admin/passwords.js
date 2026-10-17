import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const HASH_PREFIX = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const PLAINTEXT_SALT = Buffer.from('dcc-admin-plaintext-salt-v1');

/**
 * Derives a storable scrypt hash: `scrypt$<salt base64url>$<hash base64url>`.
 * Salts are random per password so equal passwords do not produce equal hashes.
 */
export async function hashPassword(
  password,
  { salt = randomBytes(SALT_BYTES) } = {},
) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }
  const derived = await scrypt(password, salt, KEY_BYTES);
  return `${HASH_PREFIX}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** Parses and validates the `ADMIN_PASSWORD_HASH` format. */
export function parsePasswordHash(value) {
  const parts = String(value || '').split('$');
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) {
    throw new Error(
      'ADMIN_PASSWORD_HASH must use the scrypt$<salt>$<hash> format.',
    );
  }
  const salt = Buffer.from(parts[1], 'base64url');
  const hash = Buffer.from(parts[2], 'base64url');
  if (salt.length < 8 || hash.length < 32) {
    throw new Error('ADMIN_PASSWORD_HASH contains an invalid salt or hash.');
  }
  return { salt, hash };
}

/**
 * Builds a constant-time password verifier. When `passwordHash` is set it is
 * authoritative; `password` is a local-development fallback. Returns null when
 * neither is configured, which the admin layer treats as fail-closed.
 */
export function createPasswordVerifier({
  passwordHash = '',
  password = '',
} = {}) {
  if (passwordHash) {
    const parsed = parsePasswordHash(passwordHash);
    return {
      async verify(candidate) {
        const derived = await scrypt(
          String(candidate ?? ''),
          parsed.salt,
          parsed.hash.length,
        );
        return timingSafeEqual(derived, parsed.hash);
      },
    };
  }
  if (password) {
    const expected = scryptSync(password, PLAINTEXT_SALT, KEY_BYTES);
    return {
      async verify(candidate) {
        const derived = await scrypt(
          String(candidate ?? ''),
          PLAINTEXT_SALT,
          KEY_BYTES,
        );
        return timingSafeEqual(derived, expected);
      },
    };
  }
  return null;
}

/** Constant-time comparison for identifiers (usernames) of any length. */
export function safeEqualText(left, right) {
  const leftDigest = createHash('sha256')
    .update(String(left ?? ''))
    .digest();
  const rightDigest = createHash('sha256')
    .update(String(right ?? ''))
    .digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
