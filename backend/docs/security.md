# Backend security contract

## Authentication

Protected API routes must use the `X-DCC-Token` request header. The expected value is configured with `API_SECRET_TOKEN`; absent server configuration fails closed and protected requests receive 401. Token comparison uses SHA-256 digests and Node's constant-time `timingSafeEqual`; missing, empty, incorrect, or oversized values are rejected. Never send tokens in URLs: query-string authentication is unsupported and forbidden, including for clipboard reads.

Register protected routes through `createServer`'s route list, setting `auth: true`:

```js
createServer({ config, routes: [
  { method: 'POST', path: '/api/v1/collect', auth: true, handler: collect },
] });
```

Handlers receive `(request, url)` and return a web `Response`. Keep health public. A route can opt into rate limiting by wrapping its handler with `rateLimit({ config })(handler)`; this task does not register a collect route.

## Rate limiting

The reusable limiter applies independent fixed-window counters to the `X-DCC-Token` identity and client IP; exceeding either returns HTTP 429 with the shared error envelope and an integer `Retry-After` header. Defaults are 30 requests per 60-second epoch-aligned window for each dimension. Configure `RATE_LIMIT_ENABLED` (`true`), `RATE_LIMIT_PER_MINUTE` (`30`), and `RATE_LIMIT_WINDOW_SECONDS` (`60`) through environment variables. `X-Forwarded-For` is considered only when `TRUST_PROXY=true`; the first comma-separated address is used, so the trusted proxy must overwrite this header. Otherwise the socket peer address is used. Token identifiers are SHA-256 digests, not raw token values.

`RateLimitStore.increment(key, expiresAt, now)` is the replaceable counter interface; `InMemoryRateLimitStore` is the default implementation for local development and tests. A shared Redis/KV adapter can implement the same atomic increment/expiry contract and be injected into `rateLimit`. The in-memory store is process-local and does not coordinate across serverless invocations or multiple instances. Production multi-instance deployments must use a shared driver; that work is assigned to REQ-202610-1251/1256.

## Error response envelope

All errors use `{ "code": <HTTP status>, "message": "<short English message>", "data": null }`; `code` equals the HTTP status. Messages do not expose secrets or internal exception details.

| HTTP | Meaning | Example |
| --- | --- | --- |
| 400 | Invalid request body or parameters | `{"code":400,"message":"Bad request.","data":null}` |
| 401 | Missing or invalid token | `{"code":401,"message":"Missing or invalid X-DCC-Token header.","data":null}` |
| 403 | HTTPS required | `{"code":403,"message":"HTTPS is required.","data":null}` |
| 404 | Unknown route or no clipboard data | `{"code":404,"message":"Not found.","data":null}` |
| 404 | Clipboard absent or TTL-expired | `{"code":404,"message":"No clipboard data available.","data":null}` |
| 429 | Rate limit exceeded | `{"code":429,"message":"Too many requests.","data":null}` |
| 500 | Unhandled server error | `{"code":500,"message":"Internal server error.","data":null}` |

An expired clipboard item is equivalent to one that never existed: return 404 and do not serve historical content. Historical logs are retained independently of clipboard TTL. The 429 envelope is reserved for the rate limiter implemented by the follow-up security task.

## Admin surface

The management backend (`/admin`, `/admin/*`, `/api/admin/*` and the
management API prefixes `/api/v1/devices`, `/api/v1/webhooks`, `/api/v1/logs`,
`/api/v1/stats`, `/api/v1/settings`) uses a separate login-session scheme
instead of `X-DCC-Token`. Anonymous access is denied by default; sessions are
`HttpOnly` cookies with an absolute lifetime, login failures are rate limited,
and state-changing admin API requests require a CSRF token. The admin surface
must remain private in production and has no public read-only view. See
[admin-auth.md](admin-auth.md) for the full contract and deployment
requirement. `X-DCC-Token` is not accepted for management APIs.

## HTTPS

Request enforcement defaults off outside production and on when `NODE_ENV=production`; `ENFORCE_HTTPS=true|false` overrides the default. When enabled, this Node HTTP server expects TLS to terminate at a trusted reverse proxy, which must overwrite `X-Forwarded-Proto`; set `TRUST_PROXY=true` to honor its first value. The server itself does not terminate TLS. HTTP receives a 403 error envelope; requests are not redirected. Deployment-level TLS/redirect policy belongs to REQ-202610-1251 and must also be enabled there.

## Response headers

Every response, including errors, includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy` (default `default-src 'self'`, configurable with `CONTENT_SECURITY_POLICY`). HTTPS responses include `Strict-Transport-Security: max-age=31536000` by default; configure the duration with `HSTS_MAX_AGE`.
