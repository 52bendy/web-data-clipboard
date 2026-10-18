import { newCollectionId } from './collect-service.js';
import { buildClipboardPayload } from './clipboard-payload.js';
import { normalizeNamespace } from './clipboard-namespace.js';
import { DEFAULT_TTL_MS, MAX_FULL_TEXT_LENGTH } from './clipboard-store.js';

/** General clipboard write types (REQ-202610-1276). */
export const WRITE_TYPES = ['text', 'link', 'json'];
export const MAX_PROJECT_LENGTH = 128;
export const MAX_SOURCE_DEVICE_LENGTH = 128;
export const MAX_PLATFORM_LENGTH = 32;

export class ClipboardWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClipboardWriteError';
    this.code = 'invalid_write';
  }
}

function optionalString(value, field, { max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    throw new ClipboardWriteError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (trimmed.length > max) {
    throw new ClipboardWriteError(
      `${field} must be at most ${max} characters.`,
    );
  }
  return trimmed;
}

/**
 * Validates a `POST /api/v1/clipboard/write` body. `principal` supplies the
 * defaults for project/label/device and the collector tag, so a project-scoped
 * token cannot accidentally impersonate another project.
 */
export function validateClipboardWrite(body, { principal, maxContentLength }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ClipboardWriteError('request body must be a JSON object.');
  }
  const type = body.type ?? 'text';
  if (!WRITE_TYPES.includes(type)) {
    throw new ClipboardWriteError(
      'type must be one of: text, link, json.',
    );
  }
  if (body.content === undefined) {
    throw new ClipboardWriteError('content is required.');
  }

  let namespace;
  try {
    namespace = normalizeNamespace(body.namespace);
  } catch (error) {
    throw new ClipboardWriteError(error.message);
  }
  const project = optionalString(body.project, 'project', {
    max: MAX_PROJECT_LENGTH,
    fallback: principal?.project ?? 'api',
  });
  const label = optionalString(body.label, 'label', {
    max: MAX_PROJECT_LENGTH,
    fallback: principal?.label ?? project,
  });
  const sourceDevice = optionalString(body.source_device, 'source_device', {
    max: MAX_SOURCE_DEVICE_LENGTH,
    fallback: principal?.name ?? project,
  });
  const platform = optionalString(body.platform, 'platform', {
    max: MAX_PLATFORM_LENGTH,
    fallback: 'api',
  });

  let content;
  let fullText;
  let contentJson;
  if (type === 'json') {
    try {
      fullText = JSON.stringify(body.content, null, 2);
    } catch {
      throw new ClipboardWriteError('content must be valid JSON.');
    }
    if (fullText === undefined) {
      throw new ClipboardWriteError('content must be valid JSON.');
    }
    content = body.content;
    contentJson = body.content;
  } else {
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      throw new ClipboardWriteError(
        `content must be a non-empty string for type ${type}.`,
      );
    }
    fullText = body.content;
    content = body.content;
  }

  if (fullText.length > maxContentLength) {
    throw new ClipboardWriteError(
      `content must be at most ${maxContentLength} characters.`,
    );
  }
  if (type === 'link') {
    let url;
    try {
      url = new URL(content);
    } catch {
      throw new ClipboardWriteError('content must be a valid URL for type link.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ClipboardWriteError(
        'content must use the http or https scheme for type link.',
      );
    }
  }

  return {
    content,
    contentJson,
    fullText,
    type,
    namespace,
    project,
    label,
    sourceDevice,
    platform,
  };
}

/**
 * Persists general API writes and mirrors them into the collection log so the
 * admin can display/filter every source in one place. Log failures are
 * contained: the clipboard write is already durable and must not be rolled
 * back because an audit append failed.
 */
export function createClipboardWriteService({
  clipboardStore,
  collectionLogStore = null,
  config = {},
  now = Date.now,
  randomInt,
  logger = null,
} = {}) {
  if (!clipboardStore) {
    throw new Error(
      'createClipboardWriteService requires services.clipboardStore',
    );
  }
  const ttlMs = config.clipboard?.ttlMs ?? DEFAULT_TTL_MS;
  const maxContentLength =
    config.clipboard?.maxContentLength ?? MAX_FULL_TEXT_LENGTH;

  async function write({ body, principal }) {
    const value = validateClipboardWrite(body, {
      principal,
      maxContentLength,
    });
    const record = await clipboardStore.write(
      {
        full_text: value.fullText,
        parsed_code: null,
        data_type: value.type,
        content_json: value.contentJson,
        source: {
          device_name: value.sourceDevice,
          platform: value.platform,
          project: value.project,
          label: value.label,
          collector: principal?.collector ?? 'api',
        },
      },
      { namespace: value.namespace },
    );

    let collectionId = null;
    if (collectionLogStore) {
      collectionId = newCollectionId(now(), randomInt);
      try {
        await collectionLogStore.append({
          collection_id: collectionId,
          device_id: `api:${value.project}`,
          device_name: value.sourceDevice,
          platform: value.platform,
          sender: '',
          raw_content: value.fullText,
          extracted_code: null,
          data_type: value.type,
          status: 'written',
          client_timestamp: null,
          collector: principal?.collector ?? 'api',
          source_project: value.project,
          source_label: value.label,
          namespace: value.namespace,
          received_at: record.received_at,
        });
      } catch (error) {
        logger?.error('clipboard.write_log_failed', {
          clipboard_id: record.clipboard_id,
          error: String(error),
        });
      }
    }

    const payload = buildClipboardPayload(record, {
      ttlMs,
      nowMs: now(),
    });
    return {
      ...payload,
      clipboard_id: record.clipboard_id,
      received_at: record.received_at,
      collection_id: collectionId,
    };
  }

  return { write, maxContentLength };
}
