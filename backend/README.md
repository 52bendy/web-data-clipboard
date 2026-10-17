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

See [docs/admin-auth.md](docs/admin-auth.md) for the full contract, environment
variables, CSRF handling and deployment-layer guidance.

Run `npm install` at the repository root, then `npm run dev`. `GET /api/v1/health`, `POST /api/v1/collect`, `GET /api/v1/logs` and `GET /api/v1/stats` (below) are live; the clipboard, devices, and webhook routes are added by their respective requirements. Local environment variables are documented in `.env.example`.

Run `npm install` at the repository root, then `npm run dev`. `GET /api/v1/health`, `POST /api/v1/collect`, and `GET /api/v1/devices` are live; the clipboard and webhook routes are added by their respective requirements. Local environment variables are documented in `.env.example`.

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

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORAGE_DRIVER` | `memory` | Storage adapter (`memory` only until REQ-202610-1251) |
| `CLIPBOARD_TTL_MS` | `1800000` | Latest-record TTL |
| `CLIPBOARD_HISTORY_MAX_ENTRIES` | `500` | History retention by count (0 = unlimited) |
| `CLIPBOARD_HISTORY_TTL_MS` | `86400000` | History retention by age (0 = unlimited) |
| `CLIPBOARD_MAINTENANCE_INTERVAL_MS` | `60000` | Expiry sweep interval of the dev server |

## Device management API (REQ-202610-1257)

`GET /api/v1/devices` returns the registered device list and aggregate online/offline counts. It requires the shared `X-DCC-Token` header; query-string tokens are not accepted. Devices are automatically registered or refreshed only after a collect report has successfully updated the clipboard. Registry write failures are logged and do not fail an otherwise successful collection.

Each device contains `device_id`, `device_name`, `platform`, `first_seen`, `last_seen`, and `online`. Timestamps are server-assigned ISO 8601 values; client timestamps do not affect device activity. The list is ordered by `last_seen` descending, then `device_id` ascending. `online` is true when the report was received within the configured threshold, including exactly at the threshold; future timestamps are considered online. Empty registries return HTTP 200 with an empty list and zero counts.

Success envelope:

```json
{
  "code": 200,
  "message": "Devices retrieved successfully",
  "data": {
    "devices": [],
    "stats": { "total": 0, "online": 0, "offline": 0, "online_threshold_ms": 86400000 }
  }
}
```

Missing or invalid credentials return 401; non-GET methods return 405, using the shared `{ code, message, data: null }` error envelope. The admin device list in REQ-202610-1262 should consume this contract; no admin page is included here, so UI integration remains for that requirement.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVICE_ONLINE_THRESHOLD_MS` | `86400000` | Online window in milliseconds; positive integers only, invalid values fall back to 24 hours |

## Verification code extraction (REQ-202610-1254)

`src/services/code-extractor.js` exposes a pure function `extractCode(text, options)` that pulls a verification code out of raw SMS text:

- Returns `{ extracted_code, type }`, where `type` is `verification_code` or `text`.
- Rules: 4–8 digit candidates (contiguous, or single-space separated groups) are scored by proximity to context keywords (验证码 / 校验码 / 动态码 / code / OTP …); order numbers, amounts, dates, alphanumeric tokens and over-long digit runs are excluded. Candidates below the score threshold are not extracted.
- Toggle: `options.autoExtract: false` makes the function return the text-only result; `AUTO_EXTRACT=false|0` flips the default in `src/config.js` until the admin settings panel (REQ-202610-1262) takes over.
- Sample set: `test/fixtures/code-samples.js` (20+ positive, 20+ negative), all covered by `npm test`.

## Collection API (REQ-202610-1253)

`POST /api/v1/collect` (PRD §4.1.1) — device report entry point. Handler in `api/v1/collect.js`, chain in `src/services/collect-service.js`: auth → validation → extraction (REQ-202610-1254) → clipboard update (REQ-202610-1255) → async dispatch (sink point for REQ-202610-1258) → response.

```sh
curl -i -X POST http://localhost:3000/api/v1/collect \
  -H 'Content-Type: application/json' \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' \
  -d '{"device_id":"android_mi13_001","device_name":"小米 13Pro","platform":"android","sender":"+8610086","raw_content":"【中国移动】您的验证码是：839201，5分钟内有效。","timestamp":1728950400000}'
```

```json
{
  "code": 200,
  "message": "Data collected successfully",
  "data": { "collection_id": "col_1728950400000…", "extracted_code": "839201", "clipboard_updated": true }
}
```

Request fields: `device_id` (1–128 chars of `A-Za-z0-9._:@-`), `device_name` (non-empty, ≤128), `platform` (`android` | `ios`), `sender` (optional, ≤64), `raw_content` (non-empty, ≤ `MAX_RAW_CONTENT_LENGTH`), `timestamp` (integer epoch ms, ≥ 2000-01-01 and ≤ server clock + 24h). Unknown fields are ignored; `extracted_code` is `null` when no code is found and the raw text is still stored.

Errors use the shared envelope `{ code, message, data: null }`:

| Status | When |
| --- | --- |
| 400 | malformed JSON, non-object body, or any field failing validation (message names the field) |
| 401 | missing, malformed, or wrong `X-DCC-Token` (constant-time compare; also returned when `API_SECRET_TOKEN` is unset) |
| 405 | any method other than POST on this path |
| 413 | body larger than `MAX_BODY_BYTES` |
| 500 | unexpected failure; the error is logged with its `collection_id` |

Behaviour notes:

- `collection_id` is minted per accepted report as `col_<server epoch ms><6 random digits>`; every accepted report logs `collect.received` / `collect.extracted` / `collect.clipboard_updated` / `collect.responded` (JSON lines via `src/utils/logger.js`) keyed by that id, so a report can be traced across the chain.
- Dispatch is fire-and-forget: a slow or failing downstream sink never delays or fails the response, and its error is logged as `collect.dispatch_failed`.
- The clipboard record is written with the server receive time; the device `timestamp` is only validated, never trusted for ordering (defect 23).
- Rate limiting (30 req/min, §8.1) and HTTPS enforcement are owned by REQ-202610-1252 and layered in front of this handler.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_SECRET_TOKEN` | *(empty)* | Shared `X-DCC-Token` secret; empty ⇒ all collects rejected |
| `MAX_RAW_CONTENT_LENGTH` | `4096` | `raw_content` character cap |
| `MAX_BODY_BYTES` | `65536` | Request body cap |

## Collection logs, statistics and masking (REQ-202610-1259)

Every accepted collection is appended to a bounded collection log (`src/services/collection-log-store.js`). The admin log board and dashboard read the same store, so filtered lists and counters cannot drift apart.

`GET /api/v1/logs` — paginated history, newest first. Requires `X-DCC-Token`.

| Query | Default | Meaning |
| --- | --- | --- |
| `page` | `1` | 1-based page number |
| `page_size` | `20` | Page size, 1–100 |
| `device` | — | Case-insensitive substring of device id or name |
| `device_id` | — | Exact device id |
| `device_name` | — | Case-insensitive device-name substring |
| `date` | — | Single local day, `YYYY-MM-DD` |
| `from` / `to` | — | Inclusive local-day range, `YYYY-MM-DD` (mutually exclusive with `date`) |
| `keyword` | — | Case-insensitive substring across sender, device, raw text, extracted code and collection id |
| `mask` | server default | Per-request display override: `1`/`true` masks, `0`/`false` shows raw senders |

```json
{
  "code": 200,
  "message": "Logs retrieved",
  "data": {
    "items": [
      {
        "log_id": "log_…",
        "collection_id": "col_…",
        "device_id": "android_mi13_001",
        "device_name": "小米 13Pro",
        "platform": "android",
        "sender": "138****8000",
        "raw_content": "【中国移动】您的验证码是：839201，5分钟内有效。",
        "extracted_code": "839201",
        "data_type": "verification_code",
        "status": "written",
        "client_timestamp": 1728950400000,
        "received_at": "2026-10-17T12:00:00.000Z"
      }
    ],
    "page": 1,
    "page_size": 20,
    "total": 1,
    "total_pages": 1,
    "masked": true
  }
}
```

`GET /api/v1/stats` — dashboard counters, also requiring `X-DCC-Token`:

```json
{
  "code": 200,
  "message": "Statistics retrieved",
  "data": {
    "date": "2026-10-17",
    "today_collected": 42,
    "today_extracted": 18,
    "bound_devices": 2
  }
}
```

Semantics:

- `today_collected` counts log entries received during the server-local day; `today_extracted` counts those whose `extracted_code` is non-null; `bound_devices` is the number of distinct `device_id` values in the retained log.
- Masking (PRD §8.2): with `MASK_SENDER` enabled (default), mainland mobile numbers keep the first three and last four digits (`13800138000` → `138****8000`); short service codes such as `10086` are untouched. `MASK_SENDER=false|0` returns raw senders, and the `mask` query parameter lets the authenticated admin UI override the default per request. The response's `masked` flag lets the UI show the active mode.
- Retention: the log keeps at most `LOG_MAX_ENTRIES` entries and drops entries older than `LOG_MAX_AGE_MS` on append, on query and via the maintenance sweep; `0` disables the corresponding limit. Defaults: 1000 entries / 7 days.
- A log append failure never fails the collection response; it is logged as `collect.log_failed`.
- Admin authentication currently reuses `X-DCC-Token`; REQ-202610-1260 layers the dedicated admin access control on top.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MASK_SENDER` | `true` | Mask sender phone numbers in log responses (`false|0` disables) |
| `LOG_MAX_ENTRIES` | `1000` | Collection-log retention by count (0 = unlimited) |
| `LOG_MAX_AGE_MS` | `604800000` | Collection-log retention by age (0 = unlimited) |
