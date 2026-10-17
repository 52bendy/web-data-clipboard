import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPasswordVerifier, safeEqualText } from './passwords.js';
import { createSessionStore } from './sessions.js';
import { createLoginLimiter } from './login-limiter.js';
import { parseCookies, serializeCookie } from './cookies.js';
import {
  adminError,
  escapeHtml,
  htmlResponse,
  jsonResponse,
  redirectResponse,
} from './responses.js';
import { createAdminStatic } from './static.js';
import { createLoginPages } from './login-page.js';
import { readCredentials } from './read-body.js';

export const ADMIN_COOKIE_NAME = 'dcc_admin_session';

/**
 * Management API prefixes that must never be reachable anonymously. Routes
 * for these prefixes are built by later requirements; guarding the prefixes
 * here means a missing route returns 401 instead of 404 and a newly added
 * route cannot accidentally ship public.
 */
export const MANAGEMENT_API_PREFIXES = Object.freeze([
  '/api/v1/devices',
  '/api/v1/webhooks',
  '/api/v1/logs',
  '/api/v1/stats',
  '/api/v1/settings',
]);

export function isManagementApiPath(pathname) {
  return MANAGEMENT_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const DEFAULT_STATIC_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../public/admin',
);

/**
 * Admin authentication and access control (REQ-202610-1260 / defect 20).
 *
 * Chosen scheme: server-side login session. Credentials are exchanged for an
 * opaque, HttpOnly, SameSite=Strict cookie with a bounded lifetime; logout
 * removes the server-side session. This satisfies the session requirements
 * that Basic auth and a static admin token cannot (logout, expiry, per-session
 * CSRF tokens, and revocable server-side state).
 */
export function createAdmin({
  config = {},
  logger = console,
  now = Date.now,
  staticRoot = DEFAULT_STATIC_ROOT,
} = {}) {
  const adminConfig = config.admin || {};
  const verifier = createPasswordVerifier({
    passwordHash: adminConfig.passwordHash,
    password: adminConfig.password,
  });
  const enabled = verifier !== null;
  const expectedUsername = adminConfig.username || 'admin';
  const sessionStore = createSessionStore({
    ttlMs: adminConfig.sessionTtlMs,
    maxSessions: adminConfig.maxSessions,
    now,
  });
  const limiter = createLoginLimiter({
    maxAttempts: adminConfig.loginMaxAttempts,
    windowMs: adminConfig.loginWindowMs,
    now,
  });
  const serveStatic = createAdminStatic({ rootDir: staticRoot });
  const pages = createLoginPages({ staticRoot });

  function authenticate(request) {
    const token = parseCookies(request.headers.cookie || '')[ADMIN_COOKIE_NAME];
    return sessionStore.get(token);
  }

  function unauthorized() {
    return adminError(401, 'Admin authentication required.');
  }

  function sessionInfo(session) {
    return {
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString(),
      csrfToken: session.csrfToken,
    };
  }

  function clientIp(request) {
    const header = config.trustProxy ? request.headers['x-forwarded-for'] : '';
    const forwarded = Array.isArray(header) ? header[0] : String(header || '');
    return (
      forwarded.split(',')[0].trim() ||
      request.socket?.remoteAddress ||
      'unknown'
    );
  }

  function cookieSecure(https) {
    if (adminConfig.cookieSecure === true) return true;
    if (adminConfig.cookieSecure === false) return false;
    return https === true;
  }

  function setSessionCookie(response, session, https) {
    response.headers.set(
      'set-cookie',
      serializeCookie(ADMIN_COOKIE_NAME, session.token, {
        maxAgeSeconds: Math.ceil((session.expiresAt - now()) / 1000),
        secure: cookieSecure(https),
      }),
    );
  }

  function clearSessionCookie(response, https) {
    response.headers.set(
      'set-cookie',
      serializeCookie(ADMIN_COOKIE_NAME, '', {
        maxAgeSeconds: 0,
        secure: cookieSecure(https),
      }),
    );
  }

  function csrfValid(session, supplied) {
    return Boolean(supplied) && safeEqualText(session.csrfToken, supplied);
  }

  function rateLimited(retryAfterSeconds, json) {
    const headers = { 'retry-after': String(Math.max(1, retryAfterSeconds)) };
    if (json) {
      return jsonResponse(
        429,
        {
          code: 429,
          message: 'Too many login attempts.',
          data: null,
        },
        headers,
      );
    }
    return pages.renderLoginPage(
      429,
      { error: '尝试次数过多，请稍后再试。' },
      headers,
    );
  }

  async function verifyCredentials(username, password) {
    // Always run the password derivation, even for a wrong username, so
    // response timing does not reveal whether the account exists.
    const passwordOk = await verifier.verify(password);
    const usernameOk = safeEqualText(username, expectedUsername);
    return usernameOk && passwordOk;
  }

  async function handleLogin(request, url, { https, json }) {
    if (!enabled) {
      return json
        ? adminError(503, 'Admin authentication is not configured.')
        : pages.renderNoticePage(
            503,
            '后台未启用',
            '管理员凭据尚未配置，管理后台默认拒绝访问。',
          );
    }

    const credentials = await readCredentials(request);
    if (credentials.error === 413) {
      return json
        ? adminError(413, 'Request body is too large.')
        : pages.renderNoticePage(413, '请求过大', '登录请求超出允许的大小。');
    }
    if (credentials.error) {
      return json
        ? adminError(400, 'Invalid login request.')
        : pages.renderNoticePage(400, '请求无效', '登录请求格式不正确。');
    }

    const body = credentials.value;
    const username =
      typeof body.username === 'string'
        ? body.username.trim().slice(0, 128)
        : '';
    const password =
      typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
    const next = safeNext(body.next ?? url.searchParams.get('next'));
    const keys = [`ip:${clientIp(request)}`, `user:${username.toLowerCase()}`];

    const before = limiter.check(keys);
    if (!before.allowed) {
      logger.warn?.('admin.login_rate_limited', { ip: clientIp(request) });
      return rateLimited(before.retryAfterSeconds, json);
    }

    if (
      !username ||
      !password ||
      !(await verifyCredentials(username, password))
    ) {
      limiter.recordFailure(keys);
      logger.warn?.('admin.login_failed', { ip: clientIp(request), username });
      return json
        ? adminError(401, 'Invalid username or password.')
        : pages.renderLoginPage(401, {
            error: '用户名或密码错误',
            next,
            username,
          });
    }

    limiter.reset(keys);
    const session = sessionStore.create(username);
    logger.info?.('admin.login_succeeded', { username });
    const response = json
      ? jsonResponse(200, {
          code: 200,
          message: 'ok',
          data: sessionInfo(session),
        })
      : redirectResponse(next || '/admin');
    setSessionCookie(response, session, https);
    return response;
  }

  async function handleLogout(request, { https, json }) {
    const session = authenticate(request);
    if (!session) {
      return json
        ? adminError(401, 'Admin authentication required.')
        : redirectResponse('/admin/login');
    }

    let csrf = request.headers['x-csrf-token'] || '';
    if (!csrf && !json) {
      const body = await readCredentials(request);
      if (!body.error && body.value) csrf = body.value._csrf || '';
    }
    if (!csrfValid(session, csrf)) {
      return json
        ? adminError(403, 'Invalid CSRF token.')
        : pages.renderNoticePage(
            403,
            '请求被拒绝',
            'CSRF 校验失败，请重新登录后再试。',
          );
    }

    sessionStore.remove(session.token);
    logger.info?.('admin.logout', { username: session.username });
    const response = json
      ? jsonResponse(200, { code: 200, message: 'ok', data: null })
      : redirectResponse('/admin/login');
    clearSessionCookie(response, https);
    return response;
  }

  async function serveAdminPage(pathname, session) {
    const file = await serveStatic(pathname);
    if (!file) return null;
    if (file.contentType.startsWith('text/html')) {
      const html = file.body
        .toString('utf8')
        .replaceAll('{{USERNAME}}', escapeHtml(session?.username || ''))
        .replaceAll('{{CSRF_TOKEN}}', escapeHtml(session?.csrfToken || ''))
        .replaceAll(
          '{{EXPIRES_AT}}',
          escapeHtml(session ? new Date(session.expiresAt).toISOString() : ''),
        );
      return htmlResponse(200, html);
    }
    return new Response(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'cache-control': 'no-store',
      },
    });
  }

  async function handle(request, url, { https = false } = {}) {
    const pathname = url.pathname;
    const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
    const isAdminApi =
      pathname === '/api/admin' || pathname.startsWith('/api/admin/');
    if (!isAdminPage && !isAdminApi) return null;

    if (pathname === '/admin/login') {
      if (request.method === 'GET') {
        if (!enabled) {
          return pages.renderNoticePage(
            503,
            '后台未启用',
            '管理员凭据尚未配置，管理后台默认拒绝访问。',
          );
        }
        if (authenticate(request)) return redirectResponse('/admin');
        return pages.renderLoginPage(200, {
          next: safeNext(url.searchParams.get('next')),
        });
      }
      if (request.method === 'POST') {
        return handleLogin(request, url, { https, json: false });
      }
      return adminError(405, 'Method not allowed.');
    }

    if (pathname === '/admin/logout') {
      if (request.method !== 'POST') {
        return adminError(405, 'Method not allowed.');
      }
      return handleLogout(request, { https, json: false });
    }

    if (pathname === '/api/admin/login') {
      if (request.method !== 'POST') {
        return adminError(405, 'Method not allowed.');
      }
      return handleLogin(request, url, { https, json: true });
    }

    if (pathname === '/api/admin/session') {
      if (request.method !== 'GET') {
        return adminError(405, 'Method not allowed.');
      }
      const session = authenticate(request);
      if (!session) return unauthorized();
      return jsonResponse(200, {
        code: 200,
        message: 'ok',
        data: sessionInfo(session),
      });
    }

    if (pathname === '/api/admin/logout') {
      if (request.method !== 'POST') {
        return adminError(405, 'Method not allowed.');
      }
      return handleLogout(request, { https, json: true });
    }

    if (isAdminApi) {
      const session = authenticate(request);
      if (!session) return unauthorized();
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        !csrfValid(session, request.headers['x-csrf-token'])
      ) {
        return adminError(403, 'Invalid CSRF token.');
      }
      return adminError(404, 'Not found.');
    }

    const publicLoginAsset = pathname === '/admin/login.css';
    const session = authenticate(request);
    if (!publicLoginAsset && !session) {
      if (!enabled) {
        return pages.renderNoticePage(
          503,
          '后台未启用',
          '管理员凭据尚未配置，管理后台默认拒绝访问。',
        );
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const target = `${pathname}${url.search}`;
        return redirectResponse(
          `/admin/login?next=${encodeURIComponent(target)}`,
          302,
        );
      }
      return unauthorized();
    }

    const served = await serveAdminPage(pathname, session);
    if (served) return served;
    return adminError(404, 'Not found.');
  }

  return {
    handle,
    authenticate,
    unauthorized,
    enabled,
    sessionStore,
    limiter,
    cookieName: ADMIN_COOKIE_NAME,
  };
}

function safeNext(value) {
  if (!value) return '';
  const next = String(value);
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '';
  }
  if (/[\u0000-\u001f]/.test(next)) return '';
  if (next.startsWith('/admin/login')) return '';
  return next;
}
