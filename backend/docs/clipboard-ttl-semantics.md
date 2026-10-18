# Clipboard TTL and expiry read semantics (REQ-202610-1273)

Status: **normative**. This document resolves defect 24 ("TTL 过期后的读取
语义未定义") for `GET /api/v1/clipboard/latest` and the clipboard store behind
it. It is implemented by REQ-202610-1256 and covered by
`backend/test/clipboard-ttl-semantics.test.js`.

## Decision

The read API uses the **404 / treated-as-absent** option. A TTL-expired
clipboard is indistinguishable from one that was never written:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{"code":404,"message":"No clipboard data available.","data":null}
```

The API never returns `200` with an `expired` marker and never returns expired
content. The alternative (`200` plus an `expired` flag) was rejected because
every consumer would have to branch on it, and a single missed branch would
render stale SMS content; `404` keeps one unambiguous "no current data" path.

## Timing model

| Term                | Definition                                                         |
| ------------------- | ------------------------------------------------------------------ |
| `updated_at`        | Server receive time in epoch milliseconds, assigned at write time. |
| `CLIPBOARD_TTL_MS`  | Latest-record lifetime; default `1800000` (30 minutes, PRD §8.2).  |
| `expires_at`        | `updated_at + CLIPBOARD_TTL_MS`.                                   |
| Valid / live        | `now < expires_at`, using the server clock.                        |
| Expired             | `now >= expires_at`; the boundary instant itself is expired.       |
| `expire_in_seconds` | `ceil((expires_at - now) / 1000)` on a `200` response.             |

Consequences:

- A `200` response always reports `expire_in_seconds >= 1`; `0` and negative
  values are never emitted.
- Client-supplied timestamps never affect `updated_at`, `expires_at`, ordering
  or expiry (defect 23).
- `expire_in_seconds` is informational. Clients must not treat it as an
  authorization or caching lifetime; the server re-evaluates expiry on every
  request.
- After a new write, the new record gets a fresh server `updated_at`, a fresh
  `expires_at`, a fresh ETag and a fresh 30-minute TTL. Old content is never
  resurrected.

## Read behaviour matrix

| Condition                                           | Response                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Valid token, live record                            | `200` with the full PRD §4.1.2 payload, ETag and `no-store`         |
| Valid token, record absent                          | `404` envelope above, `Cache-Control: no-store`, no ETag            |
| Valid token, record expired                         | `404` envelope above, identical to the absent case                  |
| Valid token, expired record + stale `If-None-Match` | `404` — expiry is evaluated before conditional headers; never `304` |
| Missing / invalid token, live or expired            | `401` — authentication is evaluated first                           |
| `?token=...` with a valid header                    | `400` — query-string tokens are forbidden (defect 21)               |
| `?token=...` without a header                       | `401` — the query value is never used for authentication            |
| Method other than `GET`                             | `405`                                                               |

The `404` body contains no `content`, `raw_text`, `parsed_code`, `source`,
`updated_at` or `expire_in_seconds` fields, and no `ETag` / `Last-Modified`
headers. Downstream pollers must treat it as "no current clipboard", not as a
transport error: do not write the system clipboard, do not notify, and do not
tight-loop retry. A stale persisted ETag remains harmless because the next
write produces a different `updated_at` and ETag.

## Physical deletion and retention scope

The 30-minute TTL applies only to the latest-record key (`clipboard:latest`).
Expired entries are removed lazily when read, by the maintenance sweep
(`CLIPBOARD_MAINTENANCE_INTERVAL_MS`, default 60 seconds) and by
`purgeExpired()`. Deletion of the latest key never deletes history or logs.

| Data                         | Key                 | TTL / retention                                                           | Exposed by public read API? |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------- | --------------------------- |
| Latest clipboard             | `clipboard:latest`  | `CLIPBOARD_TTL_MS` (default 30 min); expired reads return `404`           | Yes                         |
| Clipboard internal history   | `clipboard:history` | `CLIPBOARD_HISTORY_MAX_ENTRIES` (500) / `CLIPBOARD_HISTORY_TTL_MS` (24 h) | No                          |
| Collection logs / statistics | `collection:logs`   | `LOG_MAX_ENTRIES` (1000) / `LOG_MAX_AGE_MS` (7 days)                      | Admin log API only          |

Therefore:

- Clipboard TTL expiry **does not** delete collection logs or statistics. The
  accepted report, raw text, sender (masked per `MASK_SENDER`) and extracted
  code remain available to the admin log board and `/api/v1/stats` until the
  log retention policy trims them.
- Log retention **does not** extend the clipboard TTL; the public read API
  remains `404` after expiry regardless of how long logs are kept.
- The public read API never exposes the clipboard's internal history. There is
  no `GET /api/v1/clipboard/history` endpoint.

## Verification

`backend/test/clipboard-ttl-semantics.test.js` covers:

1. `200` immediately after write, `200` with `expire_in_seconds = 1` one
   millisecond before expiry, and `404` at the exact expiry boundary.
2. The `404` body is byte-for-byte the same as a never-written clipboard and
   contains no raw text, extracted code, ETag or `Last-Modified`.
3. A stale `If-None-Match` value on an expired record returns `404`, not `304`.
4. After TTL expiry and `purgeExpired()`, `/api/v1/logs` and `/api/v1/stats`
   still return the accepted report, while `clipboard:latest` is gone and
   `clipboard:history` still contains the record.

Related documents: [clipboard-api.md](clipboard-api.md),
[security.md](security.md), [pc-poll-sync.md](pc-poll-sync.md).
