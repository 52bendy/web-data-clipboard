import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  notifyDesktop,
  writeSystemClipboard,
} from './lib/system-integration.js';

export { notifyDesktop, writeSystemClipboard };

const DEFAULT_URL = 'http://localhost:3000';
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_NOTIFICATION_BODY = 300;

const HELP = `PC clipboard poller for the DCC clipboard API (PRD §7.2.1).

Usage:
  node backend/scripts/pc-poll-sync.js [options]

Options:
  --url <base>          Backend base URL (default: $DCC_URL or ${DEFAULT_URL})
  --token <token>       X-DCC-Token value (prefer --token-file or $DCC_TOKEN)
  --token-file <path>   Read the token from a file (trimmed)
  --interval <seconds>  Poll interval (default: ${DEFAULT_INTERVAL_SECONDS})
  --state <path>        State file (default: ~/.dcc-clipboard-state.json)
  --once                Poll once and exit (useful for cron / Task Scheduler)
  --raw                 Copy raw_text instead of the extracted content
  --no-clipboard        Detect updates but do not write the local clipboard
  --no-notify           Do not send a desktop notification
  --timeout <seconds>   HTTP request timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --quiet               Suppress informational output
  --help                Show this help

Environment:
  DCC_URL, DCC_TOKEN, DCC_TOKEN_FILE, DCC_STATE_FILE

Examples:
  DCC_TOKEN='<token>' node backend/scripts/pc-poll-sync.js
  node backend/scripts/pc-poll-sync.js --url http://127.0.0.1:3000 --once --raw
  node backend/scripts/pc-poll-sync.js --token-file ~/.dcc-token --interval 3
`;

/** Parses CLI flags without touching process.argv in library consumers. */
export function parseArgs(argv = [], env = process.env) {
  const options = {
    url: env.DCC_URL || DEFAULT_URL,
    token: env.DCC_TOKEN || '',
    tokenFile: env.DCC_TOKEN_FILE || '',
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    statePath:
      env.DCC_STATE_FILE || join(homedir(), '.dcc-clipboard-state.json'),
    once: false,
    raw: false,
    clipboard: true,
    notify: true,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
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
      case '--interval':
        options.intervalSeconds = positiveNumber(nextValue(), '--interval');
        break;
      case '--state':
        options.statePath = nextValue();
        break;
      case '--timeout':
        options.timeoutSeconds = positiveNumber(nextValue(), '--timeout');
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

export async function loadState(statePath, readFileImpl = readFile) {
  try {
    const value = JSON.parse(await readFileImpl(statePath, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Could not read state file ${statePath}: ${error.message}`);
  }
}

export async function saveState(statePath, state, writeFileImpl = writeFile) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFileImpl(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile only applies mode when creating; keep existing files private too.
  await chmod(statePath, 0o600).catch(() => {});
}

/**
 * Polls once. Returns a small result object; `updated` is true only when a
 * new clipboard value was written and the state file advanced.
 */
export async function pollOnce({
  baseUrl,
  token,
  statePath,
  raw = false,
  clipboard = true,
  notify = true,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  fetchImpl = fetch,
  writeClipboard = writeSystemClipboard,
  sendNotification = notifyDesktop,
  loadStateImpl = loadState,
  saveStateImpl = saveState,
  logger = console,
} = {}) {
  const state = await loadStateImpl(statePath);
  const headers = {
    accept: 'application/json',
    'X-DCC-Token': token,
  };
  if (state.etag) headers['If-None-Match'] = state.etag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/clipboard/latest`, {
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 304) {
    return { updated: false, reason: 'not-modified' };
  }
  if (response.status === 404) {
    return { updated: false, reason: 'empty-or-expired' };
  }
  if (response.status === 401) {
    throw new Error('Authentication failed (401). Check the X-DCC-Token.');
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) || null;
    return { updated: false, reason: 'rate-limited', retryAfter };
  }
  if (!response.ok) {
    throw new Error(`Clipboard API returned HTTP ${response.status}.`);
  }

  const body = await response.json();
  const data = body?.data;
  if (!data || typeof data.content !== 'string') {
    throw new Error('Clipboard API returned an unexpected payload.');
  }
  const etag = response.headers.get('etag') || undefined;
  if (
    state.updated_at &&
    Number.isFinite(Number(data.updated_at)) &&
    Number(data.updated_at) <= Number(state.updated_at)
  ) {
    await saveStateImpl(statePath, { ...state, etag: etag ?? state.etag });
    return { updated: false, reason: 'already-seen' };
  }

  const text = raw ? data.raw_text : data.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Clipboard API returned empty content.');
  }

  let clipboardResult = null;
  if (clipboard) {
    clipboardResult = await writeClipboard(text);
    if (!clipboardResult?.ok) {
      throw new Error(
        `Could not write the system clipboard: ${clipboardResult?.reason ?? 'unknown error'}`,
      );
    }
  }

  let notified = false;
  if (notify) {
    const notification = {
      title: '网络剪切板更新',
      body: notificationBody(data, text),
      data,
    };
    notified = await sendNotification(notification);
    if (!notified) {
      logger.warn?.(
        'Desktop notification was not available; content is still ready.',
      );
    }
  }

  await saveStateImpl(statePath, {
    etag,
    updated_at: data.updated_at,
    source_device: data.source_device,
  });
  return {
    updated: true,
    data,
    text,
    clipboard: clipboardResult,
    notified,
  };
}

function notificationBody(data, text) {
  const source = data.source_device || 'unknown';
  const platform = data.platform || 'unknown';
  const body = `${source}（${platform}）：${text}`;
  return body.length > MAX_NOTIFICATION_BODY
    ? `${body.slice(0, MAX_NOTIFICATION_BODY - 1)}…`
    : body;
}

/** Long-running loop used by the CLI; `once` makes it cron-friendly. */
export async function runPolling(options, { logger = console } = {}) {
  const token = await resolveToken(options);
  const intervalMs = options.intervalSeconds * 1000;
  let stopped = false;
  let failed = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped) {
      let waitMs = intervalMs;
      try {
        const result = await pollOnce({
          baseUrl: options.url,
          token,
          statePath: options.statePath,
          raw: options.raw,
          clipboard: options.clipboard,
          notify: options.notify,
          timeoutMs: options.timeoutSeconds * 1000,
          logger,
        });
        if (!options.quiet) {
          if (result.updated) {
            logger.log(
              `[dcc] updated ${new Date(result.data.updated_at).toISOString()} ` +
                `from ${result.data.source_device} (${result.data.platform})`,
            );
          } else {
            logger.log(`[dcc] ${result.reason}`);
          }
        }
        if (result.reason === 'rate-limited' && result.retryAfter) {
          waitMs = Math.max(waitMs, result.retryAfter * 1000);
        }
      } catch (error) {
        failed = true;
        logger.error(`[dcc] ${error.message}`);
      }
      if (options.once || stopped) break;
      await sleepInterruptible(waitMs, () => stopped);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return { ok: !failed };
}

function sleepInterruptible(milliseconds, isStopped) {
  return new Promise((resolve) => {
    const deadline = Date.now() + milliseconds;
    const timer = setInterval(
      () => {
        if (isStopped() || Date.now() >= deadline) {
          clearInterval(timer);
          resolve();
        }
      },
      Math.min(100, milliseconds),
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
    } else {
      const result = await runPolling(options);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[dcc] ${error.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
  }
}
