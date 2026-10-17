# Backend

Node.js ESM backend and management frontend host. The API routes follow a serverless-friendly layout; `src/server.js` provides the zero-dependency local development server.

Run `npm install` at the repository root, then `npm run dev`. The initial `GET /api/v1/health` route returns JSON. Collection, clipboard, devices, and webhook routes are added by their respective requirements.

## Runtime entry points (REQ-202610-1251)

The backend shares its request handler between the local `node src/server.js` development server and the Vercel Node Function at `api/index.js`. `vercel.json` rewrites all paths to that function, preserving the original request path for routing. Check a running backend with `node scripts/health-check.js [url]`; the URL defaults to `http://localhost:3000/api/v1/health`.

## Clipboard storage service (REQ-202610-1255)

`src/services/` holds the platform-decoupled clipboard state:

- `storage/` — KV-style storage abstraction (`get` / `set` / `delete` / `update` / `purgeExpired`; contract documented in `storage/index.js`). The `memory` adapter remains the local-development and test default; `upstash` uses Redis REST directly without an SDK.
- `clipboard-store.js` — maintains the single latest clipboard record (§7.1) plus an append-only history log for the admin/statistics layer.

Semantics:

- Writes are atomic: concurrent `update` cycles serialize per key, so every accepted write takes the next server-side `seq`; the last one wins as latest and all of them are appended to history.
- Server receive time is authoritative: `updated_at` and ordering are assigned server-side, client-supplied timestamps/ids are ignored (defect 23).
- TTL: the latest record expires after `ttlMs` (default 30 minutes); expired reads return "absent" (`null`). Upstash applies expiry natively with Redis TTL; its `purgeExpired()` returns `0` because Redis handles expiry. Memory entries are purged lazily on read, by the maintenance sweep, or by `purgeExpired()`.
- History retention is configurable by count and age (`0` = unlimited) and is trimmed on write and on purge.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORAGE_DRIVER` | `memory` | Storage adapter: `memory` or `upstash` |
| `UPSTASH_REDIS_REST_URL` | — | Upstash Redis REST URL (required for `upstash`) |
| `UPSTASH_REDIS_REST_TOKEN` | — | Upstash Redis REST token (required for `upstash`) |
| `STORAGE_KEY_PREFIX` | `dcc:` | Prefix for all Redis keys, including update locks |
| `CLIPBOARD_TTL_MS` | `1800000` | Latest-record TTL |
| `CLIPBOARD_HISTORY_MAX_ENTRIES` | `500` | History retention by count (0 = unlimited) |
| `CLIPBOARD_HISTORY_TTL_MS` | `86400000` | History retention by age (0 = unlimited) |
| `CLIPBOARD_MAINTENANCE_INTERVAL_MS` | `60000` | Expiry sweep interval of the dev server |

With `STORAGE_DRIVER=upstash`, both Upstash credentials are required and startup fails fast if either is missing. `update` uses a per-key distributed Redis lock (`SET NX PX`) with a unique token and compare-and-delete release, so concurrent service instances serialize read-modify-write operations. Lock acquisition retries at most 200 times (25 ms between attempts); the lock expires after 5 seconds if a process exits unexpectedly.

The complete environment-variable inventory (including planned security settings) is in [`.env.example`](.env.example); see the [deployment guide](docs/deployment.md) for supported deployment configuration and limitations.
