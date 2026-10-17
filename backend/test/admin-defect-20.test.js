import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'defect 20 regression password';
const API_TOKEN = 'a-secret-api-token';
const silentLogger = { info() {}, warn() {}, error() {} };
const PUBLIC_ADMIN_ASSETS = new Set(['login.css']);

function config({ admin, ...overrides } = {}) {
  return {
    apiSecretToken: API_TOKEN,
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

async function login(base) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  assert.equal(response.status, 200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function listFiles(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function assertLoginRedirect(response, path) {
  assert.equal(response.status, 302, path);
  assert.match(
    response.headers.get('location') || '',
    /^\/admin\/login\?next=/,
    path,
  );
}

test('defect 20: every shipped admin asset except the login form is private', async () => {
  const root = fileURLToPath(new URL('../public/admin/', import.meta.url));
  const assets = await listFiles(root);
  const protectedAssets = assets.filter(
    (asset) => !PUBLIC_ADMIN_ASSETS.has(asset),
  );
  assert.ok(protectedAssets.includes('index.html'));
  assert.ok(protectedAssets.includes('admin.css'));

  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      for (const asset of protectedAssets) {
        const response = await fetch(`${base}/admin/${asset}`, {
          redirect: 'manual',
        });
        assertLoginRedirect(response, asset);
      }

      const loginPage = await fetch(`${base}/admin/login`);
      assert.equal(loginPage.status, 200);
      assert.match(loginPage.headers.get('content-type'), /text\/html/);
      assert.equal((await fetch(`${base}/admin/login.css`)).status, 200);
    },
  );
});

test('defect 20: sensitive admin pages and management APIs deny anonymous callers', async () => {
  await withServer(
    { config: config(), adminOptions: { logger: silentLogger } },
    async (base) => {
      for (const path of [
        '/admin',
        '/admin/',
        '/admin/index.html',
        '/admin/dashboard',
        '/admin/devices',
        '/admin/logs',
        '/admin/settings',
        '/admin/settings.html',
      ]) {
        assertLoginRedirect(
          await fetch(`${base}${path}`, { redirect: 'manual' }),
          path,
        );
      }

      // Page requests with unsafe methods must not receive a redirect.
      const postPage = await fetch(`${base}/admin/settings`, {
        method: 'POST',
      });
      assert.equal(postPage.status, 401);

      for (const path of [
        '/api/admin/session',
        '/api/admin/devices',
        '/api/v1/devices',
        '/api/v1/webhooks',
        '/api/v1/logs',
        '/api/v1/stats',
        '/api/v1/settings',
      ]) {
        const response = await fetch(`${base}${path}`, {
          headers: { 'x-dcc-token': API_TOKEN },
        });
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

test('defect 20: a newly added admin asset is private by default', async () => {
  const staticRoot = await mkdtemp(join(tmpdir(), 'dcc-admin-defect20-'));
  await writeFile(
    join(staticRoot, 'index.html'),
    '<!doctype html><title>admin</title><p>admin index</p>',
  );
  await writeFile(
    join(staticRoot, 'secret-report.html'),
    '<!doctype html><title>secret</title><p>sensitive sms report</p>',
  );
  await writeFile(
    join(staticRoot, 'secret-report.js'),
    'console.log("secret");',
  );
  await writeFile(join(staticRoot, 'login.css'), 'body {}');

  try {
    await withServer(
      {
        config: config(),
        adminOptions: { logger: silentLogger, staticRoot },
      },
      async (base) => {
        assertLoginRedirect(
          await fetch(`${base}/admin/secret-report.html`, {
            redirect: 'manual',
          }),
          'secret-report.html',
        );
        assertLoginRedirect(
          await fetch(`${base}/admin/secret-report.js`, { redirect: 'manual' }),
          'secret-report.js',
        );

        const cookie = await login(base);
        const report = await fetch(`${base}/admin/secret-report.html`, {
          headers: { cookie },
        });
        assert.equal(report.status, 200);
        assert.match(await report.text(), /sensitive sms report/);

        const script = await fetch(`${base}/admin/secret-report.js`, {
          headers: { cookie },
        });
        assert.equal(script.status, 200);
        assert.match(script.headers.get('content-type'), /javascript/);
        assert.equal(script.headers.get('cache-control'), 'no-store');
      },
    );
  } finally {
    await rm(staticRoot, { recursive: true, force: true });
  }
});

test('defect 20: missing admin credentials fail closed with no public fallback', async () => {
  await withServer(
    {
      config: config({ admin: { password: '', passwordHash: '' } }),
      adminOptions: { logger: silentLogger },
    },
    async (base) => {
      for (const path of [
        '/admin/login',
        '/admin',
        '/admin/dashboard',
        '/admin/settings.html',
      ]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 503, path);
        assert.match(await response.text(), /后台未启用/);
      }

      assert.equal((await fetch(`${base}/api/admin/session`)).status, 401);
      assert.equal((await fetch(`${base}/api/v1/devices`)).status, 401);
    },
  );
});
