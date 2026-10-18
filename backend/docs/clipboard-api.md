# Clipboard latest API (REQ-202610-1256)

`GET /api/v1/clipboard/latest` is the standard read endpoint for downstream
consumers (PC scripts, bots, desktop tools). It implements PRD §4.1.2 with the
security decisions from defects 21 and 24.

The normative TTL/expiry contract is
[clipboard-ttl-semantics.md](clipboard-ttl-semantics.md) (REQ-202610-1273).

## Authentication

Send the shared secret in the `X-DCC-Token` header:

```sh
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>'
```

- Header-only. Query-string authentication is not supported: a request that
  carries `?token=...` is never authenticated. With a valid header it is
  rejected with `400` and
  `Token must be sent in the X-DCC-Token header; query-string tokens are not supported.`;
  a query token alone receives the normal `401` (defect 21).
- Missing, empty, wrong, or oversized tokens receive `401` with the shared
  error envelope. When `API_SECRET_TOKEN` is not configured the endpoint fails
  closed.

## Success response (200)

```json
{
  "code": 200,
  "data": {
    "content": "839201",
    "type": "verification_code",
    "raw_text": "【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。",
    "source_device": "小米 13Pro",
    "platform": "android",
    "updated_at": 1728950400000,
    "expire_in_seconds": 1800
  }
}
```

| Field               | Type    | Meaning                                                                                                 |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `content`           | string  | Extracted code (`parsed_code`) when present; otherwise the raw text                                     |
| `type`              | string  | Stored data type: `verification_code` or `text`                                                         |
| `raw_text`          | string  | Original SMS/raw clipboard text                                                                         |
| `source_device`     | string  | Device name reported by the collector (`unknown` if absent)                                             |
| `platform`          | string  | `android` / `ios` (`unknown` if absent)                                                                 |
| `updated_at`        | integer | Server receive time (`received_at`) in epoch milliseconds (defect 23: client timestamps are never used) |
| `expire_in_seconds` | integer | Whole seconds remaining before the clipboard TTL elapses                                                |

The top-level shape intentionally matches the PRD §4.1.2 example: `code` plus
`data`, with no `message` on success.

`expire_in_seconds` is derived from the configured `CLIPBOARD_TTL_MS` (default
30 minutes per §8.2) and the server-assigned `updated_at`, not from a
client-provided timestamp. It is `ceil((updated_at + CLIPBOARD_TTL_MS - now) /
1000)`, so a `200` response always reports at least `1`; `0` is never returned.

## Ordering and multi-device conflicts (defect 23)

The clipboard store assigns `received_at` when the write commits and mirrors it
to `updated_at` for this API. The device-supplied `timestamp` is stored only as
`client_timestamp` on the internal clipboard record (and in the collection
log); it is never used for ordering, expiry, ETag or `Last-Modified`.

When several devices report at the same time, the policy is **last arrival
wins**:

- writes serialize through one atomic per-key update; the last committed write
  becomes the latest clipboard record;
- every accepted write gets a monotonically increasing server `seq`;
- every write is appended to history together with an `overwrote` snapshot
  (`clipboard_id`, `seq`, `received_at`) of the record it replaced.

Consequently a device with a slow clock cannot overwrite newer content by
sending an old timestamp, and a device with a fast clock cannot pin the
clipboard by sending a future timestamp. The only ordering input is server
arrival. The full contract and examples are in
[clipboard-ordering.md](clipboard-ordering.md).

## Errors and expiry semantics (defect 24 / REQ-202610-1273)

An absent clipboard and a TTL-expired clipboard are indistinguishable: both
return `404` with the shared error envelope. Expiry is inclusive — at exactly
`updated_at + CLIPBOARD_TTL_MS` the record is expired. The expiry check runs
before conditional-request handling, so a stale `If-None-Match` value on an
expired record returns `404`, never `304`. Expired data is never served, the
`404` response carries `Cache-Control: no-store` and no ETag/Last-Modified, and
the clipboard history is not exposed by this endpoint. See
[clipboard-ttl-semantics.md](clipboard-ttl-semantics.md) for the full contract
and the history/log retention boundary.

| Status | Condition                        | Body                                                                                                                        |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400    | `token` query parameter present  | `{"code":400,"message":"Token must be sent in the X-DCC-Token header; query-string tokens are not supported.","data":null}` |
| 401    | missing / invalid `X-DCC-Token`  | `{"code":401,"message":"Missing or invalid X-DCC-Token header.","data":null}`                                               |
| 403    | HTTPS required (`ENFORCE_HTTPS`) | `{"code":403,"message":"HTTPS is required.","data":null}`                                                                   |
| 404    | clipboard absent or TTL-expired  | `{"code":404,"message":"No clipboard data available.","data":null}`                                                         |
| 405    | method other than GET            | `{"code":405,"message":"Method not allowed.","data":null}`                                                                  |
| 500    | unexpected failure               | `{"code":500,"message":"Internal server error.","data":null}`                                                               |

## Polling without re-downloading unchanged data

Every `200` response includes:

- `ETag: "<updated_at_ms>-<clipboard_id>"` — opaque strong validator;
- `Last-Modified: <HTTP date derived from updated_at>`;
- `Cache-Control: no-store` — the clipboard is sensitive, so intermediaries
  must not store it.

Pollers should persist the `ETag` and send it back on the next request:

```sh
# First request: read and remember the ETag
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>'

# Subsequent polls: 304 Not Modified with an empty body when nothing changed
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' \
  -H 'If-None-Match: "<updated_at_ms>-<clipboard_id>"'
```

Supported conditional forms, in precedence order:

1. `If-None-Match` — accepts the full ETag, a quoted `updated_at` value, or a
   bare `updated_at` value; `*` matches any current record.
2. `If-Modified-Since` — accepts an HTTP date (or ISO-8601 timestamp); the
   comparison uses the one-second resolution of `Last-Modified`.
3. `?updated_after=<epoch-ms|ISO-8601>` — the simple polling form: returns
   `304` when the current record's `updated_at` is less than or equal to the
   supplied value.

A `304 Not Modified` response has no body and carries the current `ETag`,
`Last-Modified`, and `Cache-Control` headers. A changed clipboard returns
`200` with the full contract. If `If-None-Match` is present but does not match,
`If-Modified-Since` is ignored, per RFC 9110.

## curl example

```sh
curl -sS http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' | jq .
```
