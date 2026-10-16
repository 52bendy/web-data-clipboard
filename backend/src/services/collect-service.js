import { randomInt as cryptoRandomInt } from 'node:crypto';

/**
 * Collect pipeline (REQ-202610-1253, PRD §4.1.1): validate a device report,
 * run the extraction engine (REQ-202610-1254), update the network clipboard
 * (REQ-202610-1255) and trigger async dispatch (REQ-202610-1258). Transport
 * concerns stay in `api/v1/collect.js`.
 */

/** Earliest plausible device timestamp: 2000-01-01T00:00:00Z. */
const MIN_TIMESTAMP_MS = 946684800000;
/** Devices may run up to 24h ahead of the server clock (skew tolerance). */
const MAX_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const PLATFORMS = ['android', 'ios'];
const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_SENDER_LENGTH = 64;
export const DEFAULT_MAX_RAW_CONTENT_LENGTH = 4096;

/**
 * `col_` + server epoch-ms + 6 random digits: unique per accepted collection,
 * roughly sortable by time, and shaped like the §4.1.1 example (`col_<digits>`).
 */
export function newCollectionId(
  nowMs,
  randomInt = (min, max) => cryptoRandomInt(min, max),
) {
  return `col_${nowMs}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

/**
 * Validates the §4.1.1 request body. Returns `{ ok: true, value }` with the
 * normalized payload, or `{ ok: false, message }` for a 400 response.
 */
export function validateCollectPayload(
  body,
  { maxRawContentLength = DEFAULT_MAX_RAW_CONTENT_LENGTH, now = Date.now() } = {},
) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object.' };
  }
  const {
    device_id: deviceId,
    device_name: deviceName,
    platform,
    sender,
    raw_content: rawContent,
    timestamp,
  } = body;

  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    return {
      ok: false,
      message:
        'device_id must be 1-128 characters of letters, digits or . _ : @ -.',
    };
  }
  if (
    typeof deviceName !== 'string' ||
    deviceName.trim().length === 0 ||
    deviceName.length > MAX_DEVICE_NAME_LENGTH
  ) {
    return {
      ok: false,
      message: `device_name must be a non-empty string of at most ${MAX_DEVICE_NAME_LENGTH} characters.`,
    };
  }
  if (!PLATFORMS.includes(platform)) {
    return { ok: false, message: 'platform must be one of: android, ios.' };
  }
  // sender is optional: the iOS shortcut cannot always resolve it (PRD §6.1).
  if (
    sender !== undefined &&
    sender !== null &&
    (typeof sender !== 'string' || sender.length > MAX_SENDER_LENGTH)
  ) {
    return {
      ok: false,
      message: `sender must be a string of at most ${MAX_SENDER_LENGTH} characters.`,
    };
  }
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { ok: false, message: 'raw_content must be a non-empty string.' };
  }
  if (rawContent.length > maxRawContentLength) {
    return {
      ok: false,
      message: `raw_content must be at most ${maxRawContentLength} characters.`,
    };
  }
  if (
    !Number.isInteger(timestamp) ||
    timestamp < MIN_TIMESTAMP_MS ||
    timestamp > now + MAX_TIMESTAMP_SKEW_MS
  ) {
    return {
      ok: false,
      message:
        'timestamp must be an integer epoch-millisecond value within a plausible range.',
    };
  }

  return {
    ok: true,
    value: {
      device_id: deviceId,
      device_name: deviceName.trim(),
      platform,
      sender: typeof sender === 'string' ? sender : '',
      raw_content: rawContent,
      timestamp,
    },
  };
}

/**
 * @param {object} deps
 * @param {{ write: Function }} deps.clipboardStore REQ-202610-1255 store.
 * @param {(text: string) => { extracted_code: string | null, type: string }} deps.extract
 * @param {(record: object, context: object) => Promise<unknown>} [deps.dispatch]
 * @param {object} [deps.logger]
 */
export function createCollectService({
  clipboardStore,
  extract,
  dispatch = async () => ({ dispatched: 0 }),
  logger = null,
  maxRawContentLength = DEFAULT_MAX_RAW_CONTENT_LENGTH,
  now = Date.now,
  randomInt,
} = {}) {
  async function ingest(payload) {
    const collectionId = newCollectionId(now(), randomInt);
    const log = (event, fields) =>
      logger?.info(event, {
        collection_id: collectionId,
        device_id: payload.device_id,
        ...fields,
      });

    log('collect.received', {
      platform: payload.platform,
      client_timestamp: payload.timestamp,
    });

    const extraction = extract(payload.raw_content);
    log('collect.extracted', {
      extracted_code: extraction.extracted_code,
      type: extraction.type,
    });

    const record = await clipboardStore.write({
      full_text: payload.raw_content,
      parsed_code: extraction.extracted_code,
      data_type: extraction.type,
      source: {
        device_name: payload.device_name,
        platform: payload.platform,
      },
    });
    log('collect.clipboard_updated', { clipboard_id: record.clipboard_id });

    // Fire-and-forget (§4.1.1 step 4): downstream delivery must neither block
    // nor fail the device report; the dispatcher records its own failures.
    void Promise.resolve(
      dispatch(record, {
        collection_id: collectionId,
        device_id: payload.device_id,
      }),
    ).catch((error) => {
      logger?.error('collect.dispatch_failed', {
        collection_id: collectionId,
        error: String(error),
      });
    });

    log('collect.responded', { clipboard_updated: true });
    return {
      collection_id: collectionId,
      extracted_code: extraction.extracted_code,
      clipboard_updated: true,
    };
  }

  return { ingest, maxRawContentLength };
}
