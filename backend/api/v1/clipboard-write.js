import { getConfig } from '../../src/config.js';
import {
  authenticateClipboardRequest,
  checkNamespacePermission,
  checkProjectPermission,
} from '../../src/middleware/clipboard-auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import { rejectQueryToken } from '../../src/middleware/queryToken.js';
import { normalizeNamespace } from '../../src/services/clipboard-namespace.js';
import {
  ClipboardEntryError,
  MAX_FULL_TEXT_LENGTH,
} from '../../src/services/clipboard-store.js';
import {
  ClipboardWriteError,
  createClipboardWriteService,
  validateClipboardWrite,
} from '../../src/services/clipboard-write-service.js';
import { createLogger } from '../../src/utils/logger.js';
import { ok } from '../../src/utils/respond.js';

/**
 * POST /api/v1/clipboard/write (REQ-202610-1276).
 *
 * General-purpose write endpoint for non-SMS sources. A project-scoped token
 * may write text, links or arbitrary JSON into one of its namespaces; the
 * system `API_SECRET_TOKEN` may write anywhere. Every accepted write is also
 * appended to the collection log so the admin can display and filter sources.
 */
export function createClipboardWriteHandler({
  config = getConfig(),
  services,
  logger = createLogger(),
  now = Date.now,
  randomInt,
} = {}) {
  const writeService = createClipboardWriteService({
    clipboardStore: services.clipboardStore,
    collectionLogStore: services.collectionLogStore,
    config,
    now,
    randomInt,
    logger,
  });
  const maxBodyBytes = config.clipboard?.maxWriteBodyBytes ?? 64 * 1024;
  const maxContentLength =
    config.clipboard?.maxContentLength ?? MAX_FULL_TEXT_LENGTH;

  return async function handleClipboardWrite(request, url) {
    if (request.method !== 'POST') return errorResponse(405);

    const parsedUrl =
      url ??
      new URL(
        request.url ?? '/',
        `http://${request.headers.host || 'localhost'}`,
      );
    const queryTokenDenied = rejectQueryToken(parsedUrl);
    if (queryTokenDenied) return queryTokenDenied;

    const auth = authenticateClipboardRequest(request, config);
    if (!auth.ok) return auth.response;

    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return errorResponse(413);
    }
    let text;
    try {
      text = await readBody(request, maxBodyBytes);
    } catch {
      return errorResponse(400, 'request body could not be read.');
    }
    if (text === null) return errorResponse(413);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(400, 'request body must be valid JSON.');
    }

    // Namespace permission is checked before any storage access. The body is
    // validated once here to resolve defaults, then the service validates the
    // same immutable object again when it writes.
    let value;
    try {
      const namespace = normalizeNamespace(body?.namespace);
      const denied = checkNamespacePermission(
        auth.principal,
        namespace,
        'write',
      );
      if (denied) return denied;
      value = validateClipboardWrite(body, {
        principal: auth.principal,
        maxContentLength,
      });
      const projectDenied = checkProjectPermission(
        auth.principal,
        value.project,
      );
      if (projectDenied) return projectDenied;
    } catch (error) {
      if (
        error instanceof ClipboardWriteError ||
        error.name === 'ClipboardNamespaceError'
      ) {
        return errorResponse(400, error.message);
      }
      logger.error('clipboard.write_validation_failed', {
        error: String(error),
      });
      return errorResponse(500);
    }

    try {
      const data = await writeService.write({
        body,
        principal: auth.principal,
      });
      return ok(data, 'Clipboard updated');
    } catch (error) {
      if (
        error instanceof ClipboardWriteError ||
        error instanceof ClipboardEntryError ||
        error.name === 'ClipboardNamespaceError'
      ) {
        return errorResponse(400, error.message);
      }
      logger.error('clipboard.write_failed', { error: String(error) });
      return errorResponse(500);
    }
  };
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
