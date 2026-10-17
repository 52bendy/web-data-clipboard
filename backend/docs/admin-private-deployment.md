# Admin backend: private deployment requirements

Status: mandatory for every deployment (defect 20 / REQ-202610-1269).

The management backend can read the full SMS history, rotate the server
`X-DCC-Token`, and change the Webhook target. It must therefore never be
reachable from the public internet. Application authentication is always on;
network isolation is a second, independent layer.

## Non-negotiable rules

1. `/admin` and `/api/admin/*` must be reachable only from a private network:
   VPN, private subnet, SSH tunnel, or a reverse proxy with an explicit IP
   allowlist. Do not publish them on a public hostname.
2. Do not link the admin URL from public pages, public documentation, or
   client applications.
3. Keep the application login enabled even when a network allowlist or proxy
   basic auth is in place. The two layers protect different failure modes.
4. There is no public read-only view in this release. If one is required,
   build it as a separate route with its own authentication and a strict
   allowlist of masked fields. It must never return raw SMS text, sender
   numbers, the server token, Webhook configuration, or log records, and it
   must not share the admin session or admin API routes.
5. Serve the admin over HTTPS. Set `ADMIN_COOKIE_SECURE=true` when TLS
   terminates upstream, and set `TRUST_PROXY=true` only when a trusted proxy
   overwrites `X-Forwarded-Proto` and `X-Forwarded-For`.

## Fail-closed behaviour

| Condition | `/admin*` | `/api/admin/*` | Management APIs |
| --- | --- | --- | --- |
| No `ADMIN_PASSWORD_HASH` / `ADMIN_PASSWORD` | `503` notice | `401` | `401` without a session |
| Anonymous visitor | `302` to `/admin/login` | `401` | `401` |
| Valid `X-DCC-Token` only | `302` to `/admin/login` | `401` | `401` when admin credentials are configured |
| Expired or unknown session cookie | `302` / `401` | `401` | `401` |

`X-DCC-Token` authenticates devices and the public API; it is **not** an admin
session and cannot open the management backend.

## Deployment checklist

- [ ] Admin credentials are injected from a secret manager, never committed
      to the repository or baked into an image.
- [ ] A VPN, private subnet, or reverse-proxy IP allowlist covers both
      `/admin` and `/api/admin`.
- [ ] From a public network, `GET /admin` returns `302`, `401`, `403`, or
      `503` — never `200`.
- [ ] From a public network, `GET /api/admin/logs` and
      `GET /api/admin/settings` return `401` or `403`.
- [ ] From a public network, `POST /api/admin/token/reset` returns `401` or
      `403`.
- [ ] Admin responses carry `Cache-Control: no-store` and the security
      headers configured by the backend.
- [ ] TLS is enforced, and the session cookie is `HttpOnly`,
      `SameSite=Strict`, and `Secure` on HTTPS.
- [ ] Logs and alerting contain only masked tokens; the plaintext token
      returned by a rotation is shown once and never written to disk.
- [ ] Any future public read-only view is reviewed as a separate surface and
      cannot mutate settings or read raw SMS content.

## Reverse proxy example (defence in depth)

The application guard remains the primary control. An allowlist at the edge
reduces the attack surface further:

```nginx
location /admin/ {
    allow 10.0.0.0/8;
    allow 192.168.0.0/16;
    deny all;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /api/admin/ {
    allow 10.0.0.0/8;
    allow 192.168.0.0/16;
    deny all;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Adjust the allowed ranges to the operator network. Do not add a public
`allow all` rule in front of the admin paths.

## Verification

The regression matrix lives in
`backend/test/admin-private-access.test.js`; it enumerates every file under
`backend/public/admin` and every admin API, and fails if an anonymous request
can reach one. Run it with the rest of the suite:

```sh
npm test
```

For a deployed instance, probe from a network that should **not** have access:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/admin
curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/api/admin/logs
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://your-host/api/admin/token/reset
```

Expected: `302`/`401`/`403`/`503`, never `200`.
