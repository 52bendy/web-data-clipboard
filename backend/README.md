# Backend

Node.js ESM backend and management frontend host. The API routes follow a serverless-friendly layout; `src/server.js` provides the zero-dependency local development server.

Run `npm install` at the repository root, then `npm run dev`. `GET /api/v1/health` and `GET /api/v1/clipboard/latest` (below) are live; the collection, devices, and webhook routes are added by their respective requirements.

## Clipboard storage service (REQ-202610-1255)

`src/services/` holds the platform-decoupled clipboard state:

- `storage/` — KV-style storage abstraction (`get` / `set` / `delete` / `update` / `purgeExpired`; contract documented in `storage/index.js`). The `memory` adapter serves local development and tests; KV/Redis adapters plug in with the runtime selection (REQ-202610-1251) without touching the business layer.
- `clipboard-store.js` — maintains the single latest clipboard record (§7.1) plus an append-only history log for the admin/statistics layer.

Semantics:

- Writes are atomic: concurrent `update` cycles serialize per key, so every accepted write takes the next server-side `seq`; the last one wins as latest and all of them are appended to history.
- Server receive time is authoritative: `updated_at` and ordering are assigned server-side, client-supplied timestamps/ids are ignored (defect 23).
- TTL: the latest record expires after `ttlMs` (default 30 minutes); expired reads return "absent" (`null`) and expired data is purged lazily on read, by the maintenance sweep, or by `purgeExpired()`.
- History retention is configurable by count and age (`0` = unlimited) and is trimmed on write and on purge.

Environment variables:

| Variable                            | Default    | Purpose                                               |
| ----------------------------------- | ---------- | ----------------------------------------------------- |
| `STORAGE_DRIVER`                    | `memory`   | Storage adapter (`memory` only until REQ-202610-1251) |
| `CLIPBOARD_TTL_MS`                  | `1800000`  | Latest-record TTL                                     |
| `CLIPBOARD_HISTORY_MAX_ENTRIES`     | `500`      | History retention by count (0 = unlimited)            |
| `CLIPBOARD_HISTORY_TTL_MS`          | `86400000` | History retention by age (0 = unlimited)              |
| `CLIPBOARD_MAINTENANCE_INTERVAL_MS` | `60000`    | Expiry sweep interval of the dev server               |

## Clipboard latest API (REQ-202610-1256)

`GET /api/v1/clipboard/latest` (PRD §4.1.2) returns the latest clipboard in the
exact `{ code, data: { content, type, raw_text, source_device, platform,
updated_at, expire_in_seconds } }` shape. Authentication is header-only
(`X-DCC-Token`, or `Authorization: Bearer <token>`); any token-like query
parameter is rejected with 400 before auth (defect 21). An absent or TTL-expired
clipboard returns 404 `No clipboard data available.` (defect 24); expired
content is never served.

Polling is conditional: responses carry `ETag` / `Last-Modified`, and
`If-None-Match`, `If-Modified-Since`, or `?updated_after=<epoch-ms|ISO-8601>`
return `304 Not Modified` with an empty body when nothing changed. See
[`docs/clipboard-api.md`](docs/clipboard-api.md) for the full contract, error
table, expiry semantics, and curl examples.

```sh
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>'
```
