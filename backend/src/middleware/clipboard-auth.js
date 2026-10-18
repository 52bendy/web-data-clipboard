import { createHash, timingSafeEqual } from 'node:crypto';
import { errorResponse } from './errors.js';

const digest = (value) => createHash('sha256').update(value).digest();

const MASTER_PRINCIPAL = Object.freeze({
  kind: 'master',
  name: 'system',
  project: null,
  label: 'system',
  collector: 'api',
  namespaces: Object.freeze(['*']),
  permissions: Object.freeze(['read', 'write']),
});

/**
 * Multi-source clipboard authentication (REQ-202610-1276).
 *
 * The original `API_SECRET_TOKEN` remains a system credential with access to
 * every namespace and project. Additional project-scoped credentials come from
 * `CLIPBOARD_TOKENS`; each is limited to its project and an explicit namespace
 * list. Every candidate digest is compared in constant time, and the header is
 * the only accepted channel (defect 21).
 *
 * @returns {{ok: true, principal: object} | {ok: false, response: Response}}
 */
export function authenticateClipboardRequest(request, config = {}) {
  const supplied = request.headers?.['x-dcc-token'] ?? '';
  if (
    typeof supplied !== 'string' ||
    supplied.length === 0 ||
    supplied.length > 4096
  ) {
    return { ok: false, response: errorResponse(401) };
  }

  const suppliedDigest = digest(supplied);
  let matched = null;
  const masterToken = config.apiSecretToken || '';
  if (masterToken) {
    const masterDigest = digest(masterToken);
    if (timingSafeEqual(suppliedDigest, masterDigest)) {
      matched = MASTER_PRINCIPAL;
    }
  }
  for (const candidate of config.clipboard?.tokens ?? []) {
    const candidateDigest = digest(candidate.token || '');
    if (timingSafeEqual(suppliedDigest, candidateDigest)) {
      matched = {
        kind: 'project',
        name: candidate.name ?? candidate.project,
        project: candidate.project,
        label: candidate.label ?? candidate.project,
        collector: candidate.collector ?? 'api',
        namespaces: [...(candidate.namespaces ?? ['default'])],
        permissions: [...(candidate.permissions ?? ['read', 'write'])],
      };
    }
  }

  if (!matched) return { ok: false, response: errorResponse(401) };
  return { ok: true, principal: matched };
}

export function principalCan(principal, permission) {
  return (
    principal?.kind === 'master' ||
    (principal?.permissions ?? []).includes(permission)
  );
}

export function principalCanAccessNamespace(principal, namespace) {
  if (principal?.kind === 'master') return true;
  const allowed = principal?.namespaces ?? [];
  return allowed.includes('*') || allowed.includes(namespace);
}

/**
 * Returns a 403 response when the principal cannot perform `permission` in
 * `namespace`, otherwise null.
 */
export function checkNamespacePermission(principal, namespace, permission) {
  if (!principalCanAccessNamespace(principal, namespace)) {
    return errorResponse(
      403,
      'Token is not allowed to access this namespace.',
    );
  }
  if (!principalCan(principal, permission)) {
    return errorResponse(
      403,
      `Token is not allowed to ${permission} this namespace.`,
    );
  }
  return null;
}

/** Project-scoped tokens may only write records attributed to their project. */
export function checkProjectPermission(principal, project) {
  if (principal?.kind === 'master') return null;
  if (principal.project !== project) {
    return errorResponse(
      403,
      'Token is not allowed to write for this project.',
    );
  }
  return null;
}

export { MASTER_PRINCIPAL };
