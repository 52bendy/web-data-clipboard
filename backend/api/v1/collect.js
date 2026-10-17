import { getConfig } from '../../src/config.js';
import { authorize } from '../../src/middleware/auth.js';
import { errorResponse } from '../../src/middleware/errors.js';
import { extractCode } from '../../src/services/code-extractor.js';
import {
  createCollectService,
  validateCollectPayload,
  DEFAULT_MAX_RAW_CONTENT_LENGTH,
} from '../../src/services/collect-service.js';
import { dispatcher } from '../../src/services/webhook-dispatcher.js';
import { createLogger } from '../../src/utils/logger.js';
import { ok } from '../../src/utils/respond.js';

/**
 * POST /api/v1/collect (PRD §4.1.1): auth → validation → extraction →
 * clipboard update → async dispatch → response.
 *
 * The handler takes a Node-style request (plain `headers`, async-iterable
 * body) and returns a Web `Response`, matching the shared route-table
 * signature the security middleware (REQ-202610-1252) introduces.
 */
export function createCollectHandler({
  config = getConfig(),
  services,
  dispatch = services?.dispatcher?.dispatch.bind(services.dispatcher) ??
    dispatcher.dispatch.bind(dispatcher),
  logger = createLogger(),
  now = Date.now,
  randomInt,
} = {}) {
  const collectService = createCollectService({
    clipboardStore: services.clipboardStore,
    extract: (text) =>
      extractCode(text, { autoExtract: config.autoExtract !== false }),
    dispatch,
    logger,
    maxRawContentLength:
      config.collect?.maxRawContentLength ?? DEFAULT_MAX_RAW_CONTENT_LENGTH,
    now,
    randomInt,
  });
  const maxBodyBytes = config.collect?.maxBodyBytes ?? 64 * 1024;

  return async function handleCollect(request) {
    if (request.method !== 'POST') {
      return errorResponse(405);
    }
    const denied = authorize(request, config.apiSecretToken);
    if (denied) {
      logger.warn('collect.unauthorized', { path: '/api/v1/collect' });
      return denied;
    }

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
    if (text === null) {
      return errorResponse(413);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      logger.warn('collect.invalid_json', {});
      return errorResponse(400, 'request body must be valid JSON.');
    }

    const validation = validateCollectPayload(body, {
      maxRawContentLength: collectService.maxRawContentLength,
      now: now(),
    });
    if (!validation.ok) {
      logger.warn('collect.invalid_payload', { reason: validation.message });
      return errorResponse(400, validation.message);
    }

    try {
      const data = await collectService.ingest(validation.value);
      return ok(data, 'Data collected successfully');
    } catch (error) {
      logger.error('collect.failed', { error: String(error) });
      return errorResponse(500);
    }
  };
}

/** Reads the body with a byte cap; returns null when the cap is exceeded. */
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
