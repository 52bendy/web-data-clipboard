# Backend

Node.js ESM backend and management frontend host. The API routes follow a serverless-friendly layout; `src/server.js` provides the zero-dependency local development server.

Run `npm install` at the repository root, then `npm run dev`. `GET /api/v1/health`, `POST /api/v1/collect`, `GET /api/v1/logs` and `GET /api/v1/stats` (below) are live; the clipboard, devices, and webhook routes are added by their respective requirements. Local environment variables are documented in `.env.example`.

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
- These routes accept either the `X-DCC-Token` header (programmatic clients) or an authenticated admin session cookie (the log board and dashboard); anonymous callers receive the admin 401 envelope.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MASK_SENDER` | `true` | Mask sender phone numbers in log responses (`false|0` disables) |
| `LOG_MAX_ENTRIES` | `1000` | Collection-log retention by count (0 = unlimited) |
| `LOG_MAX_AGE_MS` | `604800000` | Collection-log retention by age (0 = unlimited) |

## Clipboard latest API (REQ-202610-1256)

`GET /api/v1/clipboard/latest` (PRD §4.1.2) returns the current clipboard record as `{ content, type, raw_text, source_device, platform, updated_at, expire_in_seconds }`. Authentication is header-only (`X-DCC-Token`); query-string tokens are rejected. TTL-expired or absent records return `404 No clipboard data available.` (defect 24). The response carries `ETag` / `Last-Modified` and supports `If-None-Match`, `If-Modified-Since` and `?updated_after=` for cheap conditional polling. Full contract: `docs/clipboard-api.md`.

## Admin authentication (REQ-202610-1260)

`/admin` and every `/api/admin/*` and management API prefix are protected by a server-side login session. Credentials come from `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` (recommended, generate with `node scripts/hash-admin-password.js`) or the development fallback `ADMIN_PASSWORD`. Sessions use an `HttpOnly`, `SameSite=Strict` cookie with an absolute TTL; login failures are rate limited; state-changing admin requests require the session CSRF token. When no credentials are configured the whole admin surface fails closed. Full contract: `docs/admin-auth.md`.

## Admin dashboard (REQ-202610-1261, PRD §4.2)

The authenticated landing page `/admin` is the operations dashboard:

- **Stat cards** — 今日采集短信 (`today_collected`), 解析提取验证码 (`today_extracted`) and 绑定设备 (`bound_devices`). Values come from the same `collection-log-store` aggregation as `GET /api/v1/stats`.
- **Live clipboard card** — large-format latest content with `复制内容`, `手动刷新`, source device / platform, receive time, remaining TTL and the raw text in an expandable block. The data is produced by the same helper as `GET /api/v1/clipboard/latest`, so card fields match the public API exactly.
- **Empty / expired states** — `clipboard_state: "empty"` means nothing has been written yet; `"expired"` means a previous record existed but its TTL elapsed. Expired content is never returned or re-displayed (defect 24); only the expiry timestamp is shown.
- **Auto refresh** — the page polls every `DASHBOARD_REFRESH_INTERVAL_MS` (default 15s) while visible, pauses when the tab is hidden, refreshes immediately when it becomes visible again, and exposes a manual refresh button. The countdown ticks locally from `expire_in_seconds`.

The page consumes a session-protected aggregate, `GET /api/admin/dashboard`, which requires the admin cookie and returns:

```json
{
  "code": 200,
  "message": "Dashboard data retrieved",
  "data": {
    "stats": { "date": "2026-10-17", "today_collected": 42, "today_extracted": 18, "bound_devices": 2 },
    "clipboard": {
      "content": "839201",
      "type": "verification_code",
      "raw_text": "【中国移动】您的验证码是：839201，5分钟内有效。",
      "source_device": "小米 13Pro",
      "platform": "android",
      "updated_at": 1728950400000,
      "expire_in_seconds": 1730
    },
    "clipboard_state": "active",
    "clipboard_expired_at": null,
    "refreshed_at": 1728950400000
  }
}
```

`clipboard` is `null` for the `empty` / `expired` states. The browser never receives `API_SECRET_TOKEN`; all dashboard reads use the admin session. `GET /api/v1/logs` and `GET /api/v1/stats` still accept `X-DCC-Token` for programmatic clients, and additionally accept the admin session for the future log board (REQ-202610-1262).

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_REFRESH_INTERVAL_MS` | `15000` | Dashboard auto-refresh cadence |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `ADMIN_PASSWORD_HASH` | *(empty)* | scrypt hash, recommended for production |
| `ADMIN_PASSWORD` | *(empty)* | Plaintext development fallback |
| `ADMIN_SESSION_TTL_MS` | `28800000` | Absolute session lifetime (8h) |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `5` | Failed logins before the limiter locks |
| `ADMIN_LOGIN_WINDOW_MS` | `900000` | Login limiter window |
| `ADMIN_MAX_SESSIONS` | `1000` | In-memory session cap |
| `ADMIN_COOKIE_SECURE` | `auto` | `true` / `false` / `auto` Secure cookie policy |
