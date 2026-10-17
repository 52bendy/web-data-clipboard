import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RUNS = 5;
const DEFAULT_TARGET_MS = 200;

/**
 * Cold-start measurement口径 for PRD §8.3.
 *
 * One sample starts at `spawn()` and ends at the first successful HTTP 200
 * from `GET /api/v1/health`. It includes Node.js process creation, module
 * loading, service construction and the first request round-trip on
 * localhost. It excludes `npm install`, container image pull, DNS and any
 * external network latency. The first sample is a warm-up and is discarded;
 * the remaining samples report median and p95.
 */
export async function measureColdStart({
  runs = DEFAULT_RUNS,
  targetMs = DEFAULT_TARGET_MS,
  timeoutMs = 10_000,
} = {}) {
  const samples = [];
  const failures = [];
  for (let index = 0; index < runs; index += 1) {
    const result = await measureOnce({ timeoutMs });
    if (result.ok) {
      samples.push(result.durationMs);
    } else {
      failures.push(result.error);
    }
  }
  const measured = samples.slice(1);
  const stats = summarize(measured.length > 0 ? measured : samples);
  return {
    ok: failures.length === 0 && stats.median < targetMs,
    target_ms: targetMs,
    runs,
    warmup_discarded: samples.length > 1,
    samples_ms: samples.map(round),
    stats,
    failures,
  };
}

async function measureOnce({ timeoutMs }) {
  const port = await getFreePort();
  const started = process.hrtime.bigint();
  const child = spawn(process.execPath, [join(BACKEND_ROOT, 'src/server.js')], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      API_SECRET_TOKEN: 'cold-start-benchmark-token',
      ENFORCE_HTTPS: 'false',
      RATE_LIMIT_ENABLED: 'false',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: '',
      ADMIN_PASSWORD_HASH: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(port, { timeoutMs, child });
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: true, durationMs };
  } catch (error) {
    return {
      ok: false,
      error: `${error.message}${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`,
    };
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child, 1_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

async function waitForHealth(port, { timeoutMs, child }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}`);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          signal: controller.signal,
        });
        if (response.status === 200) return;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // The listener is not ready yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`health check did not pass within ${timeoutMs}ms`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

function summarize(samples) {
  if (samples.length === 0) {
    return { min: null, median: null, p95: null, max: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: round(sorted[0]),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    ),
    max: round(sorted.at(-1)),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const runsIndex = process.argv.indexOf('--runs');
  const runs =
    runsIndex === -1 ? DEFAULT_RUNS : Number(process.argv[runsIndex + 1]);
  const result = await measureColdStart({
    runs: Number.isInteger(runs) && runs > 1 ? runs : DEFAULT_RUNS,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
