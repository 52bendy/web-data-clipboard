const url = process.argv[2] || 'http://localhost:3000/api/v1/health';
const timeoutMs = 10_000;

try {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.status !== 'ok') {
    throw new Error('response JSON does not contain status "ok"');
  }
  console.log(`Health check passed: ${url}`);
} catch (error) {
  console.error(`Health check failed: ${error.message}`);
  process.exitCode = 1;
}
