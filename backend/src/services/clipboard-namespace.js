/**
 * Clipboard namespaces (REQ-202610-1276).
 *
 * A namespace is an isolated clipboard: each one has its own `latest` record
 * and history. The SMS collector writes to `default`, while API projects can
 * use their own namespace (or a shared one) without overwriting SMS data.
 * Names are case-sensitive and restricted to a URL/key-safe alphabet so they
 * can be embedded in storage keys and query strings without escaping.
 */

export const DEFAULT_NAMESPACE = 'default';
export const MAX_NAMESPACE_LENGTH = 64;

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validation error with a stable `code` for API layers to map. */
export class ClipboardNamespaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClipboardNamespaceError';
    this.code = 'invalid_namespace';
  }
}

/**
 * Normalizes a namespace value. Missing/empty values fall back to `default`
 * so existing clients that never send a namespace keep working unchanged.
 *
 * @param {unknown} value
 * @param {{ field?: string }} [options]
 * @returns {string}
 */
export function normalizeNamespace(value, { field = 'namespace' } = {}) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_NAMESPACE;
  }
  if (typeof value !== 'string') {
    throw new ClipboardNamespaceError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_NAMESPACE;
  if (
    trimmed.length > MAX_NAMESPACE_LENGTH ||
    !NAMESPACE_PATTERN.test(trimmed)
  ) {
    throw new ClipboardNamespaceError(
      `${field} must be 1-${MAX_NAMESPACE_LENGTH} characters of letters, digits or . _ - and start with a letter or digit.`,
    );
  }
  return trimmed;
}

/** True when `value` is an already-normalized, valid namespace. */
export function isNamespace(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_NAMESPACE_LENGTH &&
    NAMESPACE_PATTERN.test(value)
  );
}

/** Storage key of a namespace's latest record (default keeps legacy keys). */
export function latestKey(namespace = DEFAULT_NAMESPACE) {
  return namespace === DEFAULT_NAMESPACE
    ? 'clipboard:latest'
    : `clipboard:latest:${namespace}`;
}

/** Storage key of a namespace's history log. */
export function historyKey(namespace = DEFAULT_NAMESPACE) {
  return namespace === DEFAULT_NAMESPACE
    ? 'clipboard:history'
    : `clipboard:history:${namespace}`;
}

/** Index of known namespaces, used by maintenance and the admin UI. */
export const NAMESPACES_KEY = 'clipboard:namespaces';
