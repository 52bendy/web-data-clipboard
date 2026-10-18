import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { createSseParser } from './lib/sse-parser.js';
import {
  notifyDesktop,
  writeSystemClipboard,
} from './lib/system-integration.js';

const DEFAULT_URL = 'http://localhost:3000';
const DEFAULT_RETRY_MS = 3_000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 60;
const MAX_NOTIFICATION_BODY = 300;

const HELP = `Realtime SSE clipboard subscriber for the DCC API (PRD §10 Phase 2).

Usage:
  node backend/scripts/sse-subscribe.js [options]

Options:
  --url <base>          Backend base URL (default: $DCC_URL or ${DEFAULT_URL})
  --token <token>       X-DCC-Token value (prefer --token-file or $DCC_TOKEN)
  --token-file <path>   Read the token from a file (trimmed)
  --once                Exit after the first clipboard update
  --raw                 Copy raw_text instead of the extracted content
  --no-clipboard        Detect updates but do not write the local clipboard
  --no-notify           Do not send a desktop notification
  --timeout <seconds>   Idle timeout before reconnecting (default: ${DEFAULT_IDLE_TIMEOUT_SECONDS})
  --quiet               Suppress informational output
  --help                Show this help

Environment:
  DCC_URL, DCC_TOKEN, DCC_TOKEN_FILE

Examples:
  DCC_TOKEN='<token>' node backend/scripts/sse-subscribe.js
  node backend/scripts/sse-subscribe.js --url http://127.0.0.1:3000 --once
  node backend/scripts/sse-subscribe.js --token-file ~/.dcc-token --no-notify
`;

/** Parses CLI flags without touching process.argv in library consumers. */
export function parseArgs(argv = [], env = process.env) {
  const options = {
    url: env.DCC_URL || DEFAULT_URL,
    token: env.DCC_TOKEN || '',
    tokenFile: env.DCC_TOKEN_FILE || '',
    once: false,
    raw: false,
    clipboard: true,
    notify: true,
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    quiet: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--url':
        options.url = nextValue();
        break;
      case '--token':
        options.token = nextValue();
        break;
      case '--token-file':
        options.tokenFile = nextValue();
        break;
      case '--timeout':
        options.idleTimeoutSeconds = positiveNumber(
          nextValue(),
          '--timeout',
        );
        break;
      case '--once':
        options.once = true;
        break;
      case '--raw':
        options.raw = true;
        break;
      case '--no-clipboard':
        options.clipboard = false;
        break;
      case '--no-notify':
        options.notify = false;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.url = options.url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(options.url)) {
    throw new Error('--url must start with http:// or https://.');
  }
  return options;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return number;
}

/** Resolves the token from a file when configured; never logs its value. */
export async function resolveToken(options, readFileImpl = readFile) {
  if (options.tokenFile) {
    const token = (await readFileImpl(options.tokenFile, 'utf8')).trim();
    if (!token) throw new Error(`Token file is empty: ${options.tokenFile}`);
    return token;
  }
  if (!options.token || !options.token.trim()) {
    throw new Error(
      'No token configured. Set DCC_TOKEN, use --token-file, or pass --token.',
    );
  }
  return options.token.trim();
}

/**
 * Connects to the SSE endpoint and reconnects until stopped. `--once` resolves
 * after the first clipboard update; the long-running form never resolves.
 */
export async function runSubscriber(
  options,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    writeClipboard = writeSystemClipboard,
    sendNotification = notifyDesktop,
    logger = console,
    token = null,
  } = {},
) {
  const resolvedToken = token ?? (await resolveToken(options));
  const idleTimeoutMs = options.idleTimeoutSeconds * 1000;
  let lastEventId = '';
  let retryMs = DEFAULT_RETRY_MS;

  const handleUpdate = async (data) => {
    if (!data || typeof data !== 'object') {
      throw new Error('clipboard.updated event did not contain a JSON object.');
    }
    const text = options.raw ? data.raw_text : data.content;
    if (typeof text !== 'string') {
      throw new Error('clipboard.updated event did not contain text.');
    }
    if (options.clipboard) {
      const result = writeClipboard(text);
      if (!result?.ok && !options.quiet) {
        logger.warn(`Could not write the system clipboard: ${result?.reason}`);
      }
    }
    if (options.notify) {
      sendNotification({
        title: '网络剪切板',
        body: text.slice(0, MAX_NOTIFICATION_BODY),
      });
    }
    if (!options.quiet) logger.log(JSON.stringify(data));
    return data;
  };

  for (;;) {
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    try {
      const headers = {
        accept: 'text/event-stream',
        'X-DCC-Token': resolvedToken,
      };
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      const response = await fetchImpl(`${options.url}/api/v1/clipboard/stream`, {
        headers,
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw fatal(`Authentication failed (HTTP ${response.status}).`);
      }
      if (response.status === 400) {
        throw fatal('The server rejected the subscription request (HTTP 400).');
      }
      if (response.status === 404) {
        throw fatal('Realtime endpoint not found (HTTP 404).');
      }
      if (response.status === 503) {
        const retryAfter = Number(response.headers.get('retry-after'));
        retryMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : retryMs;
        if (!options.quiet) {
          logger.warn(`Realtime feed unavailable; retrying in ${retryMs}ms.`);
        }
        await sleep(retryMs);
        continue;
      }
      if (!response.ok || !response.body) {
        throw new Error(`SSE endpoint returned HTTP ${response.status}.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        const events = parser.feed(decoder.decode(value, { stream: true }));
        for (const event of events) {
          if (event.retry !== undefined) retryMs = event.retry;
          if (event.id) lastEventId = event.id;
          if (event.event === 'ready') {
            if (!options.quiet) logger.log('Realtime subscription ready.');
            continue;
          }
          if (event.event === 'clipboard.updated') {
            let data;
            try {
              data = JSON.parse(event.data);
            } catch {
              throw new Error('Could not parse clipboard.updated event data.');
            }
            const update = await handleUpdate(data);
            if (options.once) return { reason: 'update', data: update };
          }
        }
      }

      if (!options.quiet) {
        logger.warn(`SSE connection closed; reconnecting in ${retryMs}ms.`);
      }
    } catch (error) {
      if (error?.fatal) throw error;
      if (!options.quiet) {
        logger.warn(
          `SSE connection failed: ${error?.message ?? error}; retrying in ${retryMs}ms.`,
        );
      }
    } finally {
      clearTimeout(idleTimer);
    }

    await sleep(retryMs);
  }
}

function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
    } else {
      await runSubscriber(options);
    }
  } catch (error) {
    console.error(`sse-subscribe: ${error.message}`);
    process.exitCode = 1;
  }
}
