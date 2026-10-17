# Backend

Node.js ESM backend and management frontend host. The API routes follow a serverless-friendly layout; `src/server.js` provides the zero-dependency local development server.

Run `npm install` at the repository root, then `npm run dev`. The initial `GET /api/v1/health` route returns JSON. Collection, clipboard, devices, and webhook routes are added by their respective requirements.

## Admin backend

The management backend is served from `/admin` and denies anonymous access by
default. Set credentials before starting the server:

```sh
# Recommended: scrypt hash
node backend/scripts/hash-admin-password.js 'your-strong-password'
ADMIN_USERNAME=admin ADMIN_PASSWORD_HASH='scrypt$...' npm run dev
# Open http://localhost:3000/admin
```

`ADMIN_PASSWORD` is accepted as a local-development fallback. If neither
credential variable is set, the admin surface fails closed. Sessions use an
`HttpOnly`, `SameSite=Strict` cookie with an absolute lifetime; logout revokes
the server-side session; failed logins are limited per IP and per username.
Management API prefixes (`/api/v1/devices`, `/api/v1/webhooks`, `/api/v1/logs`,
`/api/v1/stats`, `/api/v1/settings`) require the admin session even before
their routes are implemented.

The admin surface **must remain private in production**: it exposes SMS
plaintext, token rotation and webhook configuration, and this release provides
no public read-only view. See [docs/admin-auth.md](docs/admin-auth.md) for the
full contract, environment variables, CSRF handling and the deployment
requirement.
