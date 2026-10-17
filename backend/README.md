# Backend

Node.js ESM backend and management frontend host. The API routes follow a serverless-friendly layout; `src/server.js` provides the zero-dependency local development server.

Run `npm install` at the repository root, then `npm run dev`. `GET /api/v1/health`, `POST /api/v1/collect` and the Webhook management routes (below) are live; the clipboard and devices read routes are added by their respective requirements. Local environment variables are documented in `.env.example`.

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
  "data": {
    "collection_id": "col_1728950400000…",
    "extracted_code": "839201",
    "clipboard_updated": true
  }
}
```

Request fields: `device_id` (1–128 chars of `A-Za-z0-9._:@-`), `device_name` (non-empty, ≤128), `platform` (`android` | `ios`), `sender` (optional, ≤64), `raw_content` (non-empty, ≤ `MAX_RAW_CONTENT_LENGTH`), `timestamp` (integer epoch ms, ≥ 2000-01-01 and ≤ server clock + 24h). Unknown fields are ignored; `extracted_code` is `null` when no code is found and the raw text is still stored.

Errors use the shared envelope `{ code, message, data: null }`:

| Status | When                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 400    | malformed JSON, non-object body, or any field failing validation (message names the field)                         |
| 401    | missing, malformed, or wrong `X-DCC-Token` (constant-time compare; also returned when `API_SECRET_TOKEN` is unset) |
| 405    | any method other than POST on this path                                                                            |
| 413    | body larger than `MAX_BODY_BYTES`                                                                                  |
| 500    | unexpected failure; the error is logged with its `collection_id`                                                   |

Behaviour notes:

- `collection_id` is minted per accepted report as `col_<server epoch ms><6 random digits>`; every accepted report logs `collect.received` / `collect.extracted` / `collect.clipboard_updated` / `collect.responded` (JSON lines via `src/utils/logger.js`) keyed by that id, so a report can be traced across the chain.
- Dispatch is fire-and-forget: a slow or failing downstream sink never delays or fails the response, and its error is logged as `collect.dispatch_failed`.
- The clipboard record is written with the server receive time; the device `timestamp` is only validated, never trusted for ordering (defect 23).
- Rate limiting (30 req/min, §8.1) and HTTPS enforcement are owned by REQ-202610-1252 and layered in front of this handler.

Environment variables:

| Variable                 | Default   | Purpose                                                    |
| ------------------------ | --------- | ---------------------------------------------------------- |
| `API_SECRET_TOKEN`       | _(empty)_ | Shared `X-DCC-Token` secret; empty ⇒ all collects rejected |
| `MAX_RAW_CONTENT_LENGTH` | `4096`    | `raw_content` character cap                                |
| `MAX_BODY_BYTES`         | `65536`   | Request body cap                                           |

## Webhook configuration and async dispatch (REQ-202610-1258)

`/api/v1/webhooks` manages downstream consumers (URL / name / enabled; HMAC secret generated per config). After each accepted collection the dispatcher fans out asynchronously to every enabled Webhook: it formats a §7.2.2-style `message`, sends the structured payload with `X-DCC-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, applies a per-attempt timeout and exponential-backoff retries, and records every success/failure in `/api/v1/webhooks/deliveries` for the admin UI. `POST /api/v1/webhooks/:id/test` is the backend for the admin "test" button.

Targets are restricted to public `https:` endpoints: loopback/private/reserved IPs, local hostnames and DNS answers that resolve to them are rejected at config time and again at delivery time (defect 22 / SSRF). Setting `WEBHOOK_ALLOWED_HOSTS` adds an optional allowlist (exact hostnames, IP literals or `*.domain` wildcards) that is enforced on create/update and before every delivery. Full API, payload, signature-verification and retry contract: [`docs/webhooks.md`](docs/webhooks.md).

Environment variables:

| Variable                      | Default | Purpose                                               |
| ----------------------------- | ------- | ----------------------------------------------------- |
| `WEBHOOK_ALLOWED_HOSTS`       | empty   | Optional target allowlist (CSV, `*.domain` wildcards) |
| `WEBHOOK_TIMEOUT_MS`          | `5000`  | Per-attempt delivery timeout                          |
| `WEBHOOK_MAX_ATTEMPTS`        | `3`     | Total attempts including the first                    |
| `WEBHOOK_RETRY_BASE_DELAY_MS` | `1000`  | Exponential backoff base (1s, 2s, …)                  |
| `WEBHOOK_MAX_CONFIGS`         | `20`    | Maximum stored Webhook configs                        |
| `WEBHOOK_MAX_DELIVERIES`      | `200`   | Delivery-log retention                                |
