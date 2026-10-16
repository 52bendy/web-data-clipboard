import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { rateLimit } from '../src/middleware/rateLimit.js';

const config = getConfig({ API_SECRET_TOKEN: 'verification-secret', RATE_LIMIT_ENABLED: 'true' });
const isolatedConfig = getConfig({
  API_SECRET_TOKEN: 'verification-secret',
  RATE_LIMIT_PER_MINUTE: '1',
  RATE_LIMIT_WINDOW_SECONDS: '1',
  TRUST_PROXY: 'true',
});
const dimensionsConfig = getConfig({
  API_SECRET_TOKEN: 'verification-secret',
  RATE_LIMIT_PER_MINUTE: '2',
  TRUST_PROXY: 'true',
});
const limited = rateLimit({ config });
const server = createServer({ config, routes: [
  {
    method: 'POST',
    path: '/isolated',
    handler: rateLimit({ config: isolatedConfig })(async () => new Response('ok')),
  },
  {
    method: 'POST',
    path: '/dimensions',
    handler: rateLimit({ config: dimensionsConfig })(async () => new Response('ok')),
  },
  {
    method: 'POST',
    path: '/api/v1/collect',
    handler: limited(async () => new Response('{"accepted":true}', {
      headers: { 'content-type': 'application/json' },
    })),
  },
] });

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, token = 'verification-secret', forwardedFor) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'X-DCC-Token': token,
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
    },
  });
  const statuses = [];
  for (let i = 0; i < 30; i += 1) statuses.push((await request('/api/v1/collect')).status);
  const overLimit = await request('/api/v1/collect');
  console.log(`default requests 1-30: ${statuses.join(',')}`);
  console.log(`default request 31: ${overLimit.status}`);
  console.log(`default Retry-After: ${overLimit.headers.get('retry-after')}`);
  console.log(`default error body: ${await overLimit.text()}`);

  const thresholdResponse = await request('/isolated');
  const thresholdLimited = await request('/isolated');
  console.log(`threshold=1 first request: ${thresholdResponse.status}`);
  console.log(`threshold=1 second request: ${thresholdLimited.status}`);
  console.log(`threshold=1 Retry-After: ${thresholdLimited.headers.get('retry-after')}`);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  console.log(`threshold=1 window recovery: ${(await request('/isolated')).status}`);

  const dimensions = [
    await request('/dimensions', 'token-a', '192.0.2.1'),
    await request('/dimensions', 'token-b', '192.0.2.1'),
    await request('/dimensions', 'token-a', '192.0.2.2'),
    await request('/dimensions', 'token-a', '192.0.2.3'),
    await request('/dimensions', 'token-c', '192.0.2.1'),
  ];
  console.log(`dimension sequence (new token, same IP; same token, new IP; token limit; IP limit): ${dimensions.map(({ status }) => status).join(',')}`);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}
