import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { hashPassword } from '../src/admin/passwords.js';
import { createAdminStatic } from '../src/admin/static.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'correct horse battery staple';
const silentLogger = { info() {}, warn() {}, error() {} };

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function config({ admin, ...overrides } = {}) {
  return {
    apiSecretToken: 'a-secret-token',
    enforceHttps: false,
    trustProxy: false,
    contentSecurityPolicy: "default-src 'self'",
    hstsMaxAge: 31536000,
    rateLimitEnabled: false,
    rateLimitPerMinute: 30,
    rateLimitWindowSeconds: 60,
    admin: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      passwordHash: '',
      sessionTtlMs: 3600000,
      loginMaxAttempts: 5,
      loginWindowMs: 900000,
      maxSessions: 100,
      cookieSecure: 'auto',
      ...(admin || {}),
    },
    ...overrides,
  };
}

async function login(
  base,
  { username = ADMIN_USERNAME, password = ADMIN_PASSWORD } = {},
) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const body = await response.json();
  return { response, setCookie, cookie, body };
}

test('login page is public and every anonymous admin resource is denied', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const loginPage = await fetch(`${base}/admin/login`);
      assert.equal(loginPage.status, 200);
      assert.match(loginPage.headers.get('content-type'), /text\/html/);
      assert.match(await loginPage.text(), /action="\/admin\/login"/);

      const css = await fetch(`${base}/admin/login.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /text\/css/);

      for (const path of [
        '/admin',
        '/admin/',
        '/admin/index.html',
        '/admin/devices',
      ]) {
        const response = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.equal(response.status, 302, path);
        assert.match(
          response.headers.get('location') || '',
          /^\/admin\/login\?next=/,
        );
      }

      for (const path of [
        '/api/admin/session',
        '/api/admin/devices',
        '/api/v1/devices',
        '/api/v1/webhooks',
        '/api/v1/logs',
        '/api/v1/stats',
        '/api/v1/settings',
      ]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 401, path);
        assert.deepEqual(await response.json(), {
          code: 401,
          message: 'Admin authentication required.',
          data: null,
        });
      }

      assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
    },
  );
});

test('correct login issues a hardened cookie and grants admin access', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const { response, setCookie, cookie, body } = await login(base);
      assert.equal(response.status, 200);
      assert.equal(body.code, 200);
      assert.equal(body.data.username, ADMIN_USERNAME);
      assert.ok(body.data.csrfToken.length >= 32);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Path=\//);
      assert.match(setCookie, /Max-Age=3600/);
      assert.doesNotMatch(setCookie, /Secure/);
      assert.match(cookie, /^dcc_admin_session=/);

      const session = await fetch(`${base}/api/admin/session`, {
        headers: { cookie },
      });
      assert.equal(session.status, 200);
      const sessionBody = await session.json();
      assert.equal(sessionBody.data.username, ADMIN_USERNAME);
      assert.equal(sessionBody.data.csrfToken, body.data.csrfToken);

      const page = await fetch(`${base}/admin`, { headers: { cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /管理后台/);
      assert.match(html, new RegExp(ADMIN_USERNAME));

      const unknown = await fetch(`${base}/api/admin/unknown`, {
        headers: { cookie },
      });
      assert.equal(unknown.status, 404);
    },
  );
});

test('wrong credentials are generic and login attempts are rate limited', async () => {
  const options = {
    config: config({ admin: { loginMaxAttempts: 3 } }),
    adminOptions: { logger: silentLogger },
  };
  await withServer(options, async (base) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await login(base, { password: 'wrong' });
      assert.equal(result.response.status, 401);
      assert.deepEqual(result.body, {
        code: 401,
        message: 'Invalid username or password.',
        data: null,
      });
    }

    const blocked = await login(base, { password: 'wrong' });
    assert.equal(blocked.response.status, 429);
    assert.equal(blocked.body.message, 'Too many login attempts.');
    const retryAfter = Number(blocked.response.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);

    const correctDuringLockout = await login(base);
    assert.equal(correctDuringLockout.response.status, 429);
  });
});

test('login limiter recovers after its window and successful login resets it', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const options = {
    config: config({ admin: { loginMaxAttempts: 2, loginWindowMs: 1000 } }),
    adminOptions: { logger: silentLogger, now },
  };
  await withServer(options, async (base) => {
    assert.equal(
      (await login(base, { password: 'wrong' })).response.status,
      401,
    );
    assert.equal(
      (await login(base, { password: 'wrong' })).response.status,
      401,
    );
    assert.equal((await login(base)).response.status, 429);

    clock += 1001;
    const recovered = await login(base);
    assert.equal(recovered.response.status, 200);

    // A successful login clears both IP and username buckets.
    assert.equal(
      (await login(base, { password: 'wrong' })).response.status,
      401,
    );
    assert.equal((await login(base)).response.status, 200);
  });
});

test('expired sessions are rejected on both pages and APIs', async () => {
  let clock = 10_000;
  const now = () => clock;
  const options = {
    config: config({ admin: { sessionTtlMs: 1000 } }),
    adminOptions: { logger: silentLogger, now },
  };
  await withServer(options, async (base) => {
    const { response, cookie } = await login(base);
    assert.equal(response.status, 200);
    assert.equal(
      (await fetch(`${base}/api/admin/session`, { headers: { cookie } }))
        .status,
      200,
    );

    clock += 1001;
    assert.equal(
      (await fetch(`${base}/api/admin/session`, { headers: { cookie } }))
        .status,
      401,
    );
    const page = await fetch(`${base}/admin`, {
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(page.status, 302);
  });
});

test('logout requires a CSRF token and invalidates the session', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const { cookie, body } = await login(base);

      const noCsrf = await fetch(`${base}/api/admin/logout`, {
        method: 'POST',
        headers: { cookie },
      });
      assert.equal(noCsrf.status, 403);
      assert.deepEqual(await noCsrf.json(), {
        code: 403,
        message: 'Invalid CSRF token.',
        data: null,
      });

      const wrongCsrf = await fetch(`${base}/api/admin/logout`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': 'wrong' },
      });
      assert.equal(wrongCsrf.status, 403);

      const ok = await fetch(`${base}/api/admin/logout`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': body.data.csrfToken },
      });
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('set-cookie') || '', /Max-Age=0/);
      assert.equal(
        (await fetch(`${base}/api/admin/session`, { headers: { cookie } }))
          .status,
        401,
      );
    },
  );
});

test('form logout uses the hidden CSRF field and redirects to login', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const { cookie, body } = await login(base);
      const response = await fetch(`${base}/admin/logout`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _csrf: body.data.csrfToken }).toString(),
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/admin/login');
      assert.equal(
        (await fetch(`${base}/api/admin/session`, { headers: { cookie } }))
          .status,
        401,
      );
    },
  );
});

test('browser form login works and rejects unsafe next targets', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const bad = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: ADMIN_USERNAME,
          password: 'wrong',
        }).toString(),
      });
      assert.equal(bad.status, 401);
      assert.match(await bad.text(), /用户名或密码错误/);

      const good = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
          next: '//evil.example/steal',
        }).toString(),
        redirect: 'manual',
      });
      assert.equal(good.status, 303);
      assert.equal(good.headers.get('location'), '/admin');
      assert.match(good.headers.get('set-cookie') || '', /HttpOnly/);
    },
  );
});

test('admin credentials missing fails closed', async () => {
  const options = {
    config: config({ admin: { password: '', passwordHash: '' } }),
    adminOptions: { logger: silentLogger },
  };
  await withServer(options, async (base) => {
    for (const path of ['/admin/login', '/admin', '/admin/index.html']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 503, path);
      assert.match(await response.text(), /后台未启用/);
    }
    const apiLogin = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'anything' }),
    });
    assert.equal(apiLogin.status, 503);
    assert.equal((await fetch(`${base}/api/admin/session`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/devices`)).status, 401);
  });
});

test('scrypt password hashes authenticate and malformed hashes fail fast', async () => {
  const passwordHash = await hashPassword('hash-only-password');
  const options = {
    config: config({ admin: { passwordHash, password: '' } }),
    adminOptions: { logger: silentLogger },
  };
  await withServer(options, async (base) => {
    assert.equal(
      (await login(base, { password: 'hash-only-password' })).response.status,
      200,
    );
    assert.equal(
      (await login(base, { password: 'wrong' })).response.status,
      401,
    );
  });

  assert.throws(
    () =>
      createServer({
        config: config({
          admin: { passwordHash: 'not-a-valid-hash', password: '' },
        }),
      }),
    /ADMIN_PASSWORD_HASH/,
  );
});

test('secure cookies are issued behind HTTPS and can be forced', async () => {
  const httpsConfig = config({
    trustProxy: true,
    admin: { cookieSecure: 'auto' },
  });
  await withServer(
    { config: httpsConfig, adminOptions: { logger: silentLogger } },
    async (base) => {
      const response = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie') || '', /Secure/);
    },
  );

  const forced = config({ admin: { cookieSecure: true } });
  await withServer(
    { config: forced, adminOptions: { logger: silentLogger } },
    async (base) => {
      const { setCookie } = await login(base);
      assert.match(setCookie, /Secure/);
    },
  );
});

test('management API prefixes reject even a valid X-DCC-Token', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const tokenResponse = await fetch(`${base}/api/v1/devices`, {
        headers: { 'x-dcc-token': 'a-secret-token' },
      });
      assert.equal(tokenResponse.status, 401);

      const { cookie } = await login(base);
      const adminResponse = await fetch(`${base}/api/v1/devices`, {
        headers: { cookie },
      });
      assert.equal(adminResponse.status, 404);
    },
  );
});

test('admin responses carry security headers and no-store caching', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      const page = await fetch(`${base}/admin/login`);
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.equal(
        page.headers.get('content-security-policy'),
        "default-src 'self'",
      );
      assert.equal(page.headers.get('cache-control'), 'no-store');

      const denied = await fetch(`${base}/api/admin/session`);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
    },
  );
});

test('method restrictions return 405 for admin endpoints', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      assert.equal((await fetch(`${base}/api/admin/login`)).status, 405);
      assert.equal(
        (await fetch(`${base}/api/admin/session`, { method: 'POST' })).status,
        405,
      );
      assert.equal((await fetch(`${base}/admin/logout`)).status, 405);
    },
  );
});

test('admin static serving blocks path traversal', async () => {
  const root = join(fileURLToPath(new URL('../public/admin', import.meta.url)));
  const serve = createAdminStatic({ rootDir: root });
  assert.equal(await serve('/admin/../README.md'), null);
  assert.equal(await serve('/admin/%2e%2e/README.md'), null);
  assert.equal(await serve('/admin/..%2fREADME.md'), null);
  assert.ok(await serve('/admin/index.html'));
});

test('admin config validates numeric and cookie-secure options', () => {
  assert.throws(
    () => getConfig({ ADMIN_SESSION_TTL_MS: '0' }),
    /ADMIN_SESSION_TTL_MS/,
  );
  assert.throws(
    () => getConfig({ ADMIN_LOGIN_MAX_ATTEMPTS: 'abc' }),
    /ADMIN_LOGIN_MAX_ATTEMPTS/,
  );
  assert.throws(
    () => getConfig({ ADMIN_COOKIE_SECURE: 'yes' }),
    /ADMIN_COOKIE_SECURE/,
  );

  const defaults = getConfig({});
  assert.equal(defaults.admin.username, 'admin');
  assert.equal(defaults.admin.sessionTtlMs, 8 * 60 * 60 * 1000);
  assert.equal(defaults.admin.loginMaxAttempts, 5);
  assert.equal(defaults.admin.cookieSecure, 'auto');
});
