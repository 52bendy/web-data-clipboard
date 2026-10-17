import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { signWebhookPayload } from '../src/services/webhook-forwarder.js';
import {
  E2E_TOKEN,
  collectPayload,
  request,
  startBackend,
  startReceiver,
  waitFor,
} from './lib/e2e-harness.js';

const NO_DATA_MESSAGE = 'No clipboard data available.';

/**
 * Scripted end-to-end acceptance for REQ-202610-1268.
 *
 * The chain under test is the real production path:
 *   device report -> POST /api/v1/collect -> clipboard store ->
 *   GET /api/v1/clipboard/latest -> async dispatcher -> webhook forwarder.
 *
 * Only the outbound HTTPS transport is redirected to an in-process receiver;
 * target validation, payload construction and HMAC signing remain the real
 * implementations. Negative cases run against separate server instances so
 * one case cannot pollute another.
 */
export async function runE2E({ log = () => {} } = {}) {
  const checks = [];
  const receiver = await startReceiver();
  let main = null;

  async function check(name, fn) {
    try {
      const detail = await fn();
      checks.push({ name, status: 'passed', detail: detail ?? null });
      log(`ok - ${name}`);
      return detail;
    } catch (error) {
      checks.push({
        name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      log(
        `not ok - ${name}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  try {
    main = await startBackend({ receiverUrl: receiver.url });

    const webhook = await check(
      'create webhook through the management API',
      async () => {
        const response = await request(main.base, '/api/v1/webhooks', {
          method: 'POST',
          token: E2E_TOKEN,
          body: { url: 'https://hooks.example.com/dcc', name: 'E2E receiver' },
        });
        assert.equal(response.status, 201);
        assert.equal(response.body?.code, 201);
        assert.equal(response.body?.data?.enabled, true);
        assert.match(response.body?.data?.secret, /^whsec_/);
        return response.body.data;
      },
    );

    const collected = await check(
      'device report updates the clipboard',
      async () => {
        const response = await request(main.base, '/api/v1/collect', {
          method: 'POST',
          token: E2E_TOKEN,
          body: collectPayload(),
        });
        assert.equal(response.status, 200);
        assert.equal(response.body?.code, 200);
        assert.equal(response.body?.data?.extracted_code, '839201');
        assert.equal(response.body?.data?.clipboard_updated, true);
        return response.body.data;
      },
    );

    const latest = await check(
      'query API returns the §4.1.2 payload',
      async () => {
        const response = await request(main.base, '/api/v1/clipboard/latest', {
          token: E2E_TOKEN,
        });
        assert.equal(response.status, 200);
        assert.equal(response.body?.data?.content, '839201');
        assert.equal(response.body?.data?.type, 'verification_code');
        assert.match(response.body?.data?.raw_text, /839201/);
        assert.equal(response.body?.data?.source_device, 'E2E 小米 13Pro');
        assert.equal(response.body?.data?.platform, 'android');
        assert.equal(typeof response.body?.data?.updated_at, 'number');
        assert.ok(response.body?.data?.expire_in_seconds > 0);
        assert.ok(response.headers.get('etag'));
        return { data: response.body.data, etag: response.headers.get('etag') };
      },
    );

    await check('conditional polling returns 304 when unchanged', async () => {
      const response = await request(main.base, '/api/v1/clipboard/latest', {
        token: E2E_TOKEN,
        headers: { 'If-None-Match': latest.etag },
      });
      assert.equal(response.status, 304);
      assert.equal(response.text, '');
      assert.equal(response.headers.get('etag'), latest.etag);
    });

    const delivery = await check(
      'webhook delivery is recorded as success',
      async () => {
        const result = await waitFor(async () => {
          const response = await request(
            main.base,
            '/api/v1/webhooks/deliveries?status=success',
            { token: E2E_TOKEN },
          );
          assert.equal(response.status, 200);
          return response.body?.data?.total >= 1 ? response.body.data : null;
        });
        const record = result.deliveries[0];
        assert.equal(record.webhook_id, webhook.webhook_id);
        assert.equal(record.collection_id, collected.collection_id);
        assert.equal(record.http_status, 204);
        assert.equal(record.attempts, 1);
        return record;
      },
    );

    await check('webhook receiver got a signed, parseable event', async () => {
      const received = await waitFor(() => receiver.received[0]);
      assert.equal(received.method, 'POST');
      assert.equal(received.headers['x-dcc-event'], 'clipboard.updated');
      assert.equal(received.headers['x-dcc-delivery-id'], delivery.delivery_id);
      const payload = JSON.parse(received.body);
      assert.equal(payload.event, 'clipboard.updated');
      assert.equal(payload.collection_id, collected.collection_id);
      assert.equal(payload.data?.parsed_code, '839201');
      assert.match(payload.message, /收到新验证码/);
      const expected = signWebhookPayload(
        webhook.secret,
        received.headers['x-dcc-timestamp'],
        received.body,
      );
      assert.equal(received.headers['x-dcc-signature'], expected);
      return { delivery_id: payload.delivery_id };
    });

    await check(
      'invalid token is rejected with the shared envelope',
      async () => {
        const response = await request(main.base, '/api/v1/collect', {
          method: 'POST',
          token: 'wrong-token',
          body: collectPayload({ device_id: 'android_bad_token' }),
        });
        assert.equal(response.status, 401);
        assert.deepEqual(response.body, {
          code: 401,
          message: 'Missing or invalid X-DCC-Token header.',
          data: null,
        });
      },
    );

    await check('invalid token on the query API is rejected', async () => {
      const response = await request(main.base, '/api/v1/clipboard/latest', {
        token: 'wrong-token',
      });
      assert.equal(response.status, 401);
      assert.equal(response.body?.code, 401);
    });

    await check('malformed JSON is rejected with 400', async () => {
      const response = await request(main.base, '/api/v1/collect', {
        method: 'POST',
        token: E2E_TOKEN,
        headers: { 'content-type': 'application/json' },
        body: '{"device_id":',
      });
      assert.equal(response.status, 400);
      assert.equal(response.body?.code, 400);
      assert.match(response.body?.message, /valid JSON/);
    });

    await check('oversized payload is rejected with 413', async () => {
      const response = await request(main.base, '/api/v1/collect', {
        method: 'POST',
        token: E2E_TOKEN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          collectPayload({
            device_id: 'android_oversized',
            raw_content: 'x'.repeat(4_096),
          }),
        ),
      });
      assert.equal(response.status, 413);
      assert.equal(response.body?.code, 413);
    });

    const expired = await startBackend({
      overrides: { clipboard: { ttlMs: 120, maintenanceIntervalMs: 60_000 } },
    });
    try {
      await check(
        'expired clipboard read returns 404 and leaks no content',
        async () => {
          const collectedExpired = await request(
            expired.base,
            '/api/v1/collect',
            {
              method: 'POST',
              token: E2E_TOKEN,
              body: collectPayload({
                device_id: 'android_expired',
                raw_content: '验证码：778899，已过期示例。',
              }),
            },
          );
          assert.equal(collectedExpired.status, 200);
          await new Promise((resolve) => setTimeout(resolve, 180));
          const response = await request(
            expired.base,
            '/api/v1/clipboard/latest',
            { token: E2E_TOKEN },
          );
          assert.equal(response.status, 404);
          assert.deepEqual(response.body, {
            code: 404,
            message: NO_DATA_MESSAGE,
            data: null,
          });
          assert.ok(!response.text.includes('778899'));
        },
      );
    } finally {
      await expired.close();
    }

    const limited = await startBackend({
      overrides: {
        rateLimitEnabled: true,
        rateLimitPerMinute: 2,
        rateLimitWindowSeconds: 60,
      },
    });
    try {
      await check('rate limit returns 429 with Retry-After', async () => {
        const statuses = [];
        let limitedResponse = null;
        for (let index = 0; index < 3; index += 1) {
          const response = await request(limited.base, '/api/v1/collect', {
            method: 'POST',
            token: E2E_TOKEN,
            body: collectPayload({ device_id: `android_rate_${index}` }),
          });
          statuses.push(response.status);
          if (index === 2) limitedResponse = response;
        }
        assert.deepEqual(statuses, [200, 200, 429]);
        assert.equal(limitedResponse.body?.code, 429);
        assert.ok(Number(limitedResponse.headers.get('retry-after')) >= 1);
      });
    } finally {
      await limited.close();
    }

    return {
      ok: true,
      checks,
      summary: {
        collected: collected.collection_id,
        clipboard_updated_at: latest.data.updated_at,
        delivery_id: delivery.delivery_id,
        checks: checks.length,
      },
    };
  } finally {
    if (main) await main.close();
    await receiver.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runE2E({ log: (line) => console.log(line) })
    .then((result) => {
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            summary: result.summary,
            checks: result.checks,
          },
          null,
          2,
        ),
      );
    })
    .catch((error) => {
      console.error('E2E FAILED:', error);
      process.exitCode = 1;
    });
}
